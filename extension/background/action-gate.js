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
 *   classify(tool) → one of "safe-read" | "mutating" | "destructive"
 *   resolveDecision(origin, category, settings) → "allow" | "ask" | "deny"
 *   requestDecision({ tabId, origin, toolName, params }):
 *     - if pre-allowed, return { allowed: true, reason: "pre-approved" }
 *     - otherwise send ACTION_GATE_REQUEST to the tab's chat panel,
 *       await an ACTION_GATE_DECISION reply, persist if the user opted
 *       to "Allow on <origin>", and append to the audit log.
 */
(function () {
  const STORAGE_KEYS = {
    permissions: "autodomSitePermissions",
    audit: "autodomAuditLog",
    settings: "autodomActionGateSettings",
  };

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
    "get_console_logs",
    "get_network_requests",
    "list_tabs",
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
    "deep_query",
    "wait_for_network_idle",
    "get_pending_chat_requests",
    "list_automation_backends",
    "validate_automation_script",
    "performance_analyze_insight",
  ]);

  // Anything in this list bypasses a site's "allow mutating" rule and is
  // always prompted unless the origin is Full Trust (v2 — not yet exposed).
  const DESTRUCTIVE = new Set([
    "navigate",
    "batch_actions",
    "evaluate_script",
    "execute_async_script",
    "execute_code",
    "run_browser_script",
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
  ]);

  function classify(toolName) {
    if (SAFE_READ.has(toolName)) return "safe-read";
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
  async function getStorage(key, fallback) {
    try {
      const out = await chrome.storage.local.get(key);
      return out[key] ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  async function setStorage(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (_) {}
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
  }

  // ── Audit log (bounded ring buffer) ─────────────────────────
  async function appendAudit(entry) {
    const log = (await getStorage(STORAGE_KEYS.audit, [])) || [];
    log.push({ ...entry, t: Date.now() });
    if (log.length > AUDIT_LIMIT) log.splice(0, log.length - AUDIT_LIMIT);
    await setStorage(STORAGE_KEYS.audit, log);
  }

  async function getAuditLog() {
    return (await getStorage(STORAGE_KEYS.audit, [])) || [];
  }

  async function clearAuditLog() {
    await setStorage(STORAGE_KEYS.audit, []);
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

  async function requestDecision({ tabId, origin, toolName, params, category }) {
    const cat = category || classify(toolName);
    // Parallelize independent storage reads: previously these awaited
    // sequentially, doubling the per-tool storage round-trip cost on every
    // turn of the agent loop.
    const [settings, perm] = await Promise.all([
      getSettings(),
      getPermissionFor(origin),
    ]);
    const policy = resolveDecision(perm, cat, settings);

    if (policy === "allow") {
      await appendAudit({ origin, toolName, category: cat, decision: "allow-preapproved" });
      return { allowed: true, reason: "pre-approved" };
    }
    if (policy === "deny") {
      await appendAudit({ origin, toolName, category: cat, decision: "deny-preset" });
      return { allowed: false, reason: `Blocked by site rule on ${origin}` };
    }

    // policy === "ask" → prompt in chat panel
    if (tabId == null) {
      // No UI available — fail closed.
      await appendAudit({ origin, toolName, category: cat, decision: "deny-no-ui" });
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

    // Persist "Allow on origin" decisions.
    if (decision.allowed && decision.persist === "origin" && cat !== "destructive") {
      await setPermission(origin, { categories: { [cat]: "always" } });
    }
    if (!decision.allowed && decision.persist === "origin-deny") {
      await setPermission(origin, { categories: { [cat]: "never" } });
    }

    await appendAudit({
      origin,
      toolName,
      category: cat,
      decision: decision.allowed
        ? decision.persist === "origin"
          ? "allow-persisted"
          : "allow-once"
        : decision.persist === "origin-deny"
          ? "deny-persisted"
          : "deny-once",
      reason: decision.reason || null,
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

  globalThis.AutoDOMActionGate = {
    classify,
    normalizeOrigin,
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
    getAuditLog,
    clearAuditLog,
    _STORAGE_KEYS: STORAGE_KEYS,
    _DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  };
})();
