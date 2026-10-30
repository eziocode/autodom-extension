// Behaviour of the page-side media op (_pageMedia) against a small fake
// DOM: detection across shadow roots, primary-video choice, one index
// space for every op, keyframe dedupe/blank/DRM/taint handling, seeks
// that never complete, captions from disabled tracks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../extension/background/media-tools.js"), "utf8");

class FakeMedia {
  constructor(tag, o = {}) {
    this.tagName = tag;
    this.duration = o.duration ?? 40;
    this._t = o.currentTime ?? 0;
    this.paused = o.paused ?? true;
    this.readyState = o.readyState ?? 4;
    this.videoWidth = o.videoWidth ?? (tag === "VIDEO" ? 1920 : 0);
    this.videoHeight = o.videoHeight ?? (tag === "VIDEO" ? 1080 : 0);
    this.rect = o.rect ?? { x: 0, y: 0, width: 640, height: 360 };
    this.style = o.style ?? {};
    this.textTracks = o.textTracks ?? [];
    this.seekable = o.seekable ?? { length: 1, start: () => 0, end: () => this.duration };
    this.mediaKeys = o.mediaKeys ?? null;
    this.tainted = !!o.tainted;
    this.black = !!o.black;
    this.noSeeked = !!o.noSeeked;
    this.currentSrc = o.src ?? "https://cdn.test/v.mp4";
    this.scene = o.scene ?? ((t) => Math.floor(t / 10));
    this.listeners = {};
    this.plays = 0;
    this.muted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.children = [];
  }
  get currentTime() { return this._t; }
  set currentTime(t) {
    this._t = t;
    if (!this.noSeeked) setTimeout(() => (this.listeners.seeked || []).slice().forEach((f) => f()), 0);
  }
  addEventListener(n, f) { (this.listeners[n] ||= []).push(f); }
  removeEventListener(n, f) { this.listeners[n] = (this.listeners[n] || []).filter((x) => x !== f); }
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
  }
  querySelector() { return null; }
}

class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this.drawn = null; }
  getContext() {
    const c = this;
    return {
      drawImage(src) { c.drawn = src; },
      getImageData() {
        const v = c.drawn;
        if (v.tainted) { const e = new Error("The canvas has been tainted by cross-origin data."); e.name = "SecurityError"; throw e; }
        const data = new Uint8ClampedArray(72 * 4);
        const s = v.scene(v.currentTime);
        for (let i = 0; i < 72; i++) {
          // Per-scene pseudo-random pattern; a black video stays all zero.
          const val = v.black ? 0 : (((i + 1) * 2654435761 * (s + 7)) >>> 0) % 251;
          data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = val;
        }
        return { data };
      },
    };
  }
  toDataURL(type) {
    if (this.drawn && this.drawn.tainted) { const e = new Error("tainted"); e.name = "SecurityError"; throw e; }
    return `data:${type};base64,${"A".repeat(Math.ceil((this.width * this.height) / 40))}`;
  }
}

