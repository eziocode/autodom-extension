/**
 * AutoDOM — Ask Before Act (ActionGate)
 *
 * Middleware between the agent's tool-call planner and the DOM executor.
 * Classifies every tool call into a risk tier, consults per-site permissions,
 * and — when unresolved — asks the in-page chat panel to confirm before the
 * action fires. All storage is local; there is no cloud/server enforcement.
 *
 * Exposed as globalThis.AutoDOMActionGate via importScripts() in the SW.
 *
 * Decision flow:
 *   classify(tool, params?) → one of "safe-read" | "debug-read" |
 *                             "mutating" | "destructive"
 *   resolveDecision(origin, category, settings) → "allow" | "ask" | "deny"
 *   requestDecision({ tabId, origin, pageUrl, targetUrl, toolName, params, batchOrigin }):
 *     1. administrator policy (managed blockedUrlPatterns) on the page or
 *        navigation target → deny, even with the gate switched off
 *     2. gate disabled → allow
 *     3. navigation to another host → domain-transition grant
 *        (from → to), else ask
 *     4. batch step on the origin the batch was approved for → allow
 *     5. per-origin category policy; ask → send ACTION_GATE_REQUEST to
 *        the tab's chat panel, await an ACTION_GATE_DECISION reply,
 *        persist if the user opted to, and append to the audit log.
 */
