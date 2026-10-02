import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../extension/background/tab-isolation.js"),
  "utf8",
);
const swSrc = readFileSync(
  resolve(here, "../extension/background/service-worker.js"),
  "utf8",
);

const plain = (x) => JSON.parse(JSON.stringify(x));

// Minimal in-memory chrome.tabs / tabGroups / windows / storage.
function makeChrome({ withGroups = true, sessionSeed } = {}) {
  let nextTab = 100;
  let nextGroup = 1;
  const tabs = new Map();
  const groups = new Map();
  const local = new Map();
  const session = new Map(Object.entries(sessionSeed || {}));
  const created = [];
  const removed = [];
  const listeners = { tabRemoved: [], tabCreated: [], groupRemoved: [] };

  const store = (m) => ({
    async get(key) {
      return { [key]: m.get(key) };
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v));
    },
  });
  const dropEmptyGroups = () => {
    for (const gid of [...groups.keys()]) {
      if (![...tabs.values()].some((t) => t.groupId === gid)) groups.delete(gid);
    }
  };
  const addTab = (props) => {
    const windowId = props.windowId ?? 1;
    const tab = {
      id: props.id ?? nextTab++,
      windowId,
      index: [...tabs.values()].filter((t) => t.windowId === windowId).length,
      groupId: props.groupId ?? -1,
      pinned: !!props.pinned,
      active: !!props.active,
      url: props.url || "about:blank",
      openerTabId: props.openerTabId,
    };
    tabs.set(tab.id, tab);
    return tab;
  };

  const chrome = {
    storage: { local: store(local), session: store(session) },
    windows: { async getLastFocused() { return { id: 1 }; } },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabs.get(id) };
      },
      async create(props) {
        created.push(props);
        return { ...addTab(props) };
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        tabs.delete(id);
        removed.push(id);
        dropEmptyGroups();
        listeners.tabRemoved.forEach((fn) => fn(id));
      },
      async query(q = {}) {
        return [...tabs.values()]
          .filter((t) => q.windowId == null || t.windowId === q.windowId)
          .map((t) => ({ ...t }));
      },
      async group({ tabIds, groupId }) {
        let gid = groupId;
        if (gid == null) {
          gid = nextGroup++;
          groups.set(gid, { id: gid, windowId: tabs.get(tabIds[0]).windowId });
        } else if (!groups.has(gid)) {
          throw new Error("No group");
        }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t.pinned) throw new Error("Cannot group pinned tab");
          t.groupId = gid;
        }
        dropEmptyGroups();
        return gid;
      },
      async ungroup(ids) {
        for (const id of ids) tabs.get(id).groupId = -1;
        dropEmptyGroups();
      },
      async move(id, { windowId, index }) {
        const t = tabs.get(id);
        if (windowId != null) t.windowId = windowId;
        if (index != null) t.index = index;
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onCreated: { addListener: (fn) => listeners.tabCreated.push(fn) },
    },
  };
  if (withGroups) {
    chrome.tabGroups = {
      async get(id) {
        if (!groups.has(id)) throw new Error("No group");
        return { ...groups.get(id) };
      },
      async update(id, props) {
        Object.assign(groups.get(id), props);
      },
      onRemoved: { addListener: (fn) => listeners.groupRemoved.push(fn) },
    };
  }
  return { chrome, tabs, groups, local, session, created, removed, listeners, addTab };
}

function load(opts) {
  const env = makeChrome(opts);
  const ctx = { chrome: env.chrome, Date, Promise, JSON, Math, Number, Map, Set, Array, Object };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  return { ...env, Tab: ctx.AutoDOMTabGroup };
}

test("tab groups unavailable → isolation disabled", async () => {
  const { Tab } = load({ withGroups: false });
  assert.equal(Tab.supported(), false);
  assert.equal(await Tab.isEnabled(), false);
});

test("isolation defaults on and follows the popup setting", async () => {
  const { Tab, chrome } = load();
  assert.equal(await Tab.isEnabled(), true);
  await chrome.storage.local.set({ isolationEnabled: false });
  assert.equal(await Tab.isEnabled(), false);
  await chrome.storage.local.set({ isolationEnabled: true });
  assert.equal(await Tab.isEnabled(), true);
});

