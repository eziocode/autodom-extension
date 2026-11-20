import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const src = readFileSync(new URL("../extension/background/playback.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

// Deterministic renderer clock. A canvas captures the current source color on
// drawImage; deferred WebP completion can therefore expose timestamp misalignment.
function fixture({ video = true, paused = false, hidden = false, drm = false, taint = false,
  encodeMs = 1, blobSize = 32, withRvfc = true, webCodecs = false } = {}) {
  let now = 0, seq = 0, callback = null;
  const tasks = new Map();
  function later(fn, ms, interval = false) {
    const id = ++seq;
    tasks.set(id, { fn, at: now + ms, interval: interval ? ms : 0 });
    return id;
  }
  function step(to) {
    for (;;) {
      const [id, task] = [...tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] || [];
      if (!task || task.at > to) break;
      now = task.at;
      if (task.interval) task.at += task.interval;
      else tasks.delete(id);
      task.fn();
    }
    now = to;
  }
  const el = Object.assign(new EventTarget(), { tagName: video ? "VIDEO" : "AUDIO", paused,
    currentTime: 3, playbackRate: 1.5, currentSrc: "a.mp4", srcObject: null, mediaKeys: drm ? {} : null,
    videoWidth: 1280, videoHeight: 720, color: 40, textTracks: [],
    dropped: 0, total: 0,
    getVideoPlaybackQuality() { return { droppedVideoFrames: this.dropped, totalVideoFrames: this.total }; } });
  if (video && withRvfc) Object.assign(el, {
    requestVideoFrameCallback(fn) { callback = fn; return 1; },
    cancelVideoFrameCallback() { callback = null; }
  });
  const document = Object.assign(new EventTarget(), { children: [el], hidden, createElement() {
    const node = { color: null,
      toBlob(fn, type) {
        const color = node.color;
        later(() => fn({ type, size: blobSize, color }), encodeMs);
      },
      getContext() { return {
        drawImage(source) { node.color = source.color; },
        getImageData() {
          if (taint) { const e = new Error("taint"); e.name = "SecurityError"; throw e; }
          const data = new Uint8ClampedArray(4 * 144);
          data.fill(node.color);
          return { data };
        }
      }; }
    };
    return node;
  } });
  class FileReader {
    readAsDataURL(blob) {
      this.result = "data:image/webp;base64," + Buffer.from([blob.color]).toString("base64");
      this.onload();
    }
  }
  let createdFrames = 0, closedFrames = 0;
  class VideoFrame {
    constructor(video) {
      createdFrames++;
      this.color = video.snapshotColor ?? video.color;
      this.timestamp = Math.round((video.snapshotTime ?? video.currentTime) * 1e6);
    }
    close() { closedFrames++; }
  }
  const sandbox = { document, ...(webCodecs && { VideoFrame }), performance: { now: () => now }, FileReader,
    Date: class extends Date { static now() { return 1700000000000 + now; } },
    setTimeout: later, clearTimeout: id => tasks.delete(id),
    setInterval: (fn, ms) => later(fn, ms, true), clearInterval: id => tasks.delete(id) };
  vm.runInNewContext(src, sandbox);
  const op = (name, args = {}) => sandbox.AutoDOMPlayback.playbackPage(name, { verificationId: "one", ...args });
  return { el, document, op, step, closedFrames: () => closedFrames, createdFrames: () => createdFrames,
    start(mode = "smart", durationSec = 2) {
      op("arm", { eventName: "fixture-pin" });
      const event = new Event("fixture-pin");
      event.composedPath = () => [el, document];
      document.dispatchEvent(event);
      return op("observe", { tag: el.tagName, mode, durationSec });
    },
    frame(ms, count, t, color = 40) {
      step(ms);
      el.currentTime = t;
      el.total = count;
      el.color = color;
      callback?.(ms, { mediaTime: t, presentedFrames: count });
    }
  };
}

test("smart pins images to observed timestamps, keeps single-frame change and neighbors; stills progress", async () => {
  const f = fixture();
  const promise = f.start();
  const times = [30, 60, 90, 120, 150, 185, 502, 780, 999.9, 1000, 1100, 1400, 1700, 1950];
  times.forEach((ms, i) => f.frame(ms, i + 10, 3 + ms / 1000, i === 3 ? 200 : 40));
  f.step(2010);
  const manifest = await promise;
  assert.equal(manifest.health, "progressing");
  assert.deepEqual(plain(manifest.chunks.map(c => c.observed)), [9, 5]);
  assert.equal(manifest.counters.observed, 14);
  assert.equal(manifest.counters.skippedEncodes, 0);
  assert.ok(manifest.counters.images < manifest.counters.observed);
  const frames = (await f.op("read", { elapsedSec: 0.118 })).frames;
  assert.ok(frames.every(f => f.signature));
  const colors = frames.map(x => x.dataUrl ? Buffer.from(x.dataUrl.split(",")[1], "base64")[0] : null);
  assert.deepEqual(plain(colors.slice(2, 5)), [40, 200, 40]);
  assert.equal(frames[3].mediaTime, 3.12);
  assert.equal(frames[8].chunkIndex, 0);
  const last = await f.op("read", { chunkIndex: 1 });
  assert.equal(last.frames.at(-1).imageReason, "end");
  assert.equal(last.frames.at(-1).imageStatus, "retained");
  assert.equal(f.el.paused, false);
  assert.equal(f.el.playbackRate, 1.5);
  assert.equal(f.el.currentTime, 4.95);
  f.step(123000);
  assert.equal((await f.op("read")).ok, false);
});

test("detailed records per-frame WebP, gaps separate from decoder drops, pages include missing-image metadata", async () => {
  const f = fixture({ encodeMs: 200 });
  const promise = f.start("detailed", 1);
  for (let i = 0; i < 10; i++) {
    if (i === 5) f.el.dropped = 2;
    f.frame(10 + i * 20, i + (i >= 4 ? 5 : 2), i / 50, i);
  }
  for (let i = 0; i < 3; i++) f.frame(500 + i * 200, 16 + i, 0.5 + i * 0.2, i + 10);
  f.step(1300);
  const m = await promise;
  assert.ok(m.skipReasons["queue-full"] > 0);
  assert.equal(m.counters.missedCallbacks, 4);
  assert.equal(m.decoder.dropped, 2);
  assert.equal(m.counters.images + m.counters.skippedEncodes, m.counters.observed);
  const page1 = await f.op("read", { limit: 5 });
  assert.equal(page1.nextOffset, 5);
  assert.equal(page1.frames[3].skipReason, "queue-full");
  const page2 = await f.op("read", { offset: 5, limit: 100 });
  assert.equal(page2.frames[0].browserDrops, 2);
  assert.ok(page2.frames.every(x => Number.isFinite(x.mediaTime)));
});

test("bounded evidence prioritizes timing; paged image reads respect byte and image limits", async () => {
  const f = fixture({ blobSize: 128 * 1024 });
  const promise = f.start("detailed", 3);
  for (let i = 0; i < 150; i++) f.frame(8 + i * 19, i + 1, i / 50);
  f.step(3050);
  const m = await promise;
  assert.equal(m.counters.observed, 150);
  assert.ok(m.peakRetainedBytes <= 16 * 1024 * 1024);
  assert.ok(m.skipReasons["byte-budget"] > 0);
  assert.equal(m.counters.images + m.counters.skippedEncodes, 150);
  const page = await f.op("read", { limit: 100 });
  assert.equal(page.frames.length, 2);
  assert.equal(page.nextOffset, 2);
  assert.equal((await f.op("read", { chunkIndex: 0, offset: 999 })).ok, false);
});

test("seek and source changes create segments, media time can repeat, active captions remain unchanged", async () => {
  const f = fixture();
  const track = Object.assign(new EventTarget(), { kind: "captions", language: "en", mode: "showing",
    activeCues: [{ startTime: 3, endTime: 5, text: "One" }] });
  f.el.textTracks.push(track);
  const promise = f.start();
  f.frame(40, 50, 4);
  f.step(90);
  f.el.dispatchEvent(new Event("seeking"));
  f.frame(110, 54, 3);
  f.frame(300, 55, 3.2);
  f.el.currentSrc = "b.mp4";
  f.frame(1200, 1, 3);
  f.frame(1500, 2, 3.2);
  f.step(2080);
  const m = await promise;
  assert.equal(m.counters.missedCallbacks, 0);
  const a = await f.op("read");
  const b = await f.op("read", { elapsedSec: 1.5 });
  assert.deepEqual(plain(a.frames.map(x => x.segment)), [0, 1, 1]);
  assert.equal(b.frames[0].segment, 2);
  assert.equal(b.frames[0].mediaTime, a.frames[1].mediaTime);
  assert.equal(b.captions[0].text, "One");
  assert.equal(track.mode, "showing");
});

test("stalls count without frames; paused, hidden, clock-only, protected, tainted and audio coverage explicit", async () => {
  for (const options of [{}, { paused: true }, { hidden: true }, { drm: true }, { taint: true }, { video: false }, { withRvfc: false }]) {
    const f = fixture(options);
    const promise = f.start("detailed", 1);
    if (options.drm || options.taint || !f.el.requestVideoFrameCallback) {
      f.frame(100, 1, 3.1);
      f.frame(400, 2, 3.4);
      f.frame(800, 3, 3.8);
    }
    f.step(1001);
    const m = await promise;
    if (!Object.keys(options).length) { assert.equal(m.health, "stalled"); assert.ok(m.stallSec >= 0.9); }
    if (options.paused) assert.equal(m.health, "paused");
    if (options.hidden) { assert.ok(m.coverage.includes("hidden-tab")); assert.equal(m.stallSec, 0); }
    if (options.drm || options.taint) {
      assert.ok(m.coverage.includes(options.drm ? "protected-video" : "unreadable-pixels"));
      assert.equal(m.counters.images, 0);
      assert.equal(m.counters.observed, 3);
    }
    if (options.video === false) assert.ok(m.coverage.includes("audio-only"));
    if (options.withRvfc === false) assert.equal(m.health, "clock-progress-only");
    assert.equal(m.audibleOutput, "unverified");
  }
});

test("cancel stops observation immediately and removes renderer evidence", async () => {
  const f = fixture();
  const pending = f.start();
  f.frame(100, 20, 3.1);
  await f.op("release");
  assert.equal((await pending).ok, false);
  f.step(2500);
  assert.equal((await f.op("read")).ok, false);
});

test("immutable WebCodecs surfaces pair by PTS, report mismatches, and close each surface", async () => {
  const f = fixture({ webCodecs: true });
  const promise = f.start("detailed", 1);
  // Snapshot is already ahead at the callback for t=.10.
  f.el.snapshotTime = 0.15;
  f.el.snapshotColor = 190;
  f.frame(100, 1, 0.10, 40);
  f.el.snapshotTime = 0.20;
  f.el.snapshotColor = 60;
  f.frame(150, 2, 0.15, 190);
  f.el.snapshotTime = 0.25;
  f.frame(200, 3, 0.20, 60);
  f.el.snapshotTime = 0.29;
  f.frame(250, 4, 0.25, 60);
  f.step(1060);
  const m = await promise;
  assert.equal(m.counters.images, 3);
  assert.equal(m.skipReasons["pixel-timestamp-mismatch"], 1);
  const rows = (await f.op("read")).frames;
  assert.equal(rows[0].dataUrl, undefined);
  assert.equal(rows[1].pixelMediaTime, rows[1].mediaTime);
  assert.equal(rows[1].pixelAlignment, "verified-pts");
  assert.equal(Buffer.from(rows[1].dataUrl.split(",")[1], "base64")[0], 190);
  assert.equal(f.closedFrames(), f.createdFrames());
  assert.ok(m.chunks[0].highlights.find(h => h.mediaTime === .15 && h.offset === 1));
});

test("a coalesced callback recovers only real intermediate surfaces, at their original timestamps", async () => {
  const f = fixture({ webCodecs: true });
  const promise = f.start("detailed", 1);
  f.frame(10, 20, .010, 40);
  f.frame(27, 21, .027, 50);
  f.step(42);
  f.el.currentTime = .044;
  f.el.color = 240;
  f.frame(61, 23, .061, 60);
  f.frame(101, 26, .101, 70); // No intermediate surfaces available for these two.
  f.step(1050);
  const m = await promise;
  assert.equal(m.counters.missedCallbacks, 3);
  assert.equal(m.counters.recoveredFrames, 1);
  assert.equal(m.counters.unrecoveredCallbacks, 2);
  const rows = (await f.op("read")).frames;
  assert.deepEqual(plain(rows.map(r => r.mediaTime)), [.01, .027, .044, .061, .101]);
  assert.equal(rows[2].presentedFrames, null);
  assert.equal(rows[2].pixelMediaTime, .044);
  assert.equal(Buffer.from(rows[2].dataUrl.split(",")[1], "base64")[0], 240);
});

test("pins first and last live pixels across observation boundaries and releases probes", async () => {
  const f = fixture({ webCodecs: true });
  f.el.readyState = 4;
  const promise = f.start("detailed", 1);
  f.frame(20, 1, 3.017, 120);
  f.frame(45, 2, 3.034, 160);
  f.step(980);
  f.el.currentTime = 3.051;
  f.el.color = 220;
  f.step(1020);
  const m = await promise;
  assert.deepEqual(plain(m.pixelWindow), { startMediaTime: 3, endMediaTime: 3.051 });
  assert.equal(m.counters.edgeFrames, 2);
  assert.equal(m.counters.missedCallbacks, 0);
  const rows = (await f.op("read")).frames;
  assert.deepEqual(plain(rows.map(r => r.pixelMediaTime)), [3, 3.017, 3.034, 3.051]);
  assert.equal(f.closedFrames(), f.createdFrames());
  const created = f.createdFrames();
  f.step(10300);
  assert.equal(f.createdFrames(), created);
});

function workerHarness() {
  const saved = {}, pages = new Map(), calls = [];
  const session = {
    async get(key) { return { [key]: structuredClone(saved[key]) }; },
    async set(items) { Object.assign(saved, structuredClone(items)); },
    async remove(key) { delete saved[key]; }
  };
  const execute = async (tab, fn, [op, args], world, frame, doc) => {
    calls.push([op, tab, world, frame, doc]);
    if (op === "arm") return { ok: true };
    if (op === "observe") {
      pages.set(args.verificationId, true);
      return { ok: true, verificationId: args.verificationId, expiresAt: Date.now() + 120000 };
    }
    if (op === "release") pages.delete(args.verificationId);
    return { ok: op === "release" || pages.has(args.verificationId) };
  };
  function reboot() {
    const sandbox = { chrome: { storage: { session } }, crypto: { randomUUID },
      setTimeout: () => 1, clearTimeout() {}, Date };
    vm.runInNewContext(src, sandbox);
    sandbox.AutoDOMPlayback.configure(execute);
    return sandbox.AutoDOMPlayback;
  }
  return { saved, pages, calls, execute, reboot };
}

test("completed verification survives worker restart, enforces ownership, and cleans only replaced documents", async () => {
  const h = workerHarness(), api = h.reboot();
  const alice = { origin: "bridge", clientId: "alice" }, bob = { origin: "bridge", clientId: "bob" };
  const create = (ctx, documentId) => api.verify({ callCtx: ctx, tab: { id: 9 }, args: { frameId: 3, documentId },
    found: { tag: "VIDEO" }, bindTarget: async () => ({ ok: true }), executeInTab: h.execute });
  const { verificationId } = await create(alice, "doc-a");
  const bobId = (await create(bob, "doc-b")).verificationId;
  assert.ok(JSON.stringify(h.saved).includes("doc-a"));
  assert.ok(!JSON.stringify(h.saved).includes("dataUrl"));
  const restored = h.reboot();
  assert.equal((await restored.read({ verificationId }, bob)).ok, false);
  assert.equal((await restored.read({ verificationId, offset: -2 }, alice)).ok, false);
  assert.equal((await restored.read({ verificationId }, alice)).ok, true);
  await restored.clearTab(9, 3, "doc-b");
  assert.equal((await restored.read({ verificationId }, alice)).ok, false);
  assert.equal((await restored.read({ verificationId: bobId }, bob)).ok, true);
  assert.deepEqual(h.calls.at(-1), ["read", 9, "ISOLATED", 3, "doc-b"]);
  const another = h.reboot();
  await another.clearSession(bob);
  assert.equal(h.pages.size, 0);
  assert.deepEqual(h.saved, {});
});

test("session end during observation cannot publish a completed handle", async () => {
  const h = workerHarness(), api = h.reboot();
  let start, finish;
  const began = new Promise(resolve => { start = resolve; });
  const pendingPage = new Promise(resolve => { finish = resolve; });
  const ctx = { origin: "bridge", clientId: "one" };
  const pending = api.verify({ callCtx: ctx, tab: { id: 7 }, args: {}, found: { tag: "VIDEO" }, bindTarget: async () => ({ ok: true }),
    executeInTab: async (...args) => {
      if (args[2][0] !== "observe") return h.execute(...args);
      start(); return pendingPage;
    } });
  await began;
  await api.clearSession(ctx);
  finish({ ok: true, expiresAt: Date.now() + 120000 });
  assert.equal((await pending).ok, false);
  assert.deepEqual(h.saved, {});
});

test("same-tag replacement after binding cannot inherit observation, and an unconsumed arm expires", async () => {
  const f = fixture();
  await f.op("arm", { eventName: "one-use" });
  const event = new Event("one-use");
  event.composedPath = () => [f.el, f.document];
  f.document.dispatchEvent(event);
  const replacement = { tagName: "VIDEO", isConnected: true };
  f.document.children[0] = replacement;
  f.el.isConnected = false;
  // Re-dispatching the event cannot replace the already bound reference.
  const replay = new Event("one-use");
  replay.composedPath = () => [replacement, f.document];
  f.document.dispatchEvent(replay);
  assert.equal((await f.op("observe", { tag: "VIDEO", mode: "smart", durationSec: 1 })).ok, false);
  await f.op("arm", { eventName: "abandoned" });
  f.step(5100);
  assert.equal((await f.op("observe", { tag: "VIDEO", mode: "smart", durationSec: 1 })).ok, false);
});