(function () {
  const STORAGE_KEYS = {
    permissions: "autodomSitePermissions",
    transitions: "autodomDomainTransitions",
    audit: "autodomAuditLog",
    settings: "autodomActionGateSettings",
  };

  // chrome.storage.managed key set by enterprise policy (managed_schema.json).
  const POLICY_BLOCKLIST_KEY = "blockedUrlPatterns";

  const DEFAULT_SETTINGS = {
    enabled: true,
    silentReads: true, // skip prompts for safe-read actions
  };

  const AUDIT_LIMIT = 500;

  // Risk classification. Any tool not listed defaults to "mutating" (the
  // conservative middle tier) so new tools don't silently bypass the gate.
  const SAFE_READ = new Set([
    "get_page_info",
    "get_dom_state",
    "query_elements",
    "extract_text",
    "extract_data",
    "get_html",
    "list_tabs",
    "list_downloads",
    "wait_for_download",
    "list_iframes",
    "list_shadow_roots",
    "list_popups",
    "check_element_state",
    "take_screenshot",
    "take_snapshot",
    "get_cookies",
    "get_storage",
    "get_session_summary",
    "get_recording",
    "get_tool_tiers",
    "verify_artifact_counts",
    "deep_query",
    "wait_for_network_idle",
    "get_pending_chat_requests",
    "performance_analyze_insight",
    "browser_snapshot",
    "browser_take_screenshot",
    "browser_wait_for",
    // Media / image reads (media-tools.js). media_control is mutating.
    "media_list",
    "media_get_captions",
    "media_capture_frame",
    "media_sample_frames",
    "image_list",
    "image_get_data",
    "macro_record_stop",
    "tab_recording_status",
    // Workflow engine reads.
    "workflow_list",
    "workflow_get",
    "workflow_export",
    "workflow_record_stop",
    "run_list",
    "run_get",
    "schedule_list",
    "webmcp_list_tools",
  ]);

  // Debugging reads (console output, network traffic) can expose tokens,
  // PII and API payloads, so they are reads that silentReads does not
  // cover: they ask once per origin unless "Allow on <origin>" is chosen.
  const DEBUG_READ = new Set([
    "get_console_logs",
    "get_network_requests",
    "browser_console_messages",
    "browser_network_requests",
    "har_start",
    "har_status",
    "har_stop",
  ]);

  // Tools whose `url` param moves the page (or a new tab) to another site.
  const NAVIGATING_TOOLS = new Set(["navigate", "browser_navigate", "open_new_tab", "har_start"]);

  // Anything in this list bypasses a site's "allow mutating" rule and is
  // always prompted unless the origin is Full Trust (v2 — not yet exposed).
  const DESTRUCTIVE = new Set([
    "navigate",
    "batch_actions",
    "evaluate_script",
    "execute_async_script",
    "execute_code",
    "run_automation_script",
    "set_cookie",
    "set_storage",
    "upload_file",
    "close_tab",
    "open_new_tab",
    "switch_tab",
    "switch_to_popup",
    "close_popup",
    "start_recording",
    "stop_recording",
    "emulate",
    "set_viewport",
    "handle_dialog",
    "browser_navigate",
    "browser_navigate_back",
    "browser_tabs",
    "browser_resize",
    "browser_handle_dialog",
    "browser_evaluate",
    "browser_close",
    "clear_cookies",
    "print_to_pdf",
    // Macro + tab recorders persist data and (for tab recording) capture
    // off-screen state. Always confirm.
    "macro_record_start",
    "macro_replay",
    "tab_recording_start",
    "tab_recording_stop",
    // Replaying a workflow performs every recorded step; recording
    // captures typed values. Always confirm.
    "workflow_run",
    "workflow_run_many",
    "run_undo",
    "workflow_record_start",
    "webmcp_call_tool",
  ]);

  function classify(toolName, params = {}) {
    // Parameter-aware classification for compatibility tools that can represent
    // both read and state-changing operations.
    if (toolName === "fetch_page_source" || toolName === "browser_fetch_raw") {
      const method = String(params?.method || "GET").toUpperCase();
      return (method === "GET" || method === "HEAD") && params?.body === undefined
        ? "safe-read"
        : "destructive";
    }
    if (toolName === "browser_tabs") {
      const action = String(params?.action || "list").toLowerCase();
      if (action === "list") return "safe-read";
      if (action === "select") return "mutating";
      if (action === "new" || action === "close") return "destructive";
    }
    if (SAFE_READ.has(toolName)) return "safe-read";
    if (DEBUG_READ.has(toolName)) return "debug-read";
    if (DESTRUCTIVE.has(toolName)) return "destructive";
    return "mutating";
  }

  function normalizeOrigin(url) {
    if (!url) return "unknown";
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch (_) {
      return "unknown";
    }
  }

  // ── Domain transitions ──────────────────────────────────────
  // A navigation that leaves the current host is its own decision
  // (from → to), separate from what is allowed on either site.

  function _webHost(url, base) {
    try {
      const u = base ? new URL(url, base) : new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.host.toLowerCase().replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  }

  // The URL a navigating tool is about to load, or null.
  function navigationTarget(toolName, params) {
    if (!NAVIGATING_TOOLS.has(toolName)) return null;
    const url = params?.url;
    return typeof url === "string" && url ? url : null;
  }

  // { from, to } hosts when targetUrl leaves pageUrl's host. Pages without
  // a web host (new tab, chrome://, about:blank) have nothing to leave.
  function transitionOf(pageUrl, targetUrl) {
    if (!targetUrl) return null;
    const from = _webHost(pageUrl);
    const to = _webHost(targetUrl, pageUrl || undefined);
    if (!from || !to || from === to) return null;
    return { from, to };
  }

  // ── Administrator policy: blockedUrlPatterns ────────────────
  // Patterns match "host/path" (case-insensitive; scheme and "www." are
  // ignored; "*" matches any run of characters). A bare domain means
  // "<domain>/*"; use "*.example.com" for subdomains.

  function compileBlockPattern(pattern) {
    let p = String(pattern || "").trim().toLowerCase();
    if (!p) return null;
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
    if (!p.includes("/")) p += "/*";
    const body = p
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    try {
      return new RegExp(`^${body}$`);
    } catch (_) {
      return null;
    }
  }

  function matchBlockedPattern(patterns, url) {
    let subject;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      subject = u.host.toLowerCase().replace(/^www\./, "") + (u.pathname || "/");
    } catch (_) {
      return null;
    }
    for (const pattern of patterns || []) {
      const re = compileBlockPattern(pattern);
      if (re && re.test(subject)) return pattern;
    }
    return null;
  }

  let _policyBlocklist = null;

  async function getPolicyBlocklist() {
    if (_policyBlocklist) return _policyBlocklist;
    let list = [];
    try {
      const out = await chrome.storage.managed.get(POLICY_BLOCKLIST_KEY);
      const raw = out ? out[POLICY_BLOCKLIST_KEY] : undefined;
      if (Array.isArray(raw)) list = raw.map(String).filter(Boolean);
    } catch (_) {
      // No managed storage (Firefox without policy, tests): no blocklist.
    }
    _policyBlocklist = list;
    return list;
  }

  // The administrator pattern that blocks any of the given URLs, or null.
  async function policyBlockFor(...urls) {
    const patterns = await getPolicyBlocklist();
    if (!patterns.length) return null;
    for (const url of urls) {
      if (!url) continue;
      const hit = matchBlockedPattern(patterns, url);
      if (hit) return hit;
    }
    return null;
  }

  // Pure decision function — unit-testable. Given the stored permission
  // record for an origin + the risk category + settings, return the policy.
  function resolveDecision(perm, category, settings) {
    const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (!s.enabled) return "allow";
    if (category === "safe-read" && s.silentReads) return "allow";
    if (!perm || !perm.categories) return "ask";
    // Destructive is always "ask" unless the origin has explicit
    // destructive=always (reserved for Full Trust, not yet exposed).
    if (category === "destructive") {
      return perm.categories.destructive === "always" ? "allow" : "ask";
    }
    const rule = perm.categories[category];
    if (rule === "always") return "allow";
    if (rule === "never") return "deny";
    return "ask";
  }

  // ── Storage helpers ─────────────────────────────────────────
  // Settings, site permissions and approval rules are read on every tool
  // call, so they are cached in memory and dropped on storage.onChanged
  // (popup edits, other contexts). Without onChanged there is no way to
  // invalidate, so nothing is cached. Callers get a copy, never the cache.
  const APPROVAL_RULES_KEY = "autodom.approvalRules";
  const CACHED_KEYS = new Set([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.permissions,
    STORAGE_KEYS.transitions,
    APPROVAL_RULES_KEY,
  ]);
  const _cache = new Map();
  let _cacheable = false;
  try {
    if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "managed") {
          _policyBlocklist = null;
          return;
        }
        if (area && area !== "local") return;
        for (const key of Object.keys(changes || {})) _cache.delete(key);
      });
      _cacheable = true;
    }
  } catch (_) {}

  // Drops the in-memory copies; the next read reloads from storage.
  function clearCaches() {
    _cache.clear();
    _policyBlocklist = null;
  }

  function _copy(v) {
    if (v == null || typeof v !== "object") return v;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (_) {
      return v;
    }
  }

  async function _readKey(key) {
    if (_cacheable && CACHED_KEYS.has(key) && _cache.has(key)) return _copy(_cache.get(key));
    const out = await chrome.storage.local.get(key);
    const value = out ? out[key] : undefined;
    if (_cacheable && CACHED_KEYS.has(key)) _cache.set(key, _copy(value));
    return value;
  }

  async function getStorage(key, fallback) {
    try {
      return (await _readKey(key)) ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  async function setStorage(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      if (_cacheable && CACHED_KEYS.has(key)) _cache.set(key, _copy(value));
    } catch (_) {
      _cache.delete(key);
    }
  }

  async function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await getStorage(STORAGE_KEYS.settings, {})) };
  }

  async function setSettings(patch) {
    const next = { ...(await getSettings()), ...(patch || {}) };
    await setStorage(STORAGE_KEYS.settings, next);
    return next;
  }

  async function getPermissions() {
    return (await getStorage(STORAGE_KEYS.permissions, {})) || {};
  }

  async function getPermissionFor(origin) {
    const all = await getPermissions();
    return all[origin] || null;
  }

  async function setPermission(origin, patch) {
    const all = await getPermissions();
    const existing = all[origin] || { origin, categories: {} };
    const next = {
      ...existing,
      origin,
      categories: { ...(existing.categories || {}), ...(patch?.categories || {}) },
      updatedAt: Date.now(),
    };
    all[origin] = next;
    await setStorage(STORAGE_KEYS.permissions, all);
    return next;
  }

  async function revokePermission(origin) {
    const all = await getPermissions();
    delete all[origin];
    await setStorage(STORAGE_KEYS.permissions, all);
  }

  async function clearAllPermissions() {
    await setStorage(STORAGE_KEYS.permissions, {});
    await setStorage(STORAGE_KEYS.transitions, {});
  }

  // Domain-transition grants: { "<from>-><to>": { from, to, action, updatedAt } }
  function _transitionKey(from, to) {
    return `${from}->${to}`;
  }

  async function getTransitions() {
    return (await getStorage(STORAGE_KEYS.transitions, {})) || {};
  }

  async function getTransitionFor(from, to) {
    const all = await getTransitions();
    return all[_transitionKey(from, to)] || null;
  }

  async function setTransition(from, to, action) {
    if (action !== "allow" && action !== "deny") {
      throw new Error('transition action must be "allow" or "deny"');
    }
    const all = await getTransitions();
    const next = { from, to, action, updatedAt: Date.now() };
    all[_transitionKey(from, to)] = next;
    await setStorage(STORAGE_KEYS.transitions, all);
    return next;
  }

  async function revokeTransition(from, to) {
    const all = await getTransitions();
    delete all[_transitionKey(from, to)];
    await setStorage(STORAGE_KEYS.transitions, all);
  }

  // ── Audit log (bounded ring buffer) ─────────────────────────
  // Calls now run in parallel, so concurrent read-modify-write appends
  // would drop entries. Appends are buffered for AUDIT_FLUSH_MS and
  // written by one serialized chain; reads flush first.
  const AUDIT_FLUSH_MS = 500;
  let _auditBuffer = [];
  let _auditTimer = null;
  let _auditChain = Promise.resolve();

  function _flushAudit() {
    if (_auditTimer) {
      clearTimeout(_auditTimer);
      _auditTimer = null;
    }
    const batch = _auditBuffer;
    _auditBuffer = [];
    if (!batch.length) return _auditChain;
    _auditChain = _auditChain
      .then(async () => {
        const log = (await getStorage(STORAGE_KEYS.audit, [])) || [];
        log.push(...batch);
        if (log.length > AUDIT_LIMIT) log.splice(0, log.length - AUDIT_LIMIT);
        await setStorage(STORAGE_KEYS.audit, log);
      })
      .catch(() => {});
    return _auditChain;
  }

  async function appendAudit(entry) {
    _auditBuffer.push({ ...entry, t: Date.now() });
    if (!_auditTimer) _auditTimer = setTimeout(_flushAudit, AUDIT_FLUSH_MS);
  }

  async function getAuditLog() {
    await _flushAudit();
    return (await getStorage(STORAGE_KEYS.audit, [])) || [];
  }

  async function clearAuditLog() {
    if (_auditTimer) {
      clearTimeout(_auditTimer);
      _auditTimer = null;
    }
    _auditBuffer = [];
    _auditChain = _auditChain
      .then(() => setStorage(STORAGE_KEYS.audit, []))
      .catch(() => {});
    await _auditChain;
  }

  // ── Interactive request flow ────────────────────────────────
  const _pending = new Map(); // requestId → { resolve, timer }
  let _reqIdCounter = 0;

  function _nextId() {
    _reqIdCounter += 1;
    return `gate-${Date.now().toString(36)}-${_reqIdCounter}`;
  }

  // Resolve a pending decision (called from the chat panel via a runtime
  // message; see service-worker message router).
  function deliverDecision(requestId, decision) {
    const pending = _pending.get(requestId);
    if (!pending) return false;
    _pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision || { allowed: false, reason: "Empty decision" });
    return true;
  }

  async function requestDecision({
    tabId,
    origin,
    pageUrl,
    targetUrl,
    toolName,
    params,
    category,
    batchOrigin,
  }) {
    const cat = category || classify(toolName, params);
    const target = targetUrl === undefined ? navigationTarget(toolName, params) : targetUrl;

    // 1. Administrator policy beats every user setting, including the
    //    master toggle.
    const blockedBy = await policyBlockFor(pageUrl || origin, target);
    if (blockedBy) {
      await appendAudit({ origin, toolName, category: cat, decision: "deny-policy", reason: blockedBy });
      return {
        allowed: false,
        policyBlocked: true,
        reason: `Blocked by administrator policy (${blockedBy})`,
      };
    }

    // Parallelize independent storage reads: previously these awaited
    // sequentially, doubling the per-tool storage round-trip cost on every
    // turn of the agent loop.
    const [settings, perm] = await Promise.all([
      getSettings(),
      getPermissionFor(origin),
    ]);
    if (!settings.enabled) {
      await appendAudit({ origin, toolName, category: cat, decision: "allow-preapproved" });
      return { allowed: true, reason: "pre-approved" };
    }

    // 2. Leaving the current site is decided per from → to pair.
    const transition = transitionOf(pageUrl || origin, target);
    if (transition) {
      const grant = await getTransitionFor(transition.from, transition.to);
      if (grant?.action === "deny") {
        await appendAudit({ origin, toolName, category: cat, decision: "deny-transition", transition });
        return {
          allowed: false,
          reason: `Navigation from ${transition.from} to ${transition.to} is blocked by your site rule`,
        };
      }
      if (grant?.action === "allow") {
        await appendAudit({ origin, toolName, category: cat, decision: "allow-transition", transition });
        return { allowed: true, reason: "pre-approved transition" };
      }
      return _promptAndRecord({ tabId, origin, toolName, params, category: cat, transition });
    }

    // 3. Steps of an approved batch run on that batch's origin. A step on
    //    any other origin (the batch navigated away) is decided below.
    if (batchOrigin && batchOrigin === origin) {
      await appendAudit({ origin, toolName, category: cat, decision: "allow-batch" });
      return { allowed: true, reason: "approved batch" };
    }

    // 4. Per-origin category policy.
    const policy = resolveDecision(perm, cat, settings);

    if (policy === "allow") {
      await appendAudit({ origin, toolName, category: cat, decision: "allow-preapproved" });
      return { allowed: true, reason: "pre-approved" };
    }
    if (policy === "deny") {
      await appendAudit({ origin, toolName, category: cat, decision: "deny-preset" });
      return { allowed: false, reason: `Blocked by site rule on ${origin}` };
    }

    return _promptAndRecord({ tabId, origin, toolName, params, category: cat });
  }

  // policy === "ask" → prompt in the tab's chat panel, persist what the
  // user chose, audit, and return the decision.
  async function _promptAndRecord({ tabId, origin, toolName, params, category: cat, transition }) {
    if (tabId == null) {
      // No UI available — fail closed.
      await appendAudit({ origin, toolName, category: cat, decision: "deny-no-ui", transition });
      return { allowed: false, reason: "No chat panel available to confirm action" };
    }

    const requestId = _nextId();
    const request = {
      type: "ACTION_GATE_REQUEST",
      requestId,
      origin,
      toolName,
      category: cat,
      params: _safeParamsPreview(params),
      ...(transition && { transition }),
      ts: Date.now(),
    };

    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (_pending.has(requestId)) {
          _pending.delete(requestId);
          resolve({ allowed: false, reason: "Confirmation timed out" });
        }
      }, 120_000);
      _pending.set(requestId, { resolve, timer });
      try {
        chrome.tabs.sendMessage(tabId, request).catch?.(() => {
          deliverDecision(requestId, {
            allowed: false,
            reason: "Chat panel not reachable in this tab",
          });
        });
      } catch (err) {
        deliverDecision(requestId, {
          allowed: false,
          reason: err?.message || "Failed to deliver confirmation request",
        });
      }
    });

    // Persist "Allow on origin" / "Always allow from → to" decisions.
    if (transition) {
      if (decision.allowed && decision.persist === "transition") {
        await setTransition(transition.from, transition.to, "allow");
      }
      if (!decision.allowed && decision.persist === "transition-deny") {
        await setTransition(transition.from, transition.to, "deny");
      }
    } else {
      if (decision.allowed && decision.persist === "origin" && cat !== "destructive") {
        await setPermission(origin, { categories: { [cat]: "always" } });
      }
      if (!decision.allowed && decision.persist === "origin-deny") {
        await setPermission(origin, { categories: { [cat]: "never" } });
      }
    }

    const persisted = ["origin", "transition"].includes(decision.persist);
    const persistedDeny = ["origin-deny", "transition-deny"].includes(decision.persist);
    await appendAudit({
      origin,
      toolName,
      category: cat,
      decision: decision.allowed
        ? persisted
          ? "allow-persisted"
          : "allow-once"
        : persistedDeny
          ? "deny-persisted"
          : "deny-once",
      reason: decision.reason || null,
      transition,
    });

    return decision;
  }

  function _safeParamsPreview(params) {
    try {
      const s = JSON.stringify(params ?? {});
      return s.length > 600 ? s.slice(0, 600) + "…" : s;
    } catch (_) {
      return "[unserializable]";
    }
  }

  // ── Per-site approval rules for bridge (IDE agent) calls ──
  // [{ match: "*.bank.com" | "github.com" | "*", tier: "any"|"write"|"destructive",
  //    policy: "allow"|"ask"|"deny", tools?: ["navigate", ...] }]
  // First matching rule wins. No match = the default behaviour.
  const RULE_TIERS = new Set(["any", "write", "destructive"]);
  const RULE_POLICIES = new Set(["allow", "ask", "deny"]);

  function tierOf(toolName, params) {
    const c = classify(toolName, params);
    if (c === "safe-read" || c === "debug-read") return "read";
    return c === "mutating" ? "write" : "destructive";
  }

  function hostMatches(pattern, host) {
    const p = String(pattern || "").trim().toLowerCase();
    const h = String(host || "").toLowerCase();
    if (!p) return false;
    if (p === "*") return true;
    if (!h) return false;
    const bare = p.startsWith("*.") ? p.slice(2) : p;
    return h === bare || h.endsWith("." + bare);
  }

  function normalizeRules(rules) {
    const out = [];
    const errors = [];
    (Array.isArray(rules) ? rules : []).forEach((r, i) => {
      const rule = {
        match: String((r && r.match) || "").trim().toLowerCase(),
        tier: String((r && r.tier) || "write").toLowerCase(),
        policy: String((r && r.policy) || "").toLowerCase(),
      };
      if (Array.isArray(r && r.tools) && r.tools.length) rule.tools = r.tools.map(String);
      if (!rule.match || !/^(\*|(\*\.)?[a-z0-9.-]+)$/.test(rule.match)) errors.push(`rule ${i + 1}: match must be "*", "example.com" or "*.example.com"`);
      if (!RULE_TIERS.has(rule.tier)) errors.push(`rule ${i + 1}: tier must be any, write or destructive`);
      if (!RULE_POLICIES.has(rule.policy)) errors.push(`rule ${i + 1}: policy must be allow, ask or deny`);
      out.push(rule);
    });
    return { rules: out, errors };
  }

  function matchApprovalRule(rules, { host, tier, tool }) {
    for (const r of rules || []) {
      if (!hostMatches(r.match, host)) continue;
      if (r.tools && r.tools.length && !r.tools.includes(tool)) continue;
      if (r.tier === "write" && tier === "read") continue;
      if (r.tier === "destructive" && tier !== "destructive") continue;
      return r;
    }
    return null;
  }

  async function getApprovalRules() {
    try {
      return (await _readKey(APPROVAL_RULES_KEY)) || [];
    } catch (_) {
      return [];
    }
  }

  async function setApprovalRules(rules) {
    const { rules: clean, errors } = normalizeRules(rules);
    if (errors.length) return { ok: false, error: errors.join("; ") };
    await chrome.storage.local.set({ [APPROVAL_RULES_KEY]: clean });
    if (_cacheable) _cache.set(APPROVAL_RULES_KEY, _copy(clean));
    return { ok: true, rules: clean };
  }

  globalThis.AutoDOMActionGate = {
    classify,
    tierOf,
    hostMatches,
    normalizeRules,
    matchApprovalRule,
    getApprovalRules,
    setApprovalRules,
    normalizeOrigin,
    navigationTarget,
    transitionOf,
    matchBlockedPattern,
    policyBlockFor,
    resolveDecision,
    requestDecision,
    deliverDecision,
    getSettings,
    setSettings,
    getPermissions,
    getPermissionFor,
    setPermission,
    revokePermission,
    clearAllPermissions,
    getTransitions,
    getTransitionFor,
    setTransition,
    revokeTransition,
    getAuditLog,
    clearAuditLog,
    clearCaches,
    _STORAGE_KEYS: STORAGE_KEYS,
    _DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  };
})();