test("createOwnedTab opens a background tab in a titled AutoDOM group", async () => {
  const { Tab, tabs, groups, created } = load();
  const a = await Tab.createOwnedTab("c1", { url: "https://example.com" });
  const b = await Tab.createOwnedTab("c1", { url: "https://example.org" });
  assert.equal(created[0].active, false, "must never activate");
  assert.equal(created[1].active, false);
  assert.equal(created[0].url, "https://example.com");
  assert.equal(a.groupId, b.groupId, "same client → same group");
  assert.notEqual(a.groupId, -1);
  const group = groups.get(a.groupId);
  assert.equal(group.title, "AutoDOM");
  assert.equal(group.collapsed, false);
  assert.deepEqual(plain(Tab.list("c1").owned), [a.id, b.id]);
  assert.equal(tabs.size, 2);
});

test("separate clients get separate groups", async () => {
  const { Tab } = load();
  const a = await Tab.createOwnedTab("c1", {});
  const b = await Tab.createOwnedTab("c2", {});
  assert.notEqual(a.groupId, b.groupId);
  assert.equal(Tab.clientOwning(a.id), "c1");
  assert.equal(Tab.clientOwning(b.id), "c2");
});

test("release closes owned tabs and restores adopted tabs to their original spot", async () => {
  const { Tab, tabs, groups, addTab } = load();
  // The user's window: [u0, u1(in user group 50), u2]
  addTab({ id: 1 });
  groups.set(50, { id: 50, windowId: 1, title: "Reading", color: "red", collapsed: false });
  addTab({ id: 2, groupId: 50 });
  addTab({ id: 3 });
  const before = { ...tabs.get(2) };

  const owned = await Tab.createOwnedTab("c1", { url: "https://a.test" });
  const res = await Tab.adoptTab("c1", 2);
  assert.equal(res.adopted, true);
  assert.notEqual(tabs.get(2).groupId, 50, "adopted tab moves to AutoDOM group");
  assert.equal(tabs.get(2).groupId, owned.groupId);

  const out = await Tab.release("c1", "finish_session");
  assert.deepEqual(plain(out.closed), [owned.id]);
  assert.deepEqual(plain(out.restored), [2]);
  assert.equal(tabs.has(owned.id), false, "owned tab closed");
  const restoredGroup = tabs.get(2).groupId;
  assert.notEqual(restoredGroup, -1, "back in a group");
  assert.equal(groups.get(restoredGroup).title, "Reading", "user's group rebuilt with its title");
  assert.equal(tabs.get(2).index, before.index);
  assert.equal(tabs.get(2).windowId, before.windowId);
  assert.equal(tabs.has(1) && tabs.has(3), true, "other user tabs untouched");
  assert.equal(Tab.snapshot().length, 0);
});

test("adopted tab that was ungrouped ends ungrouped", async () => {
  const { Tab, tabs, addTab } = load();
  addTab({ id: 1 });
  addTab({ id: 2 });
  await Tab.adoptTab("c1", 2);
  assert.notEqual(tabs.get(2).groupId, -1);
  await Tab.release("c1");
  assert.equal(tabs.get(2).groupId, -1);
});

test("pinned user tabs are adopted without being grouped, and never closed", async () => {
  const { Tab, tabs, addTab } = load();
  addTab({ id: 1, pinned: true });
  addTab({ id: 2 });
  const res = await Tab.adoptTab("c1", 1);
  assert.equal(res.adopted, true);
  assert.equal(tabs.get(1).groupId, -1);
  await Tab.release("c1");
  assert.equal(tabs.has(1), true);
});

test("adopting an already-owned tab is a no-op", async () => {
  const { Tab } = load();
  const t = await Tab.createOwnedTab("c1", {});
  const res = await Tab.adoptTab("c1", t.id);
  assert.equal(res.adopted, false);
  assert.deepEqual(plain(Tab.list("c1").adopted), []);
});

test("release never empties a window: opens a background about:blank first", async () => {
  const { Tab, tabs, created } = load();
  // No user tabs at all; the only tab in window 1 is AutoDOM's.
  const t = await Tab.createOwnedTab("c1", {});
  created.length = 0;
  await Tab.release("c1");
  assert.equal(tabs.has(t.id), false);
  assert.equal(created.length, 1);
  assert.equal(created[0].url, "about:blank");
  assert.equal(created[0].active, false);
  assert.equal(tabs.size, 1, "replacement keeps the window alive");
});

