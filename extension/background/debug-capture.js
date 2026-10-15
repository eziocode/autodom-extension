/**
 * AutoDOM — Debug capture (console + network over CDP)
 *
 * Keeps a per-tab ring buffer of console messages, uncaught exceptions and
 * network requests from chrome.debugger events, for get_console_logs and
 * get_network_requests. Capture starts the first time either tool runs on
 * a tab and keeps the debugger attached until the tab closes, the user
 * detaches it, or stop() is called — so output that arrives between calls
 * is not lost. Buffers reset when the tab's top-level host changes.
 *
 * The service worker owns attachment (ensureDebugger / detachDebuggerSafe)
 * and passes it in via init(). Exposed as globalThis.AutoDOMDebugCapture.
 */
(function () {
  const MAX_CONSOLE_PER_TAB = 2000;
  const MAX_REQUESTS_PER_TAB = 1000;
  const MAX_TEXT = 4000;

  // Query/fragment parameters whose values are replaced before a URL is
  // returned to a caller.
  const SENSITIVE_PARAM =
    /^(access_?token|id_?token|refresh_?token|token|auth|authorization|api_?key|key|secret|client_secret|password|passwd|pwd|session|sessionid|sid|code|sig|signature|x-amz-signature|x-amz-credential|x-goog-signature)$/i;

  const _tabs = new Map(); // tabId → { host, active, console: [], network: [], byId: Map }
  const _observers = new Set(); // fn(tabId, method, params) for capturing tabs
  let _deps = null;
  let _listening = false;

  function isSensitiveName(name) {
    return SENSITIVE_PARAM.test(String(name || ""));
  }

  // Other recorders (HAR) see the same CDP events for tabs being captured.
  function addObserver(fn) {
    _observers.add(fn);
    return () => _observers.delete(fn);
  }

  function init(deps) {
    _deps = deps;
    if (_listening || !chrome?.debugger?.onEvent) return;
    _listening = true;
    chrome.debugger.onEvent.addListener(_onEvent);
    chrome.debugger.onDetach.addListener((source) => {
      const s = source?.tabId != null ? _tabs.get(source.tabId) : null;
      if (s) s.active = false;
    });
    chrome.tabs?.onRemoved?.addListener((tabId) => _tabs.delete(tabId));
    chrome.tabs?.onUpdated?.addListener((tabId, info) => {
      if (info?.url) _noteUrl(tabId, info.url);
    });
  }

  function _hostOf(url) {
    try {
      return new URL(url).host.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function _state(tabId) {
    let s = _tabs.get(tabId);
    if (!s) {
      s = { host: "", active: false, console: [], network: [], byId: new Map() };
      _tabs.set(tabId, s);
    }
    return s;
  }

  // A new top-level host starts empty buffers: data from the previous site
  // must not be read back under the new site's permission.
  function _noteUrl(tabId, url) {
    const s = _tabs.get(tabId);
    if (!s) return;
    const host = _hostOf(url);
    if (!host || host === s.host) return;
    if (s.host) {
      s.console = [];
      s.network = [];
      s.byId.clear();
    }
    s.host = host;
  }

  function _clip(text) {
    const t = String(text ?? "");
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + "…" : t;
  }

  function _push(list, item, max) {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  }

  function redactUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return _clip(url);
    }
    if (u.username || u.password) {
      u.username = u.username ? "REDACTED" : "";
      u.password = u.password ? "REDACTED" : "";
    }
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) u.searchParams.set(key, "REDACTED");
    }
    if (u.hash.includes("=")) {
      const frag = new URLSearchParams(u.hash.slice(1));
      let changed = false;
      for (const key of [...frag.keys()]) {
        if (SENSITIVE_PARAM.test(key)) {
          frag.set(key, "REDACTED");
          changed = true;
        }
      }
      if (changed) u.hash = frag.toString();
    }
    return _clip(u.toString());
  }

  function _remoteObjectText(arg) {
    if (!arg) return "";
    if (arg.value !== undefined) {
      return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
    }
    if (arg.unserializableValue) return arg.unserializableValue;
    return arg.description || arg.type || "";
  }

  function _frames(stackTrace) {
    return (stackTrace?.callFrames || [])
      .slice(0, 10)
      .map((f) => `    at ${f.functionName || "<anonymous>"} (${redactUrl(f.url)}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
      .join("\n");
  }

  function _onEvent(source, method, params) {
    const tabId = source?.tabId;
    if (tabId == null) return;
    const s = _tabs.get(tabId);
    if (!s || !s.active) return;
    for (const fn of _observers) {
      try {
        fn(tabId, method, params);
      } catch (_) {}
    }

    switch (method) {
      case "Runtime.consoleAPICalled": {
        const frame = params.stackTrace?.callFrames?.[0];
        _push(s.console, {
          level: params.type === "warning" ? "warn" : params.type || "log",
          text: _clip((params.args || []).map(_remoteObjectText).join(" ")),
          ts: params.timestamp ? Math.round(params.timestamp) : Date.now(),
          url: frame?.url ? redactUrl(frame.url) : undefined,
          line: frame ? frame.lineNumber + 1 : undefined,
          column: frame ? frame.columnNumber + 1 : undefined,
        }, MAX_CONSOLE_PER_TAB);
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        _push(s.console, {
          level: "exception",
          text: _clip(d.exception?.description || d.text || "Uncaught exception"),
          ts: params.timestamp ? Math.round(params.timestamp) : Date.now(),
          url: d.url ? redactUrl(d.url) : undefined,
          line: d.lineNumber != null ? d.lineNumber + 1 : undefined,
          column: d.columnNumber != null ? d.columnNumber + 1 : undefined,
          stack: _frames(d.stackTrace) || undefined,
        }, MAX_CONSOLE_PER_TAB);
        break;
      }
      case "Log.entryAdded": {
        // Browser-side messages (CSP violations, failed loads, deprecations)
        // that never pass through console.*.
        const e = params.entry || {};
        _push(s.console, {
          level: e.level === "warning" ? "warn" : e.level || "info",
          source: e.source,
          text: _clip(e.text),
          ts: e.timestamp ? Math.round(e.timestamp) : Date.now(),
          url: e.url ? redactUrl(e.url) : undefined,
          line: e.lineNumber != null ? e.lineNumber + 1 : undefined,
        }, MAX_CONSOLE_PER_TAB);
        break;
      }
      case "Network.requestWillBeSent": {
        const req = {
          requestId: params.requestId,
          method: params.request?.method || "GET",
          url: redactUrl(params.request?.url || ""),
          type: params.type || "Other",
          startedAt: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now(),
          _t0: params.timestamp,
          status: null,
        };
        const prev = s.byId.get(params.requestId);
        if (prev && params.redirectResponse) {
          // A redirect reuses the requestId: close out the hop that redirected.
          prev.status = params.redirectResponse.status;
          prev.redirectedTo = req.url;
          s.byId.delete(params.requestId);
        }
        _push(s.network, req, MAX_REQUESTS_PER_TAB);
        s.byId.set(params.requestId, req);
        if (s.byId.size > MAX_REQUESTS_PER_TAB * 2) {
          const live = new Set(s.network);
          for (const [id, r] of s.byId) if (!live.has(r)) s.byId.delete(id);
        }
        break;
      }
      case "Network.responseReceived": {
        const req = s.byId.get(params.requestId);
        if (!req) break;
        req.status = params.response?.status ?? null;
        req.statusText = params.response?.statusText || undefined;
        req.mimeType = params.response?.mimeType || undefined;
        req.fromCache = params.response?.fromDiskCache || params.response?.fromServiceWorker || undefined;
        break;
      }
      case "Network.loadingFinished": {
        const req = s.byId.get(params.requestId);
        if (!req) break;
        req.bytes = params.encodedDataLength;
        if (req._t0 != null) req.durationMs = Math.round((params.timestamp - req._t0) * 1000);
        s.byId.delete(params.requestId);
        break;
      }
      case "Network.loadingFailed": {
        const req = s.byId.get(params.requestId);
        if (!req) break;
        req.failed = true;
        req.error = params.blockedReason || params.corsErrorStatus?.corsError || params.errorText || "failed";
        if (params.canceled) req.canceled = true;
        if (req._t0 != null) req.durationMs = Math.round((params.timestamp - req._t0) * 1000);
        s.byId.delete(params.requestId);
        break;
      }
      default:
        break;
    }
  }

  // Attach (if needed) and enable the domains. Returns { started } where
  // started is true only on the call that turned capture on.
  async function start(tabId, tabUrl) {
    if (!_deps) throw new Error("debug capture not initialised");
    const s = _state(tabId);
    if (s.active) return { started: false };
    await _deps.ensureDebugger(tabId);
    if (!s.host && tabUrl) s.host = _hostOf(tabUrl);
    s.active = true;
    try {
      const send = (m, p) => _deps.sendCommand(tabId, m, p);
      await send("Runtime.enable");
      await send("Log.enable").catch(() => {});
      await send("Network.enable", { maxPostDataSize: 0 });
    } catch (err) {
      s.active = false;
      throw err;
    }
    return { started: true };
  }

  async function stop(tabId) {
    const s = _tabs.get(tabId);
    if (!s) return;
    s.active = false;
    try {
      await _deps?.sendCommand(tabId, "Network.disable");
    } catch (_) {}
    await _deps?.detach?.(tabId);
  }

  function isActive(tabId) {
    return !!_tabs.get(tabId)?.active;
  }

  function _matcher(pattern) {
    if (!pattern) return null;
    try {
      const re = new RegExp(pattern, "i");
      return (text) => re.test(text);
    } catch (_) {
      const p = String(pattern).toLowerCase();
      return (text) => String(text).toLowerCase().includes(p);
    }
  }

  const ERROR_LEVELS = new Set(["error", "exception", "assert"]);

  function getConsole(tabId, { pattern, level, onlyErrors, limit = 100, clear = false } = {}) {
    const s = _tabs.get(tabId);
    const all = s ? s.console : [];
    const match = _matcher(pattern);
    const wantLevel = level ? String(level).toLowerCase() : null;
    const filtered = all.filter((m) => {
      if (onlyErrors && !ERROR_LEVELS.has(m.level)) return false;
      if (wantLevel && m.level !== wantLevel && !(wantLevel === "warning" && m.level === "warn")) return false;
      if (match && !match(m.text)) return false;
      return true;
    });
    if (clear && s) s.console = [];
    const n = Math.max(1, Math.min(Number(limit) || 100, MAX_CONSOLE_PER_TAB));
    return { messages: filtered.slice(-n), total: filtered.length, truncated: filtered.length > n };
  }

  function getNetwork(tabId, { urlPattern, failedOnly, limit = 100, clear = false } = {}) {
    const s = _tabs.get(tabId);
    const all = s ? s.network : [];
    const p = urlPattern ? String(urlPattern).toLowerCase() : "";
    const filtered = all.filter((r) => {
      if (p && !r.url.toLowerCase().includes(p)) return false;
      if (failedOnly && !(r.failed || (r.status != null && r.status >= 400))) return false;
      return true;
    });
    if (clear && s) {
      s.network = [];
      s.byId.clear();
    }
    const n = Math.max(1, Math.min(Number(limit) || 100, MAX_REQUESTS_PER_TAB));
    const requests = filtered.slice(-n).map(({ _t0, ...r }) => ({
      ...r,
      status: r.status ?? (r.failed ? "failed" : "pending"),
    }));
    return { requests, total: filtered.length, truncated: filtered.length > n };
  }

  globalThis.AutoDOMDebugCapture = {
    init,
    start,
    stop,
    isActive,
    getConsole,
    getNetwork,
    redactUrl,
    isSensitiveName,
    addObserver,
    _onEvent,
    _noteUrl,
    _state,
    MAX_CONSOLE_PER_TAB,
    MAX_REQUESTS_PER_TAB,
  };
})();