function makePage(elements, extra = {}) {
  const shadowHost = { shadowRoot: null, children: [] };
  const document = {
    roots: [],
    querySelectorAll(sel) {
      const tags = sel.split(",").map((s) => s.trim().toUpperCase());
      return this.light.filter((e) => tags.includes(e.tagName));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    createElement: () => new FakeCanvas(),
    createTreeWalker(root) {
      const list = root.light || [];
      let i = -1;
      return { nextNode: () => list[++i] || null };
    },
    getElementById: () => null,
    light: elements.filter((e) => !e.inShadow),
  };
  const shadow = elements.filter((e) => e.inShadow);
  if (shadow.length) {
    const sr = {
      light: shadow,
      querySelectorAll(sel) {
        const tags = sel.split(",").map((s) => s.trim().toUpperCase());
        return shadow.filter((e) => tags.includes(e.tagName));
      },
    };
    shadowHost.tagName = "MUX-PLAYER";
    shadowHost.shadowRoot = sr;
    document.light.push(shadowHost);
  }
  const ctx = {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: "https://site.test/watch", hostname: "site.test" },
    getComputedStyle: (el) => ({ display: el.style?.display || "block", visibility: "visible", opacity: el.style?.opacity ?? "1" }),
    NodeFilter: { SHOW_ELEMENT: 1 },
    performance,
    setTimeout,
    clearTimeout,
    URL,
    Symbol,
    ...extra,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const M = ctx.AutoDOMMediaTools;
  return { M, run: (op, a) => M._pageHelpers._pageMedia(op, a) };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test("list: audio before video, shadow-root video, hidden ad video, primary choice", async () => {
  const audio = new FakeMedia("AUDIO");
  const ad = new FakeMedia("VIDEO", { rect: { x: 0, y: 0, width: 0, height: 0 } });
  const main = new FakeMedia("VIDEO", { paused: false, rect: { x: 0, y: 0, width: 1000, height: 560 } });
  const shadowVid = Object.assign(new FakeMedia("VIDEO", { rect: { x: 0, y: 600, width: 320, height: 180 } }), { inShadow: true });
  const { run } = makePage([audio, ad, main, shadowVid]);
  const res = plain(await run("list", {}));
  assert.deepEqual(res.media.map((m) => m.tag), ["audio", "video", "video", "video"]);
  assert.equal(res.media[1].visible, false);
  assert.equal(res.media[1].score, 0);
  const best = res.media.reduce((x, y) => (y.score > x.score ? y : x));
  assert.equal(best.id, res.media[2].id, "the large playing video wins");
  // Ids are stable across calls.
  const again = plain(await run("list", {}));
  assert.deepEqual(again.media.map((m) => m.id), res.media.map((m) => m.id));
  const visible = plain(await run("list", { visibleOnly: true }));
  assert.equal(visible.media.some((m) => m.id === res.media[1].id), false);
});

test("one index space: index of an <audio> is refused for frames; default is the primary video", async () => {
  const audio = new FakeMedia("AUDIO");
  const video = new FakeMedia("VIDEO");
  const { run } = makePage([audio, video]);
  const bad = await run("frames", { index: 0, single: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /audio/);
  const good = plain(await run("frames", { single: true }));
  assert.equal(good.ok, true);
  assert.equal(good.frames.length, 1);
  assert.ok(good.frames[0].width <= 768, "downscaled to the default maxWidth");
});

test("sample even: distinct scenes kept, play state restored, maxWidth/quality honoured", async () => {
  const v = new FakeMedia("VIDEO", { paused: false, currentTime: 5 });
  const { run } = makePage([v]);
  const res = plain(await run("frames", { count: 4, maxWidth: 320, quality: 80 }));
  assert.equal(res.ok, true);
  assert.equal(res.frames.length, 4);
  assert.deepEqual(res.frames.map((f) => f.requestedT), [5, 15, 25, 35]);
  assert.ok(res.frames.every((f) => f.width === 320 && f.height === 180));
  assert.ok(res.frames.every((f) => typeof f.dataUrl === "string" && f.dataUrl.startsWith("data:image/jpeg")));
  assert.equal(v.currentTime, 5, "time restored");
  assert.equal(v.paused, false, "was playing, plays again");
});

test("dedupe: one static scene collapses to a single frame", async () => {
  const v = new FakeMedia("VIDEO", { scene: () => 0 });
  const { run } = makePage([v]);
  const res = plain(await run("frames", { count: 6 }));
  assert.equal(res.frames.length, 1);
  assert.equal(res.dropped.duplicate, 5);
});

test("scene mode keeps the biggest changes in time order", async () => {
  const v = new FakeMedia("VIDEO", { duration: 60, scene: (t) => (t < 30 ? 0 : 1) });
  const { run } = makePage([v]);
  const res = plain(await run("frames", { count: 2, mode: "scene" }));
  assert.equal(res.ok, true);
  assert.equal(res.probed, 6);
  assert.equal(res.frames.length, 2);
  assert.ok(res.frames[0].t < 30 && res.frames[1].t >= 30);
});

test("count is floored and clamped; 0 is not treated as the default", async () => {
  const v = new FakeMedia("VIDEO", { duration: 400, scene: (t) => Math.floor(t) });
  const { run } = makePage([v]);
  const zero = plain(await run("frames", { count: 0 }));
  assert.equal(zero.frames.length, 1);
  assert.equal(zero.clampedTo, 1);
  const many = plain(await run("frames", { count: 25.7, maxWidth: 128 }));
  assert.equal(many.clampedTo, 20);
  assert.equal(many.frames.length, 20);
});

test("a seek that never fires `seeked` times out instead of hanging", async () => {
  const v = new FakeMedia("VIDEO", { noSeeked: true, currentTime: 1 });
  const { run } = makePage([v]);
  const t0 = Date.now();
  const res = plain(await run("frames", { count: 1, fromSec: 20, toSec: 22 }));
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(res.ok, false);
  assert.match(res.error, /no frame/);
  assert.equal(v.currentTime, 1, "time restored after the failed seek");
});

test("cross-origin video reports tainted with times for the viewport fallback", async () => {
  const v = new FakeMedia("VIDEO", { tainted: true });
  const { run } = makePage([v]);
  const res = plain(await run("frames", { count: 3 }));
  assert.equal(res.ok, false);
  assert.equal(res.tainted, true);
  assert.equal(res.times.length, 3);
});

test("DRM video with blank frames is reported, not returned as black images", async () => {
  const v = new FakeMedia("VIDEO", { black: true, mediaKeys: {} });
  const { run } = makePage([v]);
  const res = plain(await run("frames", { count: 3 }));
  assert.equal(res.ok, false);
  assert.equal(res.drm, true);
});

test("live stream without DVR window: paused is an error, range errors are explicit", async () => {
  const live = new FakeMedia("VIDEO", { duration: Infinity, seekable: { length: 0 } });
  const { run } = makePage([live]);
  const res = await run("frames", { count: 2 });
  assert.equal(res.ok, false);
  assert.match(res.error, /live stream is paused/);
  const vod = makePage([new FakeMedia("VIDEO")]);
  const bad = await vod.run("frames", { count: 2, fromSec: 30, toSec: 10 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid range/);
});

test("not-loaded video is refused with a hint", async () => {
  const v = new FakeMedia("VIDEO", { readyState: 0, videoWidth: 0, videoHeight: 0 });
  const { run } = makePage([v]);
  const res = await run("frames", { single: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /no metadata/);
});

test("captions: a disabled track is loaded, windowed, markup stripped, mode restored", async () => {
  const track = {
    kind: "subtitles", label: "English", language: "en", mode: "disabled", cues: null, activeCues: [],
  };
  const cues = [
    { startTime: 1, endTime: 2, text: "<i>Hello</i>  there" },
    { startTime: 10, endTime: 12, text: "Later" },
  ];
  // Cues appear once the track is set to hidden (as a browser loads them).
  let mode = "disabled";
  Object.defineProperty(track, "mode", {
    get: () => mode,
    set: (m) => { mode = m; if (m !== "disabled") setTimeout(() => (track.cues = cues), 20); else track.cues = null; },
  });
  const v = new FakeMedia("VIDEO", { textTracks: [track] });
  const { run } = makePage([v]);
  const res = plain(await run("captions", { toSec: 5 }));
  assert.equal(res.source, "track");
  assert.deepEqual(res.cues, [{ start: 1, end: 2, text: "Hello there" }]);
  assert.equal(track.mode, "disabled");
});

test("control validates values", async () => {
  const v = new FakeMedia("VIDEO");
  const { run } = makePage([v]);
  assert.equal((await run("control", { action: "seekTo" })).ok, false);
  const ok = plain(await run("control", { action: "playbackRate", value: 99 }));
  assert.equal(ok.state.playbackRate, 16);
});

test("_mergeMediaLists: frame-prefixed ids, one primary, scanned embeds dropped", () => {
  const { M } = makePage([]);
  const merged = plain(M._mergeMediaLists([
    { frameId: 0, result: { url: "https://site.test/", media: [{ id: "m1", score: 5 }], embeds: [
      { provider: "youtube.com", src: "https://www.youtube.com/embed/abc" },
      { provider: "vimeo.com", src: "https://player.vimeo.com/video/1" },
    ] } },
    { frameId: 7, result: { url: "https://www.youtube.com/embed/abc?autoplay=1", media: [{ id: "m1", score: 90 }], embeds: [] } },
  ]));
  assert.deepEqual(merged.media.map((m) => m.id), ["m1", "7:m1"]);
  assert.equal(merged.primary, "7:m1");
  assert.ok(merged.media.every((m) => !("score" in m)));
  assert.deepEqual(merged.embeds.map((e) => e.provider), ["vimeo.com"]);
  assert.deepEqual(plain(M._mediaTarget({ id: "7:m1", count: 2 })), { id: "m1", frameId: 7, count: 2 });
});
