/**
 * AutoDOM — Tab-group isolation
 *
 * Keeps automation in its own chrome.tabGroups group so the user and the
 * agent can work in the same browser in parallel:
 *
 *   - Tabs AutoDOM creates ("owned") live in a group titled "AutoDOM" and
 *     are opened in the background — never activated or focused.
 *   - A tab the agent explicitly asks to work on ("adopted", via pin_tab /
 *     switch_tab with a tabId) is moved into the group and its original
 *     window / index / group / pinned state is remembered.
 *   - release() ends the session for a client: owned tabs are closed,
 *     adopted tabs are ungrouped and put back where they were, and the
 *     group disappears with its last tab.
 *
 * State is per clientId (one per MCP bridge process) and mirrored to
 * chrome.storage.session so a service-worker restart doesn't orphan tabs.
 * When tab groups aren't available (Firefox, old Chromium) or the user
 * turned isolation off, isEnabled() is false and callers keep the legacy
 * "follow the active tab" behaviour.
 *
 * Exposed as globalThis.AutoDOMTabGroup via importScripts() in the SW.
 */
(function () {
  const STORAGE_KEY = "__autodom_tab_groups";
  const SETTING_KEY = "isolationEnabled";
  const GROUP_TITLE = "AutoDOM";
  const GROUP_COLOR = "blue";
  const DEFAULT_IDLE_MS = 300000;
  const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

  const clients = new Map();
  // clientId -> { groupId, owned:Set<tabId>, adopted:Map<tabId,origin>,
  //               lastActivity, inflight }

  let serverDisabled = false;
  let idleMs = DEFAULT_IDLE_MS;
  let readyPromise = null;

  function api() {
    return typeof chrome !== "undefined" ? chrome : null;
  }

  function supported() {
    const c = api();
    return !!(c && c.tabs && c.tabs.group && c.tabs.ungroup && c.tabGroups);
  }

  async function isEnabled() {
    if (serverDisabled || !supported()) return false;
    try {
      const got = await api().storage.local.get(SETTING_KEY);
      return got?.[SETTING_KEY] !== false;
    } catch (_) {
      return true;
    }
  }

  function configure(opts = {}) {
    if (typeof opts.enabled === "boolean") serverDisabled = !opts.enabled;
    if (Number.isFinite(opts.idleMs) && opts.idleMs >= 0) idleMs = opts.idleMs;
  }

  // ── persistence ─────────────────────────────────────────────

  function sessionStore() {
    return api()?.storage?.session || null;
  }

  async function persist() {
    const store = sessionStore();
    if (!store) return;
    const out = {};
    for (const [clientId, s] of clients) {
      out[clientId] = {
        groupId: s.groupId,
        owned: [...s.owned],
        adopted: [...s.adopted],
        lastActivity: s.lastActivity,
      };
    }
    try {
      await store.set({ [STORAGE_KEY]: out });
    } catch (_) {}
  }

  async function tabExists(tabId) {
    try {
      return !!(await api().tabs.get(tabId));
    } catch (_) {
      return false;
    }
  }

  async function hydrate() {
    const store = sessionStore();
    if (!store) return;
    let saved;
    try {
      saved = (await store.get(STORAGE_KEY))?.[STORAGE_KEY];
    } catch (_) {
      return;
    }
    if (!saved) return;
    for (const [clientId, raw] of Object.entries(saved)) {
      if (clients.has(clientId)) continue;
      const s = newState();
      s.lastActivity = Date.now(); // restart isn't idleness
      s.groupId = raw.groupId ?? null;
      for (const id of raw.owned || []) {
        if (await tabExists(id)) s.owned.add(id);
      }
      for (const [id, origin] of raw.adopted || []) {
        if (await tabExists(id)) s.adopted.set(id, origin);
      }
      if (s.groupId != null) {
        try {
          await api().tabGroups.get(s.groupId);
        } catch (_) {
          s.groupId = null;
        }
      }
      if (s.owned.size || s.adopted.size) clients.set(clientId, s);
    }
    await persist();
  }

  function ready() {
    if (!readyPromise) readyPromise = hydrate().catch(() => {});
    return readyPromise;
  }

  // ── state helpers ───────────────────────────────────────────

  function newState() {
    return {
      groupId: null,
      owned: new Set(),
      adopted: new Map(),
      lastActivity: Date.now(),
      inflight: 0,
    };
  }

  function stateFor(clientId) {
    let s = clients.get(clientId);
    if (!s) {
      s = newState();
      clients.set(clientId, s);
    }
    return s;
  }

  function beginCall(clientId) {
    if (!clientId) return;
    const s = clients.get(clientId);
    if (!s) return;
    s.inflight += 1;
    s.lastActivity = Date.now();
  }

  function endCall(clientId) {
    if (!clientId) return;
    const s = clients.get(clientId);
    if (!s) return;
    s.inflight = Math.max(0, s.inflight - 1);
    s.lastActivity = Date.now();
  }

  function touch(clientId) {
    const s = clientId && clients.get(clientId);
    if (s) s.lastActivity = Date.now();
  }

  function ownsTab(clientId, tabId) {
    const s = clients.get(clientId);
    return !!s && (s.owned.has(tabId) || s.adopted.has(tabId));
  }

  function isOwnedByAnyClient(tabId) {
    for (const s of clients.values()) if (s.owned.has(tabId)) return true;
    return false;
  }

  function clientOwning(tabId) {
    for (const [clientId, s] of clients) {
      if (s.owned.has(tabId) || s.adopted.has(tabId)) return clientId;
    }
    return null;
  }

  function managedTabIds(clientId) {
    const s = clients.get(clientId);
    return s ? new Set([...s.owned, ...s.adopted.keys()]) : new Set();
  }

  function list(clientId) {
    const s = clients.get(clientId);
    return {
      groupId: s?.groupId ?? null,
      owned: s ? [...s.owned] : [],
      adopted: s ? [...s.adopted.keys()] : [],
    };
  }

  function snapshot() {
    const out = [];
    for (const [clientId, s] of clients) {
      out.push({
        clientId,
        groupId: s.groupId,
        owned: [...s.owned],
        adopted: [...s.adopted.keys()],
        idleForMs: Date.now() - s.lastActivity,
      });
    }
    return out;
  }

  // ── grouping ────────────────────────────────────────────────

  async function groupIsAlive(groupId) {
    if (groupId == null) return false;
    try {
      await api().tabGroups.get(groupId);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Put a tab into this client's group, creating the group on first use.
  // Grouping is best-effort: pinned tabs and popup windows can't be
  // grouped, but the tab stays tracked so release() still cleans it up.
  async function groupTab(s, tabId) {
    try {
      if (!(await groupIsAlive(s.groupId))) s.groupId = null;
      if (s.groupId == null) {
        s.groupId = await api().tabs.group({ tabIds: [tabId] });
        await api().tabGroups.update(s.groupId, {
          title: GROUP_TITLE,
          color: GROUP_COLOR,
          collapsed: false,
        });
      } else {
        await api().tabs.group({ groupId: s.groupId, tabIds: [tabId] });
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function pickWindowId(s) {
    if (await groupIsAlive(s.groupId)) {
      try {
        return (await api().tabGroups.get(s.groupId)).windowId;
      } catch (_) {}
    }
    try {
      const win = await api().windows.getLastFocused({
        windowTypes: ["normal"],
      });
      return win?.id;
    } catch (_) {
      return undefined;
    }
  }

  /** Open a background tab in the client's AutoDOM group. */
  async function createOwnedTab(clientId, { url } = {}) {
    await ready();
    const s = stateFor(clientId);
    const props = { url: url || "about:blank", active: false };
    const windowId = await pickWindowId(s);
    if (windowId != null) props.windowId = windowId;
    const tab = await api().tabs.create(props);
    s.owned.add(tab.id);
    s.lastActivity = Date.now();
    await groupTab(s, tab.id);
    await persist();
    return api().tabs.get(tab.id).catch(() => tab);
  }

  /**
   * Track a tab AutoDOM did not create but is explicitly asked to use:
   * remember where it was, then move it into the group. No activation.
   */
  async function adoptTab(clientId, tabId) {
    await ready();
    const s = stateFor(clientId);
    if (s.owned.has(tabId) || s.adopted.has(tabId)) {
      return { adopted: false, already: true };
    }
    const tab = await api().tabs.get(tabId);
    const origin = {
      windowId: tab.windowId,
      index: tab.index,
      groupId: tab.groupId ?? NO_GROUP,
      pinned: !!tab.pinned,
    };
    if (origin.groupId !== NO_GROUP) {
      // Grouping the tab elsewhere dissolves its old group if it was the
      // only member; keep the look so release can rebuild it.
      try {
        const g = await api().tabGroups.get(origin.groupId);
        origin.group = { title: g.title, color: g.color, collapsed: !!g.collapsed };
      } catch (_) {}
    }
    s.adopted.set(tabId, origin);
    s.lastActivity = Date.now();
    if (!tab.pinned) await groupTab(s, tabId);
    await persist();
    return { adopted: true };
  }

  /** Treat a tab opened by one of our tabs as ours. */
  async function claimTab(clientId, tabId) {
    await ready();
    const s = stateFor(clientId);
    if (s.owned.has(tabId) || s.adopted.has(tabId)) return;
    s.owned.add(tabId);
    s.lastActivity = Date.now();
    await groupTab(s, tabId);
    await persist();
  }

  // ── release ─────────────────────────────────────────────────

  async function restoreAdopted(tabId, origin) {
    let tab;
    try {
      tab = await api().tabs.get(tabId);
    } catch (_) {
      return false; // user closed it — nothing to restore
    }
    try {
      if ((tab.groupId ?? NO_GROUP) !== NO_GROUP) {
        await api().tabs.ungroup([tabId]);
      }
    } catch (_) {}
    try {
      await api().tabs.move(tabId, {
        windowId: origin.windowId,
        index: origin.index,
      });
    } catch (_) {}
    if (origin.groupId != null && origin.groupId !== NO_GROUP) {
      try {
        if (await groupIsAlive(origin.groupId)) {
          await api().tabs.group({ groupId: origin.groupId, tabIds: [tabId] });
        } else if (origin.group) {
          // The user's group vanished when this tab left it — rebuild it.
          const gid = await api().tabs.group({ tabIds: [tabId] });
          await api().tabGroups.update(gid, origin.group);
        }
        await api()
          .tabs.move(tabId, { windowId: origin.windowId, index: origin.index })
          .catch(() => {});
      } catch (_) {}
    }
    return true;
  }

  // Close tabs, but never leave a window empty (that would close the
  // window and look like the browser quit): open a background about:blank
  // replacement first, same guard close_tab has.
  async function closeTabs(tabIds) {
    const closed = [];
    const alive = [];
    const tabs = [];
    for (const id of tabIds) {
      try {
        tabs.push(await api().tabs.get(id));
        alive.push(id);
      } catch (_) {}
    }
    const byWindow = new Map();
    for (const t of tabs) {
      byWindow.set(t.windowId, (byWindow.get(t.windowId) || 0) + 1);
    }
    for (const [windowId, count] of byWindow) {
      let total = count;
      try {
        total = (await api().tabs.query({ windowId })).length;
      } catch (_) {}
      if (total <= count) {
        try {
          await api().tabs.create({
            windowId,
            url: "about:blank",
            active: false,
          });
        } catch (_) {
          // Can't guarantee the window survives — leave its tabs alone.
          for (const t of tabs.filter((x) => x.windowId === windowId)) {
            alive.splice(alive.indexOf(t.id), 1);
          }
        }
      }
    }
    for (const id of alive) {
      try {
        await api().tabs.remove(id);
        closed.push(id);
      } catch (_) {}
    }
    return closed;
  }

  /** End a client's session: close owned tabs, restore adopted ones. */
  async function release(clientId, _reason) {
    await ready();
    const s = clients.get(clientId);
    if (!s) return { closed: [], restored: [] };
    clients.delete(clientId); // first, so re-entrant onRemoved is a no-op
    const restored = [];
    for (const [tabId, origin] of s.adopted) {
      if (await restoreAdopted(tabId, origin)) restored.push(tabId);
    }
    const closed = await closeTabs([...s.owned]);
    await persist();
    return { closed, restored };
  }

  async function releaseAll(reason) {
    const out = { closed: [], restored: [] };
    for (const clientId of [...clients.keys()]) {
      const r = await release(clientId, reason);
      out.closed.push(...r.closed);
      out.restored.push(...r.restored);
    }
    return out;
  }

  /** Release a single tab: adopted → restored, owned → left in group. */
  async function releaseAdopted(clientId, tabId) {
    await ready();
    const s = clients.get(clientId);
    const origin = s?.adopted.get(tabId);
    if (!s || !origin) return false;
    s.adopted.delete(tabId);
    const ok = await restoreAdopted(tabId, origin);
    await persist();
    return ok;
  }

  /** close_tab on a managed tab. Owned → closed; adopted → restored only. */
  async function closeManagedTab(clientId, tabId, { force } = {}) {
    await ready();
    const s = clients.get(clientId);
    if (!s) return { handled: false };
    if (s.adopted.has(tabId) && !force) {
      await releaseAdopted(clientId, tabId);
      return { handled: true, restored: true };
    }
    if (s.adopted.has(tabId)) s.adopted.delete(tabId);
    s.owned.delete(tabId);
    await persist();
    return { handled: false };
  }

  // ── idle sweep / listeners ──────────────────────────────────

  async function sweepIdle(now = Date.now()) {
    if (!idleMs) return [];
    const released = [];
    for (const [clientId, s] of [...clients]) {
      if (s.inflight > 0) continue;
      if (now - s.lastActivity >= idleMs) {
        await release(clientId, "idle");
        released.push(clientId);
      }
    }
    return released;
  }

  function onTabRemoved(tabId) {
    let changed = false;
    for (const [clientId, s] of clients) {
      if (s.owned.delete(tabId)) changed = true;
      if (s.adopted.delete(tabId)) changed = true;
      if (!s.owned.size && !s.adopted.size) {
        clients.delete(clientId);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function onGroupRemoved(groupId) {
    for (const s of clients.values()) {
      if (s.groupId === groupId) s.groupId = null;
    }
  }

  // Pages our tabs open (target=_blank, window.open) belong to the session
  // too, otherwise they'd outlive release().
  function onTabCreated(tab) {
    const opener = tab?.openerTabId;
    if (opener == null) return;
    for (const [clientId, s] of clients) {
      if (s.owned.has(opener) && !s.owned.has(tab.id)) {
        claimTab(clientId, tab.id).catch(() => {});
        return;
      }
    }
  }

  function install() {
    const c = api();
    if (!c || !supported()) return;
    try {
      c.tabs.onRemoved?.addListener(onTabRemoved);
      c.tabs.onCreated?.addListener(onTabCreated);
      c.tabGroups.onRemoved?.addListener((g) => onGroupRemoved(g.id));
    } catch (_) {}
  }

  install();

  globalThis.AutoDOMTabGroup = {
    STORAGE_KEY,
    SETTING_KEY,
    DEFAULT_IDLE_MS,
    supported,
    isEnabled,
    configure,
    ready,
    hydrate,
    createOwnedTab,
    adoptTab,
    claimTab,
    ownsTab,
    isOwnedByAnyClient,
    clientOwning,
    managedTabIds,
    list,
    snapshot,
    beginCall,
    endCall,
    touch,
    release,
    releaseAll,
    releaseAdopted,
    closeManagedTab,
    sweepIdle,
    onTabRemoved,
    onTabCreated,
    onGroupRemoved,
  };
})();