test("release is idempotent and tolerates tabs the user already closed", async () => {
  const { Tab, tabs } = load();
  const a = await Tab.createOwnedTab("c1", {});
  await Tab.createOwnedTab("c1", {});
  tabs.delete(a.id); // user closed it by hand
  const first = await Tab.release("c1");
  const second = await Tab.release("c1");
  assert.equal(first.closed.length, 1);
  assert.deepEqual(plain(second), { closed: [], restored: [] });
});

test("closing a tab prunes it; a client with no tabs left is forgotten", async () => {
  const { Tab, tabs, listeners } = load();
  const a = await Tab.createOwnedTab("c1", {});
  tabs.delete(a.id);
  listeners.tabRemoved.forEach((fn) => fn(a.id));
  assert.equal(Tab.snapshot().length, 0);
});

test("user ungrouping the group by hand → next tab recreates it", async () => {
  const { Tab, tabs, listeners } = load();
  const a = await Tab.createOwnedTab("c1", {});
  const oldGroup = a.groupId;
  tabs.get(a.id).groupId = -1;
  listeners.groupRemoved.forEach((fn) => fn({ id: oldGroup }));
  const b = await Tab.createOwnedTab("c1", {});
  assert.notEqual(b.groupId, -1);
  assert.deepEqual(plain(Tab.list("c1").owned), [a.id, b.id], "still owned");
});

