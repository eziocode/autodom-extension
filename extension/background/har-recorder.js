/**
 * AutoDOM — HAR recorder
 *
 * Builds a HAR 1.2 log for one tab from the CDP Network/Page events that
 * debug-capture.js receives, while the user (or the agent) works in the tab.
 * The user's own clicks, typing and navigations — captured by the workflow
 * recorder — are attached as log._userActions, and each entry names the
 * action that most likely triggered it (entry._triggeredBy).
 *
 * By default secrets are redacted: Authorization/Cookie/Set-Cookie and
 * similar headers, sensitive query parameters, and sensitive fields in
 * urlencoded/JSON request bodies. includeSensitive:true keeps them.
 *
 * Exposed as globalThis.AutoDOMHar; the service worker passes in the
 * capture module and a CDP sender via init().
 */
(function () {
  const MAX_ENTRIES = 5000;
  const MAX_POST_DATA = 65536;
  const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
  const DEFAULT_TOTAL_BODY_BYTES = 20 * 1024 * 1024;
  // An action is credited with requests that start within this window.
  const TRIGGER_WINDOW_MS = 3000;

  const SENSITIVE_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
  ]);
  const TEXT_MIME = /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|graphql|ld\+json|manifest\+json)|[^;]*\+(json|xml))/i;

  const _sessions = new Map(); // tabId → session
  let _deps = null;

  function init(deps) {
    if (_deps) return;
    _deps = deps;
    deps.capture.addObserver(_onEvent);
    chrome.tabs?.onRemoved?.addListener((tabId) => _sessions.delete(tabId));
  }

  function isActive(tabId) {
    return _sessions.has(tabId);
  }

  async function start(tabId, opts = {}) {
    if (!_deps) throw new Error("HAR recorder not initialised");
    if (_sessions.has(tabId)) return { alreadyRunning: true, ..._counts(_sessions.get(tabId)) };
    const s = {
      startedAt: Date.now(),
      opts: {
        includeBodies: opts.includeBodies !== false,
        includeSensitive: opts.includeSensitive === true,
        maxBodyBytes: Number(opts.maxBodyBytes) > 0 ? Number(opts.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES,
      },
      mainFrameId: null,
      pages: [],
      pageByLoader: new Map(),
      currentPage: null,
      live: new Map(), // requestId → entry in progress
      entries: [],
      dropped: 0,
      bodyBytes: 0,
      pendingBodies: new Set(),
    };
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
    return { started: true };
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

  function _headers(obj) {
    return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
  }

  function _redactHeaders(list, keep) {
    if (keep) return list;
    return list.map((h) => (SENSITIVE_HEADERS.has(h.name.toLowerCase()) ? { name: h.name, value: "REDACTED" } : h));
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

  function _redactJson(value) {
    if (Array.isArray(value)) return value.map(_redactJson);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = _deps.capture.isSensitiveName(k) || /pass(word)?|otp|pin$/i.test(k) ? "REDACTED" : _redactJson(v);
      }
      return out;
    }
    return value;
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
        if (_deps.capture.isSensitiveName(key) || /pass(word)?|otp|pin$/i.test(key)) params.set(key, "REDACTED");
      }
      return { mimeType, text: params.toString(), params: [...params].map(([name, value]) => ({ name, value })) };
    }
    if (/json/i.test(mimeType)) {
      try {
        return { mimeType, text: JSON.stringify(_redactJson(JSON.parse(text))) };
      } catch (_) {}
    }
    return { mimeType, text };
  }

  function _newEntry(s, params) {
    const req = params.request || {};
    const startedMs = params.wallTime ? params.wallTime * 1000 : Date.now();
    if (params.type === "Document" && params.frameId && params.frameId === s.mainFrameId) {
      _openPage(s, req.url, startedMs, params.timestamp);
      s.pageByLoader.set(params.loaderId, s.currentPage);
    }
    const page = s.pageByLoader.get(params.loaderId) || s.currentPage;
    const url = _url(s, req.url || "");
    const postData = _postData(s, req);
    return {
      ...(page && { pageref: page.id }),
      startedDateTime: new Date(startedMs).toISOString(),
      time: 0,
      request: {
        method: req.method || "GET",
        url,
        httpVersion: "",
        cookies: [],
        headers: _redactHeaders(_headers(req.headers), s.opts.includeSensitive),
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
      _ts: params.timestamp,
      _startMs: startedMs,
    };
  }

  function _response(s, r, encodedDataLength) {
    return {
      status: r.status ?? 0,
      statusText: r.statusText || "",
      httpVersion: r.protocol || "",
      cookies: [],
      headers: _redactHeaders(_headers(r.headers), s.opts.includeSensitive),
      content: { size: encodedDataLength ?? -1, mimeType: r.mimeType || "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: encodedDataLength ?? -1,
    };
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
  }

  function _fetchBody(s, tabId, requestId, entry) {
    const mime = entry.response?.content?.mimeType || "";
    const size = entry.response?.content?.size ?? 0;
    if (!s.opts.includeBodies || !TEXT_MIME.test(mime)) return;
    if (size > s.opts.maxBodyBytes || s.bodyBytes + Math.max(0, size) > DEFAULT_TOTAL_BODY_BYTES) {
      entry.response.content.comment = "Body not saved (over the size limit).";
      return;
    }
    const p = _deps
      .sendCommand(tabId, "Network.getResponseBody", { requestId })
      .then((res) => {
        if (!res) return;
        let text = res.body || "";
        if (text.length > s.opts.maxBodyBytes) {
          entry.response.content.comment = "Body not saved (over the size limit).";
          return;
        }
        s.bodyBytes += text.length;
        entry.response.content.text = text;
        if (res.base64Encoded) entry.response.content.encoding = "base64";
      })
      .catch(() => {
        entry.response.content.comment = "Body no longer available from the browser.";
      })
      .finally(() => s.pendingBodies.delete(p));
    s.pendingBodies.add(p);
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
        s.live.set(params.requestId, _newEntry(s, params));
        break;
      }
      case "Network.responseReceived": {
        const e = s.live.get(params.requestId);
        if (!e) break;
        e.response = _response(s, params.response, null);
        e._timing = params.response?.timing;
        if (params.response?.remoteIPAddress) e.serverIPAddress = params.response.remoteIPAddress;
        if (params.response?.fromDiskCache) e.cache = { beforeRequest: null, comment: "from disk cache" };
        break;
      }
      case "Network.loadingFinished": {
        const e = s.live.get(params.requestId);
        if (!e) break;
        if (!e.response) e.response = _response(s, {}, params.encodedDataLength);
        e.response.content.size = params.encodedDataLength;
        e.response.bodySize = params.encodedDataLength;
        _timings(e, e._timing, params.timestamp);
        _finish(s, params.requestId, e);
        _fetchBody(s, tabId, params.requestId, e);
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
      durationMs: Date.now() - s.startedAt,
    };
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
    return { ..._counts(s), recent };
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
    const entries = s.entries.map(({ _ts, _startMs, _timing, ...e }) => e);
    const har = {
      log: {
        version: "1.2",
        creator: creator || { name: "AutoDOM", version: "" },
        ...(browser && { browser }),
        pages: s.pages.map(({ _ts, ...p }) => p),
        entries,
        comment:
          "Recorded by AutoDOM over the DevTools protocol. Request headers are those the page sent before the network stack added cookies." +
          (s.opts.includeSensitive ? "" : " Credentials, cookies and sensitive parameters are REDACTED."),
        _userActions: userActions,
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
        userActions: userActions.length,
        byStatus,
        dropped: s.dropped,
        durationMs: Date.now() - s.startedAt,
        bodiesSavedBytes: s.bodyBytes,
        actions: userActions.map((a) => ({ index: a.index, action: a.action, target: a.target, requests: a.requests })),
      },
    };
  }

  globalThis.AutoDOMHar = { init, start, stop, status, isActive, _onEvent, _sessions };
})();
