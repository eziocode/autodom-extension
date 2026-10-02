import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../extension/background/feature-flags.js"),
  "utf8",
);

const plain = (x) => JSON.parse(JSON.stringify(x));

// Minimal promise-style chrome.storage.local with onChanged support.
function makeChrome(seed) {
  const local = new Map(Object.entries(seed || {}));
  const listeners = [];
  let reads = 0;
  const chrome = {
    runtime: {},
    storage: {
      local: {
        async get(keys) {
          reads++;
          const out = {};
          for (const k of [].concat(keys)) if (local.has(k)) out[k] = structuredClone(local.get(k));
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: local.get(k), newValue: structuredClone(v) };
            local.set(k, structuredClone(v));
          }
          for (const fn of listeners) fn(changes, "local");
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  return { chrome, local, get reads() { return reads; }, fire: (c) => listeners.forEach((fn) => fn(c, "local")) };
}

function load(seed) {
  const env = makeChrome(seed);
  const ctx = { chrome: env.chrome, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { F: ctx.AutoDOMFeatures, env };
}

test("normalize fills every default from empty or garbage input", () => {
  const { F } = load();
  assert.equal(F.KEY, "autodom.features");
  for (const input of [undefined, null, 42, "x", {}]) {
    assert.deepEqual(plain(F.normalize(input)), plain(F.DEFAULTS));
  }
  assert.equal(F.DEFAULTS.visionHeal, "auto");
  assert.equal(F.DEFAULTS.defaultRunMode, "heal");
  assert.equal(F.DEFAULTS.parallelConcurrency, 3);
  assert.equal(F.DEFAULTS.runHistoryLimit, 50);
  assert.equal(F.DEFAULTS.perfMode, "fast");
  assert.equal(F.DEFAULTS.toolLanes, true);
  assert.equal(F.DEFAULTS.compactSnapshotsDefault, false);
});

test("normalize clamps numeric ranges and rounds", () => {
  const { F } = load();
  assert.equal(F.normalize({ parallelConcurrency: 0 }).parallelConcurrency, 1);
  assert.equal(F.normalize({ parallelConcurrency: 99 }).parallelConcurrency, 5);
  assert.equal(F.normalize({ parallelConcurrency: "4" }).parallelConcurrency, 4);
  assert.equal(F.normalize({ parallelConcurrency: 2.6 }).parallelConcurrency, 3);
  assert.equal(F.normalize({ parallelConcurrency: "nope" }).parallelConcurrency, 3);
  assert.equal(F.normalize({ runHistoryLimit: 1 }).runHistoryLimit, 10);
  assert.equal(F.normalize({ runHistoryLimit: 5000 }).runHistoryLimit, 200);
  assert.equal(F.normalize({ runHistoryLimit: null }).runHistoryLimit, 50);
  assert.equal(F.normalize({ runHistoryLimit: "" }).runHistoryLimit, 50);
});

test("normalize rejects unknown enum values and non-boolean toggles", () => {
  const { F } = load();
  const n = F.normalize({
    visionHeal: "sometimes",
    defaultRunMode: "dry",
    perfMode: "turbo",
    undoTracking: "false",
    overlaySessionBorder: 0,
    webmcp: false,
    extra: "dropped",
  });
  assert.equal(n.visionHeal, "auto");
  assert.equal(n.defaultRunMode, "heal");
  assert.equal(n.perfMode, "fast");
  assert.equal(n.undoTracking, true);
  assert.equal(n.overlaySessionBorder, true);
  assert.equal(n.webmcp, false);
  assert.equal("extra" in n, false);
  const ok = F.normalize({ visionHeal: "off", defaultRunMode: "strict", perfMode: "balanced" });
  assert.equal(ok.visionHeal, "off");
  assert.equal(ok.defaultRunMode, "strict");
  assert.equal(ok.perfMode, "balanced");
});

test("get caches until storage.onChanged invalidates it", async () => {
  const { F, env } = load({ "autodom.features": { visionHeal: "on" } });
  assert.equal((await F.get()).visionHeal, "on");
  const readsAfterFirst = env.reads;
  await F.get();
  assert.equal(env.reads, readsAfterFirst, "second get is served from cache");
  env.local.set("autodom.features", { visionHeal: "off" });
  env.fire({ "autodom.features": { newValue: { visionHeal: "off" } } });
  assert.equal((await F.get()).visionHeal, "off");
});

test("set merges, normalizes and persists", async () => {
  const { F, env } = load({ "autodom.features": { perfMode: "balanced" } });
  const next = await F.set({ parallelConcurrency: 12, toolLanes: false });
  assert.equal(next.parallelConcurrency, 5);
  assert.equal(next.toolLanes, false);
  assert.equal(next.perfMode, "balanced");
  assert.deepEqual(plain(env.local.get("autodom.features")), plain(next));
  assert.equal((await F.get()).toolLanes, false);
});

test("works without chrome.storage (returns defaults)", async () => {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.deepEqual(plain(await ctx.AutoDOMFeatures.get()), plain(ctx.AutoDOMFeatures.DEFAULTS));
});