test("tabs opened by an owned tab join the session; user-opened tabs do not", async () => {
  const { Tab, tabs, addTab, listeners } = load();
  const owner = await Tab.createOwnedTab("c1", {});
  const child = addTab({ openerTabId: owner.id });
  const userTab = addTab({});
  listeners.tabCreated.forEach((fn) => fn({ ...tabs.get(child.id) }));
  listeners.tabCreated.forEach((fn) => fn({ ...tabs.get(userTab.id) }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(Tab.ownsTab("c1", child.id), true);
  assert.equal(Tab.ownsTab("c1", userTab.id), false);
  await Tab.release("c1");
  assert.equal(tabs.has(child.id), false);
  assert.equal(tabs.has(userTab.id), true);
});

test("idle sweep releases idle sessions but not ones mid-call", async () => {
  const { Tab, tabs } = load();
  Tab.configure({ idleMs: 1000 });
  const idle = await Tab.createOwnedTab("idle", {});
  const busy = await Tab.createOwnedTab("busy", {});
  Tab.beginCall("busy");
  const released = await Tab.sweepIdle(Date.now() + 5000);
  assert.deepEqual(plain(released), ["idle"]);
  assert.equal(tabs.has(idle.id), false);
  assert.equal(tabs.has(busy.id), true);
  Tab.endCall("busy");
  assert.deepEqual(plain(await Tab.sweepIdle(Date.now() + 5000)), ["busy"]);
});

test("idle timeout of 0 disables the sweep", async () => {
  const { Tab } = load();
  Tab.configure({ idleMs: 0 });
  await Tab.createOwnedTab("c1", {});
  assert.deepEqual(plain(await Tab.sweepIdle(Date.now() + 1e9)), []);
});

test("state survives a service-worker restart; dead tabs are dropped", async () => {
  const first = load();
  const a = await first.Tab.createOwnedTab("c1", {});
  const b = await first.Tab.createOwnedTab("c1", {});
  first.addTab({ id: 7 });
  await first.Tab.adoptTab("c1", 7);

  // New worker: same browser tabs, same session storage, b was closed.
  const second = makeChrome({
    sessionSeed: { __autodom_tab_groups: first.session.get("__autodom_tab_groups") },
  });
  for (const t of first.tabs.values()) {
    if (t.id !== b.id) second.addTab({ ...t });
  }
  second.groups.set(a.groupId, { id: a.groupId, windowId: 1 });
  const ctx = { chrome: second.chrome, Date, Promise, JSON, Math, Number, Map, Set, Array, Object };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  await ctx.AutoDOMTabGroup.ready();
  const list = plain(ctx.AutoDOMTabGroup.list("c1"));
  assert.deepEqual(list.owned, [a.id]);
  assert.deepEqual(list.adopted, [7]);
  const out = await ctx.AutoDOMTabGroup.release("c1");
  assert.deepEqual(plain(out.closed), [a.id]);
  assert.deepEqual(plain(out.restored), [7]);
});

test("closeManagedTab on an adopted tab restores instead of closing", async () => {
  const { Tab, tabs, addTab } = load();
  addTab({ id: 1 });
  addTab({ id: 2 });
  await Tab.adoptTab("c1", 2);
  const r = await Tab.closeManagedTab("c1", 2, {});
  assert.equal(r.restored, true);
  assert.equal(tabs.has(2), true);
  assert.equal(tabs.get(2).groupId, -1);
  assert.equal(Tab.ownsTab("c1", 2), false);
});

// ── Source-level guards on the service worker ───────────────────────────

test("service worker loads the isolation module and grants tabGroups", () => {
  assert.match(swSrc, /importScripts\("tab-isolation\.js"\)/);
  const manifest = JSON.parse(
    readFileSync(resolve(here, "../extension/manifest.json"), "utf8"),
  );
  assert.ok(manifest.permissions.includes("tabGroups"));
});

test("tab tools never activate or focus without an explicit opt-in under isolation", () => {
  const body = (name) => {
    const start = swSrc.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    const next = swSrc.indexOf("\nasync function ", start + 10);
    return swSrc.slice(start, next > 0 ? next : start + 6000);
  };
  // Every activate/focus call inside these tools must sit behind an
  // isolation check (or be the legacy branch after the isolated return).
  for (const name of [
    "toolSwitchTab",
    "toolWaitForNewTab",
    "toolSwitchToPopup",
    "toolWaitForPopup",
  ]) {
    const b = body(name);
    assert.match(b, /_isolatedClientId\(ctx\)|isoClient/, `${name} is isolation-aware`);
  }
  // open_new_tab creates through the group helper, in the background.
  assert.match(body("toolOpenNewTab"), /createOwnedTab\(isoClient/);
  // Last-tab replacement must not steal focus under isolation.
  assert.match(body("toolCloseTab"), /active: !isoClient/);
});

test("getActiveTab never falls back to the user's tab for isolated calls", () => {
  const start = swSrc.indexOf("async function getActiveTab(ctx)");
  assert.ok(start > 0, "getActiveTab takes the call context");
  const body = swSrc.slice(start, start + 1800);
  assert.match(body, /ctx\?\.isolated/);
  assert.match(body, /throw new Error\(NO_AUTODOM_TAB_MESSAGE\)/);
  assert.ok(
    body.indexOf("throw new Error(NO_AUTODOM_TAB_MESSAGE)") <
      body.indexOf("chrome.tabs.query"),
    "isolated branch throws before the active-tab query",
  );
  // A call without a context fails closed under isolation, before any
  // active-tab query.
  const ctxless = body.indexOf("if (!ctx)");
  assert.ok(ctxless > 0, "ctx-less branch exists");
  assert.ok(
    body.indexOf("throw new Error(NO_AUTODOM_TAB_MESSAGE)", ctxless) <
      body.indexOf("chrome.tabs.query"),
    "ctx-less branch throws before the active-tab query",
  );
});

test("no tool resolves its tab without the call context", () => {
  const media = readFileSync(
    resolve(here, "../extension/background/media-tools.js"),
    "utf8",
  );
  const engine = readFileSync(
    resolve(here, "../extension/background/workflow-engine.js"),
    "utf8",
  );
  for (const [name, text] of [
    ["service-worker.js", swSrc],
    ["media-tools.js", media],
    ["workflow-engine.js", engine],
  ]) {
    const bare = text.match(/getActiveTab\(\s*\)/g) || [];
    assert.equal(bare.length, 0, `${name} has bare getActiveTab() calls`);
  }
  assert.ok(
    !/_agentRunContext|_withAgentTabContext|_agentBatchDepth/.test(swSrc),
    "no shared global tab context is left in the service worker",
  );
});

test("adopted tab rejoins its original group when that group still exists", async () => {
  const { Tab, tabs, groups, addTab } = load();
  groups.set(50, { id: 50, windowId: 1, title: "Work", color: "green", collapsed: false });
  addTab({ id: 1, groupId: 50 });
  addTab({ id: 2, groupId: 50 });
  await Tab.adoptTab("c1", 2);
  assert.notEqual(tabs.get(2).groupId, 50);
  await Tab.release("c1");
  assert.equal(tabs.get(2).groupId, 50);
  assert.equal(groups.size, 1, "no duplicate group created");
});
