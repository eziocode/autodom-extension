/**
 * AutoDOM — HAR recorder
 *
 * Builds a HAR 1.2 log for one tab from the CDP Network/Page events that
 * debug-capture.js receives, while the user or the agent works in the tab.
 *
 * Made for API testing: a recording can be split into named segments (one
 * per test case), and every entry carries `_autodom` with its segment and
 * the AutoDOM tool call that was running or had just finished when the
 * request started. The user's own clicks, typing and navigations (from the
 * workflow recorder) are attached as log._userActions, and each entry names
 * the one that most likely triggered it (entry._triggeredBy).
 *
 * Headers and cookies are the ones that went over the wire (ExtraInfo
 * events), not only those the page set. By default secrets are redacted:
 * Authorization/Cookie/Set-Cookie and similar headers, sensitive query
 * parameters, and sensitive fields in urlencoded/JSON request and response
 * bodies; callers can add header and body-key names. includeSensitive:true
 * keeps everything.
 *
 * Exposed as globalThis.AutoDOMHar; the service worker passes in the
 * capture module and a CDP sender via init().
 */
(function () {
  const MAX_ENTRIES = 5000;
  const MAX_POST_DATA = 65536;
  const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
  const DEFAULT_TOTAL_BODY_BYTES = 20 * 1024 * 1024;
  // An encoded (compressed) body this many times over the limit is not
  // fetched at all; smaller ones are fetched and truncated.
  const FETCH_OVER_LIMIT_FACTOR = 4;
  // An action is credited with requests that start within this window.
  const TRIGGER_WINDOW_MS = 3000;
  const API_TYPES = new Set(["XHR", "Fetch", "EventSource"]);

  const SENSITIVE_HEADERS = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
  ];
  const SENSITIVE_KEY = /pass(word)?|otp|pin$/i;
  const TEXT_MIME = /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|graphql|ld\+json|manifest\+json)|[^;]*\+(json|xml))/i;

  const _sessions = new Map(); // tabId → session
  let _deps = null;

  function init(deps) {
    if (_deps) return;
    _deps = deps;
    deps.capture.addObserver(_onEvent);
    // A test that closes its tab still gets its HAR from har_stop.
    chrome.tabs?.onRemoved?.addListener((tabId) => {
      const s = _sessions.get(tabId);
      if (s) s.closed = true;
    });
  }

  // Recording and the tab is still open.
  function isActive(tabId) {
    const s = _sessions.get(tabId);
    return !!s && !s.closed;
  }

  // Tab ids with a recording, open or closed.
  function recordingTabs() {
    return [..._sessions.keys()];
  }

  // "*" globs, "/regex/flags", or a plain substring, matched anywhere in
  // the URL: "/api/leads/*" matches "https://crm.test/api/leads/7".
  function _matcher(pattern) {
    const p = String(pattern || "");
    const re = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (re) {
      try {
        const rx = new RegExp(re[1], re[2]);
        return (url) => rx.test(url);
      } catch (_) {}
    }
    if (p.includes("*")) {
      const rx = new RegExp(p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
      return (url) => rx.test(url);
    }
    return (url) => url.includes(p);
  }

  function _options(opts) {
    const f = opts.filter || {};
    const lower = (list) => new Set((Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase()));
    return {
      includeBodies: opts.includeBodies !== false,
      includeSensitive: opts.includeSensitive === true,
      maxBodyBytes: Number(opts.maxBodyBytes) > 0 ? Number(opts.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES,
      filter: {
        apiOnly: f.apiOnly === true || opts.apiOnly === true,
        include: (f.urlInclude || []).map(_matcher),
        exclude: (f.urlExclude || []).map(_matcher),
        methods: new Set((f.methods || []).map((m) => String(m).toUpperCase())),
      },
      redactHeaders: new Set([...SENSITIVE_HEADERS, ...lower(opts.redact?.headers)]),
      redactKeys: lower(opts.redact?.bodyKeys),
    };
  }

  function _segment(s, label) {
    const seg = { index: s.segments.length, label: label == null ? "" : String(label).slice(0, 200), startedMs: Date.now() };
    s.segments.push(seg);
    return seg;
  }

  async function start(tabId, opts = {}) {
    if (!_deps) throw new Error("HAR recorder not initialised");
    const running = _sessions.get(tabId);
    if (running) {
      // A new label while recording starts the next segment (test case).
      if (opts.label == null) return { alreadyRunning: true, ..._counts(running) };
      const closed = _segmentSummary(running, running.segments[running.segments.length - 1]);
      const seg = _segment(running, opts.label);
      return { segment: { index: seg.index, label: seg.label }, closedSegment: closed };
    }
    const s = {
      startedAt: Date.now(),
      opts: _options(opts),
      mainFrameId: null,
      pages: [],
      pageByLoader: new Map(),
      currentPage: null,
      live: new Map(), // requestId → entry in progress
      byRequest: new Map(), // requestId → latest entry (live or finished)
      extra: new Map(), // requestId → ExtraInfo that arrived before its entry
      entries: [],
      seq: 0,
      dropped: 0,
      skipped: 0,
      redactions: 0,
      bodyBytes: 0,
      pendingBodies: new Set(),
      segments: [],
      steps: [],
      waiters: new Set(),
      closed: false,
    };
    _segment(s, opts.label);
    _sessions.set(tabId, s);
    const send = (m, p) => _deps.sendCommand(tabId, m, p);
    try {
      // Re-enable so request bodies are delivered (capture starts with 0).
      await send("Network.enable", { maxPostDataSize: MAX_POST_DATA });
      await send("Page.enable");
      const tree = await send("Page.getFrameTree");
      s.mainFrameId = tree?.frameTree?.frame?.id || null;
      const f = tree?.frameTree?.frame;
      if (f?.url && /^https?:/.test(f.url)) _openPage(s, f.url, Date.now(), null);
    } catch (err) {
      _sessions.delete(tabId);
      throw err;
    }
    return { started: true, segment: { index: 0, label: s.segments[0].label } };
  }

  // ─── AutoDOM tool calls ────────────────────────────────────
  // The service worker reports each page-changing tool call; requests that
  // start while it runs, or within TRIGGER_WINDOW_MS after, are credited to it.
  function noteAction(tabId, { callId, tool, target } = {}) {
    const s = _sessions.get(tabId);
    if (!s) return null;
    const step = {
      step: s.steps.length + 1,
      segment: s.segments.length - 1,
      tool: String(tool || ""),
      ...(callId != null && { callId: String(callId) }),
      ...(target && { target: String(target).slice(0, 200) }),
      startedMs: Date.now(),
      endedMs: null,
      requests: 0,
    };
    s.steps.push(step);
    return step.step;
  }

  function endAction(tabId, stepNo) {
    const st = _sessions.get(tabId)?.steps[stepNo - 1];
    if (st && st.endedMs == null) st.endedMs = Date.now();
  }

  function _stepFor(s, startMs) {
    for (let i = s.steps.length - 1; i >= 0; i--) {
      const st = s.steps[i];
      if (st.startedMs > startMs) continue;
      if (st.endedMs == null || startMs <= st.endedMs) return { st, phase: "during" };
      return startMs - st.endedMs <= TRIGGER_WINDOW_MS ? { st, phase: "after" } : null;
    }
    return null;
  }

  function _openPage(s, url, wallMs, ts) {
    const page = {
      id: `page_${s.pages.length + 1}`,
      title: url,
      startedDateTime: new Date(wallMs).toISOString(),
      pageTimings: { onContentLoad: -1, onLoad: -1 },
      _ts: ts,
    };
    s.pages.push(page);
    s.currentPage = page;
    return page;
  }

  // CDP joins repeated headers (Set-Cookie) with "\n".
  function _headers(obj) {
    const out = [];
    for (const [name, value] of Object.entries(obj || {})) {
      for (const v of String(value).split("\n")) out.push({ name, value: v });
    }
    return out;
  }

  function _redactHeaders(s, list) {
    if (s.opts.includeSensitive) return list;
    return list.map((h) => {
      if (!s.opts.redactHeaders.has(h.name.toLowerCase())) return h;
      s.redactions += 1;
      return { name: h.name, value: "REDACTED" };
    });
  }

  function _sensitiveKey(s, k) {
    return _deps.capture.isSensitiveName(k) || SENSITIVE_KEY.test(k) || s.opts.redactKeys.has(String(k).toLowerCase());
  }

  function _requestCookies(s, headerValue, associated) {
    let list = [];
    if (Array.isArray(associated) && associated.length) {
      list = associated.filter((c) => !c.blockedReasons?.length && c.cookie).map((c) => ({ name: c.cookie.name, value: c.cookie.value }));
    } else if (headerValue) {
      list = String(headerValue)
        .split(/;\s*/)
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf("=");
          return i < 0 ? { name: p, value: "" } : { name: p.slice(0, i), value: p.slice(i + 1) };
        });
    }
    return s.opts.includeSensitive ? list : list.map((c) => ({ name: c.name, value: "REDACTED" }));
  }

  function _responseCookies(s, headers) {
    return headers
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => {
        const [pair, ...attrs] = String(h.value).split(/;\s*/);
        const i = pair.indexOf("=");
        const c = { name: i < 0 ? pair : pair.slice(0, i), value: i < 0 ? "" : pair.slice(i + 1) };
        for (const a of attrs) {
          const [k, v] = a.split("=");
          const key = k.toLowerCase();
          if (key === "path") c.path = v;
          else if (key === "domain") c.domain = v;
          else if (key === "expires") c.expires = v;
          else if (key === "httponly") c.httpOnly = true;
          else if (key === "secure") c.secure = true;
        }
        return c;
      });
  }

  function _url(s, url) {
    return s.opts.includeSensitive ? url : _deps.capture.redactUrl(url);
  }

  function _queryString(url) {
    try {
      return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
    } catch (_) {
      return [];
    }
  }

  function _redactJson(s, value) {
    if (Array.isArray(value)) return value.map((v) => _redactJson(s, v));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (_sensitiveKey(s, k) && (v == null || typeof v !== "object")) {
          s.redactions += 1;
          out[k] = "REDACTED";
        } else {
          out[k] = _redactJson(s, v);
        }
      }
      return out;
    }
    return value;
  }

  function _redactBodyText(s, mimeType, text) {
    if (s.opts.includeSensitive || !text) return text;
    if (/json/i.test(mimeType)) {
      try {
        return JSON.stringify(_redactJson(s, JSON.parse(text)));
      } catch (_) {}
    }
    return text;
  }

  function _postData(s, req) {
    const text = req.postData;
    if (text == null && !req.hasPostData) return undefined;
    const headers = req.headers || {};
    const mimeType = headers["Content-Type"] || headers["content-type"] || "";
    if (text == null) return { mimeType, text: "", comment: "Body not delivered by the browser (too large or binary)." };
    if (s.opts.includeSensitive) return { mimeType, text };
    if (/x-www-form-urlencoded/i.test(mimeType)) {
      const params = new URLSearchParams(text);
      for (const key of [...params.keys()]) {
        if (_sensitiveKey(s, key)) {
          s.redactions += 1;
          params.set(key, "REDACTED");
        }
      }
      return { mimeType, text: params.toString(), params: [...params].map(([name, value]) => ({ name, value })) };
    }
    return { mimeType, text: _redactBodyText(s, mimeType, text) };
  }

  function _kept(s, params) {
    const f = s.opts.filter;
    const url = params.request?.url || "";
    if (f.apiOnly && !API_TYPES.has(params.type)) return false;
    if (f.methods.size && !f.methods.has(String(params.request?.method || "GET").toUpperCase())) return false;
    if (f.include.length && !f.include.some((m) => m(url))) return false;
    if (f.exclude.some((m) => m(url))) return false;
    return true;
  }

  function _newEntry(s, params) {
    const req = params.request || {};
    const startedMs = params.wallTime ? params.wallTime * 1000 : Date.now();
    if (params.type === "Document" && params.frameId && params.frameId === s.mainFrameId) {
      _openPage(s, req.url, startedMs, params.timestamp);
      s.pageByLoader.set(params.loaderId, s.currentPage);
    }
    if (!_kept(s, params)) {
      s.skipped += 1;
      return null;
    }
    const page = s.pageByLoader.get(params.loaderId) || s.currentPage;
    const url = _url(s, req.url || "");
    const postData = _postData(s, req);
    const headers = _headers(req.headers);
    const cookieHeader = headers.find((h) => h.name.toLowerCase() === "cookie")?.value;
    const linked = _stepFor(s, startedMs);
    if (linked) linked.st.requests += 1;
    return {
      ...(page && { pageref: page.id }),
      startedDateTime: new Date(startedMs).toISOString(),
      time: 0,
      request: {
        method: req.method || "GET",
        url,
        httpVersion: "",
        cookies: _requestCookies(s, cookieHeader),
        headers: _redactHeaders(s, headers),
        queryString: _queryString(url),
        ...(postData && { postData }),
        headersSize: -1,
        bodySize: req.postData ? req.postData.length : 0,
      },
      response: null,
      cache: {},
      timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 0, receive: 0, ssl: -1 },
      _resourceType: params.type || "Other",
      _initiator: params.initiator?.type,
      _autodom: {
        seq: ++s.seq,
        segment: s.segments.length - 1,
        ...(linked && {
          step: linked.st.step,
          tool: linked.st.tool,
          ...(linked.st.callId && { callId: linked.st.callId }),
          phase: linked.phase,
          sinceActionMs: Math.max(0, Math.round(startedMs - linked.st.startedMs)),
        }),
      },
      _ts: params.timestamp,
      _startMs: startedMs,
    };
  }

  function _response(s, r, encodedDataLength) {
    const headers = _headers(r.headers);
    return {
      status: r.status ?? 0,
      statusText: r.statusText || "",
      httpVersion: r.protocol || "",
      cookies: _redactCookieValues(s, _responseCookies(s, headers)),
      headers: _redactHeaders(s, headers),
      content: { size: encodedDataLength ?? -1, mimeType: r.mimeType || "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: encodedDataLength ?? -1,
    };
  }

  function _redactCookieValues(s, list) {
    return s.opts.includeSensitive ? list : list.map((c) => ({ ...c, value: "REDACTED" }));
  }

  // Wire headers and cookies replace what the page set (no Cookie header,
  // no Set-Cookie on cross-site responses).
  function _applyExtra(s, e, extra) {
    if (extra.request) {
      const headers = _headers(extra.request.headers);
      const cookieHeader = headers.find((h) => h.name.toLowerCase() === "cookie")?.value;
      e.request.headers = _redactHeaders(s, headers);
      e.request.cookies = _requestCookies(s, cookieHeader, extra.request.associatedCookies);
    }
    if (extra.response && e.response) {
      const headers = _headers(extra.response.headers);
      e.response.headers = _redactHeaders(s, headers);
      e.response.cookies = _redactCookieValues(s, _responseCookies(s, headers));
      if (extra.response.headersText) e.response.headersSize = extra.response.headersText.length;
    }
  }

  function _extraFor(s, requestId, kind, value) {
    const e = s.byRequest.get(requestId);
    if (e && (kind === "request" || e.response)) {
      _applyExtra(s, e, { [kind]: value });
      return;
    }
    const pending = s.extra.get(requestId) || {};
    pending[kind] = value;
    s.extra.set(requestId, pending);
  }

  function _timings(entry, timing, endTs) {
    const totalMs = entry._ts != null && endTs != null ? Math.max(0, (endTs - entry._ts) * 1000) : 0;
    if (!timing) {
      entry.timings = { blocked: -1, dns: -1, connect: -1, send: 0, wait: totalMs, receive: 0, ssl: -1 };
      entry.time = totalMs;
      return;
    }
    const span = (a, b) => (a >= 0 && b >= 0 ? Math.max(0, b - a) : -1);
    const firstStart = [timing.dnsStart, timing.connectStart, timing.sendStart].find((v) => v >= 0) ?? 0;
    const queued = entry._ts != null ? Math.max(0, (timing.requestTime - entry._ts) * 1000) : 0;
    const t = {
      blocked: queued + Math.max(0, firstStart),
      dns: span(timing.dnsStart, timing.dnsEnd),
      connect: span(timing.connectStart, timing.connectEnd),
      ssl: span(timing.sslStart, timing.sslEnd),
      send: Math.max(0, span(timing.sendStart, timing.sendEnd)),
      wait: Math.max(0, span(timing.sendEnd, timing.receiveHeadersEnd)),
      receive: endTs != null ? Math.max(0, (endTs - timing.requestTime) * 1000 - timing.receiveHeadersEnd) : 0,
    };
    for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 1000) / 1000;
    entry.timings = t;
    entry.time = Math.round((t.blocked + Math.max(0, t.dns) + Math.max(0, t.connect) + t.send + t.wait + t.receive) * 1000) / 1000;
  }

  function _finish(s, requestId, entry) {
    s.live.delete(requestId);
    if (s.entries.length >= MAX_ENTRIES) {
      s.dropped += 1;
      return;
    }
    s.entries.push(entry);
    for (const w of [...s.waiters]) w(entry);
  }

  function _fetchBody(s, tabId, requestId, entry) {
    const mime = entry.response?.content?.mimeType || "";
    const size = entry.response?.content?.size ?? 0;
    if (!s.opts.includeBodies || !TEXT_MIME.test(mime)) return;
    if (size > s.opts.maxBodyBytes * FETCH_OVER_LIMIT_FACTOR || s.bodyBytes >= DEFAULT_TOTAL_BODY_BYTES) {
      entry.response.content.comment = "Body not saved (over the size limit).";
      return;
    }
    const p = _deps
      .sendCommand(tabId, "Network.getResponseBody", { requestId })
      .then((res) => {
        if (!res) return;
        let text = res.body || "";
        if (res.base64Encoded) {
          entry.response.content.encoding = "base64";
        } else {
          text = _redactBodyText(s, mime, text);
        }
        if (text.length > s.opts.maxBodyBytes) {
          text = text.slice(0, s.opts.maxBodyBytes);
          entry.response.content.comment = `Body truncated to ${s.opts.maxBodyBytes} characters.`;
          entry._autodom.truncated = true;
        }
        s.bodyBytes += text.length;
        entry.response.content.text = text;
      })
      .catch(() => {
        entry.response.content.comment = "Body no longer available from the browser.";
      })
      .finally(() => {
        s.pendingBodies.delete(p);
        delete entry._body;
      });
    s.pendingBodies.add(p);
    entry._body = p;
  }

  function _onEvent(tabId, method, params) {
    const s = _sessions.get(tabId);
    if (!s) return;
    switch (method) {
      case "Network.requestWillBeSent": {
        const prev = s.live.get(params.requestId);
        if (prev && params.redirectResponse) {
          prev.response = _response(s, params.redirectResponse, 0);
          prev.response.redirectURL = _url(s, params.request?.url || "");
          _timings(prev, params.redirectResponse.timing, params.timestamp);
          _finish(s, params.requestId, prev);
        }
        const e = _newEntry(s, params);
        if (!e) break;
        s.live.set(params.requestId, e);
        s.byRequest.set(params.requestId, e);
        const pending = s.extra.get(params.requestId);
        if (pending?.request) {
          _applyExtra(s, e, { request: pending.request });
          delete pending.request;
        }
        break;
      }
      case "Network.requestWillBeSentExtraInfo":
        _extraFor(s, params.requestId, "request", params);
        break;
      case "Network.responseReceivedExtraInfo":
        _extraFor(s, params.requestId, "response", params);
        break;
      case "Network.responseReceived": {
        const e = s.live.get(params.requestId);
        if (!e) break;
        e.response = _response(s, params.response, null);
        e._timing = params.response?.timing;
        if (params.response?.remoteIPAddress) e.serverIPAddress = params.response.remoteIPAddress;
        if (params.response?.fromDiskCache) e.cache = { beforeRequest: null, comment: "from disk cache" };
        const pending = s.extra.get(params.requestId);
        if (pending?.response) {
          _applyExtra(s, e, { response: pending.response });
          s.extra.delete(params.requestId);
        }
        break;
      }
      case "Network.loadingFinished": {
        const e = s.live.get(params.requestId);
        if (!e) break;
        if (!e.response) e.response = _response(s, {}, params.encodedDataLength);
        e.response.content.size = params.encodedDataLength;
        e.response.bodySize = params.encodedDataLength;
        _timings(e, e._timing, params.timestamp);
        _fetchBody(s, tabId, params.requestId, e);
        _finish(s, params.requestId, e);
        break;
      }
      case "Network.loadingFailed": {
        const e = s.live.get(params.requestId);
        if (!e) break;
        if (!e.response) e.response = _response(s, { status: 0, statusText: "" }, 0);
        e._error = params.blockedReason || params.corsErrorStatus?.corsError || params.errorText || "failed";
        if (params.canceled) e._canceled = true;
        _timings(e, e._timing, params.timestamp);
        _finish(s, params.requestId, e);
        break;
      }
      case "Page.domContentEventFired":
      case "Page.loadEventFired": {
        const page = s.currentPage;
        if (!page || page._ts == null) break;
        const ms = Math.round((params.timestamp - page._ts) * 1000);
        if (method === "Page.loadEventFired") page.pageTimings.onLoad = ms;
        else page.pageTimings.onContentLoad = ms;
        break;
      }
      case "Page.frameNavigated": {
        if (params.frame && !params.frame.parentId && s.currentPage && params.frame.url) {
          s.currentPage.title = _url(s, params.frame.url);
        }
        break;
      }
      default:
        break;
    }
  }

  function _counts(s) {
    return {
      entries: s.entries.length,
      inFlight: s.live.size,
      pages: s.pages.length,
      dropped: s.dropped,
      ...(s.skipped && { filteredOut: s.skipped }),
      redactions: s.redactions,
      durationMs: Date.now() - s.startedAt,
      ...(s.closed && { tabClosed: true }),
    };
  }

  function _segmentSummary(s, seg) {
    const entries = s.entries.filter((e) => e._autodom.segment === seg.index);
    const failed = entries.filter((e) => e._error || (e.response?.status || 0) >= 400).length;
    return { index: seg.index, label: seg.label, entries: entries.length, failed };
  }

  function status(tabId) {
    const s = _sessions.get(tabId);
    if (!s) return null;
    const recent = s.entries.slice(-10).map((e) => ({
      method: e.request.method,
      url: e.request.url,
      status: e.response?.status ?? null,
      type: e._resourceType,
    }));
    return { ..._counts(s), segments: s.segments.map((seg) => _segmentSummary(s, seg)), steps: s.steps.length, recent };
  }

  // ─── Queries for API assertions ────────────────────────────
  // Type skeleton of a JSON value: {"id":"number","items":[{"name":"string"}]}.
  function _shape(value, depth = 0) {
    if (value === null) return "null";
    if (Array.isArray(value)) return depth >= 4 ? "array" : value.length ? [_shape(value[0], depth + 1)] : [];
    if (typeof value === "object") {
      if (depth >= 4) return "object";
      const out = {};
      for (const k of Object.keys(value).slice(0, 40)) out[k] = _shape(value[k], depth + 1);
      return out;
    }
    return typeof value;
  }

  function _json(text) {
    if (typeof text !== "string" || !text) return undefined;
    try {
      return JSON.parse(text);
    } catch (_) {
      return undefined;
    }
  }

  // "data.items[0].id" → value.
  function _pick(value, path) {
    let cur = value;
    for (const part of String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function _statusMatches(e, want) {
    if (want == null || want === "") return true;
    const code = e.response?.status ?? 0;
    if (want === "failed") return !!e._error;
    if (typeof want === "string" && /^[1-5]xx$/i.test(want)) return Math.floor(code / 100) === Number(want[0]);
    return code === Number(want);
  }

  function _filterFn(q = {}) {
    const url = q.urlPattern ? _matcher(q.urlPattern) : null;
    const method = q.method ? String(q.method).toUpperCase() : null;
    return (e) =>
      (!url || url(e.request.url)) &&
      (!method || e.request.method === method) &&
      _statusMatches(e, q.status) &&
      (!q.resourceType || e._resourceType === q.resourceType) &&
      (q.segment == null || e._autodom.segment === Number(q.segment)) &&
      (q.sinceMs == null || e._startMs >= q.sinceMs);
  }

  // One compact row per request; `detail` adds headers and a body excerpt.
  function row(e, { shape = true, detail = false, maxBodyChars = 2000, jsonPath } = {}) {
    const reqText = e.request.postData?.text;
    const resText = e.response?.content?.encoding ? undefined : e.response?.content?.text;
    const reqJson = _json(reqText);
    const resJson = _json(resText);
    const out = {
      seq: e._autodom.seq,
      method: e.request.method,
      url: e.request.url,
      status: e.response?.status ?? null,
      ...(e._error && { error: e._error }),
      ...(e._incomplete && { incomplete: true }),
      durationMs: Math.round(e.time),
      type: e._resourceType,
      reqBytes: e.request.bodySize,
      resBytes: e.response?.content?.size ?? -1,
      mimeType: e.response?.content?.mimeType || "",
      segment: e._autodom.segment,
      ...(e._autodom.step && { step: e._autodom.step, tool: e._autodom.tool, phase: e._autodom.phase }),
    };
    if (shape && reqJson !== undefined) out.requestShape = _shape(reqJson);
    if (shape && resJson !== undefined) out.responseShape = _shape(resJson);
    if (jsonPath && resJson !== undefined) out.picked = _pick(resJson, jsonPath);
    if (detail) {
      out.requestHeaders = e.request.headers;
      out.responseHeaders = e.response?.headers || [];
      if (reqText) out.requestBody = String(reqText).slice(0, maxBodyChars);
      if (resText) out.responseBody = String(resText).slice(0, maxBodyChars);
      if (e.response?.content?.comment) out.bodyNote = e.response.content.comment;
    }
    return out;
  }

  function query(tabId, q = {}) {
    const s = _sessions.get(tabId);
    if (!s) return null;
    if (q.seq != null) {
      const e = s.entries.find((x) => x._autodom.seq === Number(q.seq));
      return { rows: e ? [row(e, { ...q, detail: true })] : [], total: e ? 1 : 0 };
    }
    const match = _filterFn(q);
    const hits = s.entries.filter(match);
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 30));
    return { rows: hits.slice(-limit).map((e) => row(e, q)), total: hits.length };
  }

  // When the latest AutoDOM action started (or the segment, or now).
  function sinceMs(tabId, since) {
    const s = _sessions.get(tabId);
    if (!s) return Date.now();
    if (typeof since === "number") return since;
    if (since === "now") return Date.now();
    if (since === "segment") return s.segments[s.segments.length - 1].startedMs;
    const last = s.steps[s.steps.length - 1];
    return last ? last.startedMs : s.segments[s.segments.length - 1].startedMs;
  }

  // Resolves with the first `count` finished requests matching `q` that
  // started at or after q.sinceMs, waiting up to timeoutMs for them.
  function waitFor(tabId, q, { count = 1, timeoutMs = 15000, signal } = {}) {
    const s = _sessions.get(tabId);
    if (!s) return Promise.resolve(null);
    const match = _filterFn(q);
    const found = s.entries.filter(match);
    if (found.length >= count) return Promise.resolve({ matched: true, entries: found.slice(0, count) });
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        s.waiters.delete(onEntry);
        signal?.removeEventListener?.("abort", onAbort);
        resolve(value);
      };
      const onEntry = (e) => {
        if (e === null) return done({ matched: false, stopped: true, entries: found });
        if (!match(e)) return;
        found.push(e);
        if (found.length >= count) done({ matched: true, entries: found.slice(0, count) });
      };
      const onAbort = () => done({ matched: false, cancelled: true, entries: found });
      const timer = setTimeout(() => done({ matched: false, entries: found }), Math.max(0, timeoutMs));
      s.waiters.add(onEntry);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  // Requests since `sinceMs` that share the pattern's path but differ in
  // method or status, else the latest API calls: what the caller may have
  // meant when nothing matched.
  function nearMisses(tabId, q) {
    const s = _sessions.get(tabId);
    if (!s) return [];
    const since = s.entries.filter((e) => q.sinceMs == null || e._startMs >= q.sinceMs);
    const url = q.urlPattern ? _matcher(q.urlPattern) : null;
    let list = url ? since.filter((e) => url(e.request.url)) : [];
    if (!list.length) list = since.filter((e) => API_TYPES.has(e._resourceType));
    return list.slice(-5).map((e) => row(e, { shape: false }));
  }

  async function bodyOf(entry, waitMs = 2000) {
    if (entry._body) {
      let timer;
      await Promise.race([entry._body, new Promise((r) => (timer = setTimeout(r, waitMs)))]);
      clearTimeout(timer);
    }
    return entry;
  }

  // Credit each entry to the latest user action that started at most
  // TRIGGER_WINDOW_MS before it, and count the requests per action.
  function _linkActions(entries, actions) {
    const list = actions.map((a, i) => ({
      index: i,
      action: a.action,
      ...(a.locator && { target: _describeLocator(a.locator) }),
      ...(a.value !== undefined && a.value !== "" && { value: String(a.value).slice(0, 200) }),
      ...(a.secret && { secret: true }),
      ...(a.key && { key: a.key }),
      ...(a.action === "navigate" && a.url && { url: a.url }),
      ...(a.implied && { implied: true }),
      pageUrl: a.url,
      time: new Date(a.t).toISOString(),
      _t: a.t,
      requests: 0,
    }));
    let j = -1;
    const sorted = [...entries].sort((a, b) => a._startMs - b._startMs);
    for (const e of sorted) {
      while (j + 1 < list.length && list[j + 1]._t <= e._startMs) j += 1;
      if (j >= 0 && e._startMs - list[j]._t <= TRIGGER_WINDOW_MS) {
        e._triggeredBy = j;
        list[j].requests += 1;
      }
    }
    return list.map(({ _t, ...a }) => a);
  }

  // e.g. 'button "Sign in" (form > button.primary)' from a recorder locator.
  function _describeLocator(loc) {
    const parts = [];
    parts.push(loc.role || loc.tag || "element");
    const label = loc.accessibleName || loc.label || loc.text || loc.placeholder;
    if (label) parts.push(JSON.stringify(String(label).slice(0, 80)));
    if (loc.css) parts.push(`(${loc.css})`);
    return parts.join(" ");
  }

  // Ends the session and returns { har, summary }. actions: steps from the
  // workflow recorder ({ action, locator, value, url, t }).
  async function stop(tabId, { actions = [], creator, browser, waitForBodiesMs = 3000 } = {}) {
    const s = _sessions.get(tabId);
    if (!s) return null;
    _sessions.delete(tabId);
    // null tells waiters that the recording ended.
    for (const w of [...s.waiters]) w(null);
    if (s.pendingBodies.size) {
      let timer;
      await Promise.race([
        Promise.allSettled([...s.pendingBodies]),
        new Promise((r) => (timer = setTimeout(r, waitForBodiesMs))),
      ]);
      clearTimeout(timer);
    }
    // Requests still open at stop are kept, marked incomplete.
    for (const [, e] of s.live) {
      if (!e.response) e.response = _response(s, { status: 0, statusText: "" }, -1);
      e._incomplete = true;
      if (s.entries.length < MAX_ENTRIES) s.entries.push(e);
      else s.dropped += 1;
    }
    s.entries.sort((a, b) => a._startMs - b._startMs);
    const userActions = _linkActions(
      s.entries,
      (actions || []).filter((a) => a && a.t >= s.startedAt - 1000).sort((a, b) => a.t - b.t),
    );
    const segments = s.segments.map((seg) => ({
      ..._segmentSummary(s, seg),
      startedDateTime: new Date(seg.startedMs).toISOString(),
    }));
    const steps = s.steps.map(({ startedMs, endedMs, ...st }) => ({
      ...st,
      startedDateTime: new Date(startedMs).toISOString(),
      ...(endedMs != null && { durationMs: endedMs - startedMs }),
    }));
    const entries = s.entries.map(({ _ts, _startMs, _timing, _body, ...e }) => e);
    const har = {
      log: {
        version: "1.2",
        creator: creator || { name: "AutoDOM", version: "" },
        ...(browser && { browser }),
        pages: s.pages.map(({ _ts, ...p }) => p),
        entries,
        comment:
          "Recorded by AutoDOM over the DevTools protocol." +
          (s.opts.includeSensitive ? "" : " Credentials, cookies and sensitive parameters are REDACTED."),
        _userActions: userActions,
        _autodom: { segments, steps },
        ...(s.dropped && { _droppedEntries: s.dropped }),
      },
    };
    const byStatus = {};
    for (const e of entries) {
      const k = e._error ? "failed" : String(e.response?.status ?? "none");
      byStatus[k] = (byStatus[k] || 0) + 1;
    }
    return {
      har,
      summary: {
        entries: entries.length,
        pages: s.pages.length,
        segments,
        steps: steps.length,
        userActions: userActions.length,
        byStatus,
        dropped: s.dropped,
        ...(s.skipped && { filteredOut: s.skipped }),
        redactions: s.redactions,
        truncatedBodies: entries.filter((e) => e._autodom.truncated).length,
        durationMs: Date.now() - s.startedAt,
        bodiesSavedBytes: s.bodyBytes,
        actions: userActions.map((a) => ({ index: a.index, action: a.action, target: a.target, requests: a.requests })),
      },
    };
  }

  globalThis.AutoDOMHar = {
    init,
    start,
    stop,
    status,
    isActive,
    recordingTabs,
    noteAction,
    endAction,
    query,
    row,
    sinceMs,
    waitFor,
    nearMisses,
    bodyOf,
    _onEvent,
    _sessions,
  };
})();
