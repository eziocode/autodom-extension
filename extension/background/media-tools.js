/**
 * AutoDOM — Media, Image, Recorder tools
 *
 * Adds the following to the agent surface:
 *   Video / audio:
 *     - media_list            find <video>/<audio> in every frame and open
 *                             shadow root, plus player iframes (YouTube, ...)
 *     - media_control         play / pause / seek / rate / volume / mute
 *     - media_get_captions    caption cues of one track (or YouTube transcript)
 *     - media_capture_frame   one downscaled frame as an image
 *     - media_sample_frames   N keyframes (even or scene-change), deduplicated
 *   Images:
 *     - image_list            enumerate <img> elements + bbox + alt
 *     - image_get_data        one page image, downscaled, as an image
 *   Macro recorder (programmatic action capture/replay):
 *     - macro_record_start    install user-event listeners in the active tab
 *     - macro_record_stop     return captured macro JSON
 *     - macro_replay          replay a previously recorded macro
 *   Tab recorder (video of the tab):
 *     - tab_recording_start   begin tabCapture+MediaRecorder via offscreen doc
 *     - tab_recording_stop    finalize blob, return objectURL + size
 *     - tab_recording_status  query current recording state
 *
 * Exposed via globalThis.AutoDOMMediaTools = { makeHandlers, catalog }.
 * Risk tiers for these tools live in action-gate.js (SAFE_READ/DESTRUCTIVE).
 *
 * Frames are never stored: they are drawn, downscaled and encoded in the
 * page, returned once, and dropped. Nothing is written to the page DOM
 * (media ids live in a WeakMap), so there is nothing to clean up after.
 */
(function () {
  // ─── Page-side media/image ops (serialized into the tab) ────────────
  // One self-contained function for every op, so element lookup,
  // shadow-root traversal and encoding exist once and an id or index from
  // media_list means the same element in every later call. It is
  // `.toString()`d by chrome.scripting, so it must not reference anything
  // outside itself.
  async function _pageMedia(op, a) {
    a = a || {};
    try {
      const STATE = (window[Symbol.for("autodom.media")] ||= {
        ids: new WeakMap(),
        seq: 0,
        cancelled: new Set(),
      });
      const EMBED_HOST =
        /(^|\.)(youtube(-nocookie)?\.com|youtu\.be|vimeo\.com|wistia\.(com|net)|loom\.com|dailymotion\.com|twitch\.tv|jwplayer\.com|jwplatform\.com|brightcove\.net|kaltura\.com)$/i;
      const r2 = (n) => Math.round(n * 100) / 100;
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const strip = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

      // Document plus every open shadow root, bounded so a huge page
      // cannot stall the call.
      const roots = () => {
        const out = [document];
        for (let i = 0; i < out.length && out.length < 64; i++) {
          const w = document.createTreeWalker(out[i], NodeFilter.SHOW_ELEMENT);
          for (let n = w.nextNode(), seen = 0; n && seen < 20000; n = w.nextNode(), seen++) {
            if (n.shadowRoot) out.push(n.shadowRoot);
          }
        }
        return out;
      };
      const all = (sel) => roots().flatMap((r) => Array.from(r.querySelectorAll(sel)));
      const idOf = (el) => {
        let id = STATE.ids.get(el);
        if (!id) STATE.ids.set(el, (id = "m" + ++STATE.seq));
        return id;
      };
      const geom = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const shown = r.width >= 2 && r.height >= 2 && cs.display !== "none" &&
          cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
        const ix = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
        const iy = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        return {
          shown,
          onScreen: shown ? ix * iy : 0,
          bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      };
      // Primary-video score: on-screen area, doubled while playing. Hidden
      // and audio elements score 0 so a visible player beats a preview/ad.
      const score = (el) => {
        if (el.tagName !== "VIDEO") return 0;
        const g = geom(el);
        if (!g.shown) return 0;
        return Math.round(1 + g.onScreen * (el.paused ? 1 : 2) * (el.readyState > 0 ? 1 : 0.5));
      };
      const pick = (videoOnly) => {
        const list = all("video, audio");
        let el = null;
        if (a.id != null) {
          el = list.find((e) => STATE.ids.get(e) === String(a.id)) || null;
        } else if (a.selector) {
          try {
            el = document.querySelector(a.selector);
          } catch (_) {
            return { error: `invalid selector: ${a.selector}` };
          }
          if (el && el.tagName !== "VIDEO" && el.tagName !== "AUDIO") {
            el = el.querySelector("video, audio") ||
              (el.shadowRoot && el.shadowRoot.querySelector("video, audio")) || null;
          }
        } else if (a.index != null) {
          el = list[a.index] || null;
        } else {
          let best = -1;
          for (const e of list) {
            const s = e.tagName === "VIDEO" ? score(e) : -0.5;
            if (s > best) [best, el] = [s, e];
          }
        }
        if (!el) {
          return { error: list.length ? "media element not found (ids come from media_list)" : "no <video> or <audio> in this frame" };
        }
        if (videoOnly && el.tagName !== "VIDEO") return { error: "target is <audio>; frames need a <video>" };
        return { el };
      };
      const describe = (el, index) => {
        const g = geom(el);
        const src = el.currentSrc || el.src || "";
        const sk = el.seekable;
        const video = el.tagName === "VIDEO";
        return {
          id: idOf(el),
          index,
          tag: el.tagName.toLowerCase(),
          src: src.startsWith("data:") ? "data:(inline)" : src.slice(0, 300) || null,
          srcType: el.srcObject ? "stream" : src.startsWith("blob:") ? "mse" : src ? "file" : "none",
          duration: Number.isFinite(el.duration) ? r2(el.duration) : null,
          live: el.duration === Infinity,
          currentTime: r2(el.currentTime),
          paused: el.paused,
          ended: el.ended,
          muted: el.muted,
          playbackRate: el.playbackRate,
          readyState: el.readyState,
          ...(video && { width: el.videoWidth, height: el.videoHeight }),
          ...(video && el.poster && { poster: el.poster.slice(0, 300) }),
          visible: g.shown,
          inViewport: g.onScreen > 0,
          bbox: g.bbox,
          seekable: sk && sk.length ? [r2(sk.start(0)), r2(sk.end(sk.length - 1))] : null,
          drm: !!el.mediaKeys,
          crossOrigin: el.crossOrigin || null,
          textTracks: el.textTracks ? el.textTracks.length : 0,
          error: el.error ? el.error.code : null,
          score: score(el),
        };
      };

      // ── Encoding ──
      // quality accepts 0–1 or 1–100; maxWidth caps width, 1568 caps the
      // long edge (vision models downscale anything larger anyway).
      const maxW = clamp(Number(a.maxWidth) || (op === "image" ? 1024 : 768), 128, 1568);
      const fmt = a.format === "webp" || a.format === "png" ? a.format : "jpeg";
      const qIn = Number(a.quality);
      const q = qIn > 0 ? (qIn > 1 ? clamp(qIn, 1, 100) / 100 : qIn) : 0.6;
      const fit = (w, h) => {
        const s = Math.min(1, maxW / w, 1568 / h);
        return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
      };
      const canvas = document.createElement("canvas");
      const encode = (src, w0, h0) => {
        const [w, h] = fit(w0, h0);
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(src, 0, 0, w, h);
        let url = canvas.toDataURL(`image/${fmt}`, q);
        if (!url.startsWith(`data:image/${fmt}`)) url = canvas.toDataURL("image/jpeg", q);
        return { dataUrl: url, width: w, height: h, bytes: Math.round(((url.length - url.indexOf(",") - 1) * 3) / 4) };
      };
      // 9×8 difference hash + luma spread from a tiny copy. getImageData
      // throws SecurityError on a cross-origin (tainted) source.
      const tiny = document.createElement("canvas");
      tiny.width = 9;
      tiny.height = 8;
      const tctx = tiny.getContext("2d", { willReadFrequently: true });
      const fingerprint = (src) => {
        tctx.drawImage(src, 0, 0, 9, 8);
        const d = tctx.getImageData(0, 0, 9, 8).data;
        const g = [];
        let sum = 0;
        let sq = 0;
        for (let i = 0; i < 72; i++) {
          const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
          g.push(v);
          sum += v;
          sq += v * v;
        }
        let hash = "";
        for (let row = 0; row < 8; row++) {
          let byte = 0;
          for (let col = 0; col < 8; col++) byte = (byte << 1) | (g[row * 9 + col] > g[row * 9 + col + 1] ? 1 : 0);
          hash += byte.toString(16).padStart(2, "0");
        }
        const mean = sum / 72;
        return { hash, blank: Math.sqrt(Math.max(0, sq / 72 - mean * mean)) < 3, dark: mean < 16 };
      };
      const ham = (x, y) => {
        let d = 0;
        for (let i = 0; i < 16; i += 2) {
          for (let v = parseInt(x.slice(i, i + 2), 16) ^ parseInt(y.slice(i, i + 2), 16); v; v >>= 1) d += v & 1;
        }
        return d;
      };

      // Seek and wait for a decodable frame. Never hangs: a seek that fires
      // no `seeked` (some codecs, same-position seeks) gives up after `ms`.
      const seek = async (el, t, ms) => {
        if (Math.abs(el.currentTime - t) < 0.01 && el.readyState >= 2) return true;
        const ok = await new Promise((res) => {
          let timer = null;
          const fin = (v) => {
            clearTimeout(timer);
            el.removeEventListener("seeked", onOk);
            el.removeEventListener("error", onBad);
            res(v);
          };
          const onOk = () => fin(true);
          const onBad = () => fin(false);
          el.addEventListener("seeked", onOk);
          el.addEventListener("error", onBad);
          timer = setTimeout(() => fin(false), ms);
          try {
            el.currentTime = t;
          } catch (_) {
            fin(false);
          }
        });
        for (let i = 0; ok && el.readyState < 2 && i < 20; i++) await sleep(50);
        return ok && el.readyState >= 2;
      };
      const restore = (el, prev) => {
        try {
          el.currentTime = prev.t;
        } catch (_) {}
        if (!prev.paused) el.play().catch(() => {});
      };

      // ── Ops ──
      const list = () => {
        const media = all("video, audio").map(describe);
        const shown = a.visibleOnly ? media.filter((m) => m.visible) : media;
        const embeds = [];
        for (const f of all("iframe")) {
          let host = "";
          try {
            host = new URL(f.src, location.href).hostname;
          } catch (_) {}
          if (!EMBED_HOST.test(host)) continue;
          const g = geom(f);
          if (a.visibleOnly && !g.shown) continue;
          embeds.push({ provider: host.replace(/^www\./, ""), src: f.src.slice(0, 300), visible: g.shown, bbox: g.bbox });
        }
        return { url: location.href, media: shown.slice(0, clamp(Number(a.limit) || 50, 1, 200)), embeds };
      };

      const control = () => {
        const p = pick(false);
        if (p.error) return { ok: false, error: p.error };
        const el = p.el;
        const v = Number(a.value);
        const num = a.value != null && Number.isFinite(v);
        switch (a.action || "toggle") {
          case "play":
            el.play().catch(() => {});
            break;
          case "pause":
            el.pause();
            break;
          case "toggle":
            if (el.paused) el.play().catch(() => {});
            else el.pause();
            break;
          case "mute":
            el.muted = true;
            break;
          case "unmute":
            el.muted = false;
            break;
          case "seekTo":
            if (!num) return { ok: false, error: "seekTo needs a numeric value (seconds)" };
            el.currentTime = Math.max(0, v);
            break;
          case "seekBy":
            if (!num) return { ok: false, error: "seekBy needs a numeric value (seconds)" };
            el.currentTime = Math.max(0, el.currentTime + v);
            break;
          case "playbackRate":
            if (!num || v <= 0) return { ok: false, error: "playbackRate needs a positive value" };
            el.playbackRate = clamp(v, 0.0625, 16);
            break;
          case "volume":
            if (!num) return { ok: false, error: "volume needs a value 0–1" };
            el.volume = clamp(v, 0, 1);
            break;
          case "fullscreen":
            if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
            break;
          case "pip":
            if (typeof el.requestPictureInPicture === "function") el.requestPictureInPicture().catch(() => {});
            break;
          default:
            return { ok: false, error: `unknown action: ${a.action}` };
        }
        return {
          ok: true,
          action: a.action || "toggle",
          id: idOf(el),
          state: { currentTime: r2(el.currentTime), paused: el.paused, muted: el.muted, volume: el.volume, playbackRate: el.playbackRate },
        };
      };

      const captions = async () => {
        const p = pick(false);
        if (p.error) return { ok: false, error: p.error };
        const el = p.el;
        const from = Number.isFinite(a.fromSec) ? a.fromSec : -Infinity;
        const to = Number.isFinite(a.toSec) ? a.toSec : Infinity;
        const maxCues = clamp(Number(a.maxCues) || 400, 1, 2000);
        const lang = a.lang ? String(a.lang).toLowerCase() : "";
        const tracks = Array.from(el.textTracks || []);
        let ti = Number.isInteger(a.track) ? a.track : -1;
        if (ti < 0 && lang) ti = tracks.findIndex((t) => (t.language || "").toLowerCase().startsWith(lang));
        if (ti < 0) ti = tracks.findIndex((t) => t.mode === "showing");
        if (ti < 0) ti = tracks.findIndex((t) => t.kind === "subtitles" || t.kind === "captions");
        if (ti < 0 && tracks.length) ti = 0;

        const cues = [];
        let active = [];
        let truncated = false;
        let chars = 0;
        const push = (start, end, text) => {
          if (!text || end < from || start > to) return true;
          if (cues.length >= maxCues || chars + text.length > 24000) return !(truncated = true);
          chars += text.length;
          cues.push({ start: r2(start), end: end == null ? null : r2(end), text });
          return true;
        };
        let source = "none";
        const tr = tracks[ti];
        if (tr) {
          // A disabled track has no cues loaded; "hidden" loads them
          // without rendering. Put the mode back afterwards.
          const prevMode = tr.mode;
          if (prevMode === "disabled") {
            tr.mode = "hidden";
            for (let i = 0; i < 30 && !(tr.cues && tr.cues.length); i++) await sleep(50);
          }
          for (const c of Array.from(tr.cues || [])) if (!push(c.startTime, c.endTime, strip(c.text))) break;
          active = Array.from(tr.activeCues || []).map((c) => strip(c.text)).filter(Boolean);
          if (prevMode === "disabled") tr.mode = prevMode;
          if (cues.length) source = "track";
        }
        // YouTube exposes no TextTracks; its player response lists caption
        // tracks with a timedtext URL for the whole transcript.
        if (!cues.length && /(^|\.)youtube\.com$/.test(location.hostname)) {
          try {
            const player = document.getElementById("movie_player");
            const pr = (player && player.getPlayerResponse && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
            const yt = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
              pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
            const ct = (lang && yt.find((t) => (t.languageCode || "").toLowerCase().startsWith(lang))) ||
              yt.find((t) => t.kind !== "asr") || yt[0];
            if (ct && ct.baseUrl) {
              const res = await fetch(ct.baseUrl + "&fmt=json3", { credentials: "include" });
              const j = res.ok ? await res.json().catch(() => null) : null;
              for (const ev of (j && j.events) || []) {
                if (!ev.segs) continue;
                const start = ev.tStartMs / 1000;
                if (!push(start, start + (ev.dDurationMs || 0) / 1000, strip(ev.segs.map((s) => s.utf8).join("")))) break;
              }
              if (cues.length) source = "youtube-transcript";
            }
          } catch (_) {}
        }
        // Last resort: the caption line a player is rendering right now.
        if (!cues.length) {
          const seen = all(".ytp-caption-segment, .vjs-text-track-cue, .jw-text-track-cue, .shaka-text-container span")
            .map((n) => strip(n.textContent)).filter(Boolean);
          if (seen.length) {
            cues.push({ start: r2(el.currentTime), end: null, text: [...new Set(seen)].join(" ") });
            source = "dom-visible";
          }
        }
        return {
          ok: true,
          id: idOf(el),
          source,
          tracks: tracks.map((t, i) => ({ index: i, kind: t.kind, label: t.label, language: t.language, mode: t.mode })),
          track: ti,
          cues,
          active,
          ...(truncated && { truncated: true }),
        };
      };

      // media_sample_frames (and media_capture_frame with single:true).
      const frames = async () => {
        const p = pick(true);
        if (p.error) return { ok: false, error: p.error };
        const el = p.el;
        if (el.readyState < 1 || !el.videoWidth || !el.videoHeight) {
          return { ok: false, error: "video has no metadata yet (not loaded); play it or seek once, then retry", readyState: el.readyState };
        }
        const video = { id: idOf(el), duration: Number.isFinite(el.duration) ? r2(el.duration) : null, width: el.videoWidth, height: el.videoHeight };
        const runId = a.runId || "";
        const deadline = performance.now() + clamp(Number(a.deadlineMs) || 22000, 2000, 25000);
        const budget = clamp(Number(a.maxBytes) || 4_000_000, 100_000, 16_000_000);
        const wanted = a.single ? 1 : a.count == null || !Number.isFinite(Number(a.count)) ? 6 : Number(a.count);
        const n = clamp(Math.floor(wanted), 1, 20);
        const scene = !a.single && a.mode === "scene";
        const live = !Number.isFinite(el.duration);
        const sk = el.seekable;
        const dvr = live && sk && sk.length && sk.end(sk.length - 1) - sk.start(0) > 2;

        let times = null;
        if (a.single) {
          times = [Number.isFinite(a.atSec) ? a.atSec : el.currentTime];
        } else if (!live || dvr) {
          const lo = live ? sk.start(0) : 0;
          const hi = live ? sk.end(sk.length - 1) : el.duration;
          const start = clamp(Number.isFinite(a.fromSec) ? a.fromSec : lo, lo, hi);
          const end = clamp(Number.isFinite(a.toSec) ? a.toSec : hi, lo, hi);
          if (end - start < 0.05) {
            return { ok: false, error: `invalid range: fromSec ${a.fromSec ?? lo} / toSec ${a.toSec ?? hi} (media spans ${r2(lo)}–${r2(hi)} s)` };
          }
          const k = scene ? Math.min(40, n * 3) : n;
          times = Array.from({ length: k }, (_, i) => start + ((end - start) * (i + 0.5)) / k);
        }

        const prev = { t: el.currentTime, paused: el.paused };
        const got = [];
        let failed = 0;
        let stop = null;
        const grab = (requestedT) => {
          const fp = fingerprint(el);
          got.push({ t: r2(el.currentTime), ...(requestedT != null && { requestedT: r2(requestedT) }), ...fp, ...encode(el, el.videoWidth, el.videoHeight) });
        };
        const taint = (err) => /secur|taint|cross-origin/i.test(String(err && `${err.name} ${err.message}`));
        try {
          if (times) {
            el.pause();
            for (const t of times) {
              if (STATE.cancelled.has(runId)) { stop = "cancelled"; break; }
              if (performance.now() > deadline) { stop = "time budget"; break; }
              if (!el.paused) { stop = "playback resumed during sampling"; break; }
              if (!(await seek(el, t, 3000))) { failed++; continue; }
              try {
                grab(t);
              } catch (err) {
                if (!got.length && taint(err)) {
                  return {
                    ok: false,
                    tainted: true,
                    error: "cross-origin video without CORS: the page cannot read its pixels",
                    video,
                    times: a.single ? times : Array.from({ length: n }, (_, i) => times[0] + ((times[times.length - 1] - times[0]) * i) / Math.max(1, n - 1)),
                  };
                }
                failed++;
              }
            }
          } else {
            // Live without a DVR window: frames over wall-clock time.
            if (el.paused) return { ok: false, error: "live stream is paused; play it (media_control action:play) to sample over time" };
            const every = clamp(Number(a.intervalMs) || 1000, 200, 10000);
            for (let i = 0; i < n; i++) {
              if (STATE.cancelled.has(runId)) { stop = "cancelled"; break; }
              if (performance.now() + (i ? every : 0) > deadline) { stop = "time budget"; break; }
              if (i) await sleep(every);
              try {
                grab(null);
              } catch (err) {
                if (taint(err)) return { ok: false, tainted: true, live: true, error: "cross-origin live stream without CORS: pixels unreadable", video, times: [el.currentTime] };
                failed++;
              }
            }
          }
        } finally {
          if (times) restore(el, prev);
          STATE.cancelled.delete(runId);
        }

        if (!got.length) return { ok: false, error: `no frame could be read (${failed} seeks failed)`, video };
        if (got.every((f) => f.blank) && el.mediaKeys) {
          return { ok: false, error: "DRM-protected video: frames render blank and cannot be analysed", video, drm: true };
        }
        // Blank frames (black/uniform) carry nothing; keep one if that is all there is.
        let pool = got.filter((f) => !f.blank);
        const blank = got.length - pool.length;
        if (!pool.length) pool = got.slice(0, 1);
        if (scene) {
          // Keep the first frame and the biggest visual changes, in time order.
          pool = pool
            .map((f, i) => ({ f, d: i ? ham(f.hash, pool[i - 1].hash) : 65 }))
            .sort((x, y) => y.d - x.d)
            .slice(0, n)
            .map((s) => s.f)
            .sort((x, y) => x.t - y.t);
        }
        const kept = [];
        let duplicate = 0;
        let bytes = 0;
        for (const f of pool) {
          if (kept.length && ham(f.hash, kept[kept.length - 1].hash) <= 4) { duplicate++; continue; }
          if (kept.length && bytes + f.bytes > budget) { stop = stop || "size budget"; break; }
          bytes += f.bytes;
          delete f.blank;
          if (!f.dark) delete f.dark;
          kept.push(f);
        }
        return {
          ok: true,
          video,
          ...(wanted !== n && { requested: wanted, clampedTo: n }),
          ...(scene && { probed: got.length }),
          frames: kept,
          bytes,
          ...((blank || duplicate) && { dropped: { blank, duplicate } }),
          ...(failed && { failedSeeks: failed }),
          ...(stop && { truncated: stop }),
          ...(pool.length === 1 && got.every((f) => f.blank) && { warning: "frames are blank (black/uniform): the video may not be decoded yet" }),
        };
      };

      // Viewport fallback for tainted video (the SW screenshots the player):
      // seek and hold a frame, report where the player is on screen.
      const seekPause = async () => {
        const p = pick(true);
        if (p.error) return { ok: false, error: p.error };
        const el = p.el;
        const prev = { t: el.currentTime, paused: el.paused };
        el.pause();
        const ok = await seek(el, Number(a.t), 3000);
        if (geom(el).onScreen === 0) el.scrollIntoView({ block: "center", inline: "center" });
        const g = geom(el);
        return { ok: ok && g.onScreen > 0, t: r2(el.currentTime), prev, bbox: g.bbox };
      };

      const images = () => {
        const imgs = all("img");
        const cap = clamp(Number(a.limit) || 60, 1, 500);
        return {
          count: imgs.length,
          returned: Math.min(cap, imgs.length),
          images: imgs.slice(0, cap).map((img, index) => ({
            index,
            src: (img.currentSrc || img.src || "").slice(0, 300),
            alt: img.alt || "",
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            bbox: geom(img).bbox,
          })),
        };
      };

      // Fetching the bytes and decoding them with createImageBitmap reads a
      // CORS-enabled cross-origin image the canvas would refuse; drawing the
      // <img> itself is the fallback (same-origin, SVG).
      const image = async () => {
        let img = null;
        if (a.selector) {
          try {
            img = document.querySelector(a.selector);
          } catch (_) {
            return { ok: false, error: `invalid selector: ${a.selector}` };
          }
        } else {
          img = all("img")[a.index ?? 0] || null;
        }
        if (!img || img.tagName !== "IMG") return { ok: false, error: "image not found" };
        const src = img.currentSrc || img.src;
        if (!src) return { ok: false, error: "image has no src" };
        let bmp = null;
        try {
          const r = await fetch(src, { credentials: "include" });
          if (r.ok) bmp = await createImageBitmap(await r.blob());
        } catch (_) {}
        const w0 = bmp ? bmp.width : img.naturalWidth;
        const h0 = bmp ? bmp.height : img.naturalHeight;
        if (!w0 || !h0) return { ok: false, error: "image not loaded yet" };
        try {
          const out = encode(bmp || img, w0, h0);
          if (bmp) bmp.close();
          return { ok: true, src: src.slice(0, 300), naturalWidth: w0, naturalHeight: h0, ...out };
        } catch (err) {
          return { ok: false, error: `cross-origin image without CORS: cannot read pixels (${err && err.message})` };
        }
      };

      switch (op) {
        case "list": return list();
        case "control": return control();
        case "captions": return await captions();
        case "frames": return await frames();
        case "seekPause": return await seekPause();
        case "restore": {
          const p = pick(true);
          if (!p.error && a.prev) restore(p.el, a.prev);
          return { ok: !p.error };
        }
        case "cancel":
          STATE.cancelled.add(a.runId);
          return { ok: true };
        case "images": return images();
        case "image": return await image();
        default: return { ok: false, error: `unknown media op: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // ── Macro recorder (page-side) ──────────────────────────────────────
  // We install a tiny capture script that listens for click/input/keydown
  // and pushes events to window.__autodomMacro. macro_record_stop reads it
  // back and tears down the listener.

  function _pageMacroInstall() {
    if (window.__autodomMacro && window.__autodomMacro.installed) {
      return { ok: true, alreadyRunning: true, count: window.__autodomMacro.events.length };
    }
    const events = [];
    const startedAt = performance.now();

    const cssPath = (el) => {
      if (!(el instanceof Element)) return null;
      const parts = [];
      while (el && el.nodeType === 1 && parts.length < 8) {
        let part = el.nodeName.toLowerCase();
        if (el.id) { part += "#" + el.id; parts.unshift(part); break; }
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (n) => n.nodeName === el.nodeName,
          );
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(el) + 1})`;
          }
        }
        parts.unshift(part);
        el = el.parentElement;
      }
      return parts.join(" > ");
    };

    const push = (type, ev, extra) => {
      const target = ev.target;
      events.push({
        t: Math.round(performance.now() - startedAt),
        type,
        selector: cssPath(target),
        x: ev.clientX,
        y: ev.clientY,
        ...(extra || {}),
      });
      if (events.length > 5000) events.shift();
    };

    const onClick = (ev) => push("click", ev);
    const onInput = (ev) => push("input", ev, { value: String(ev.target.value || "").slice(0, 2000) });
    const onChange = (ev) => push("change", ev, { value: String(ev.target.value || "").slice(0, 2000) });
    const onKey = (ev) => {
      if (ev.key && ev.key.length > 1) push("key", ev, { key: ev.key });
    };
    const onScroll = () => {
      events.push({ t: Math.round(performance.now() - startedAt), type: "scroll", x: window.scrollX, y: window.scrollY });
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKey, true);
    let scrollTimer = null;
    const scrollHandler = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(onScroll, 150);
    };
    window.addEventListener("scroll", scrollHandler, true);

    window.__autodomMacro = {
      installed: true,
      startedAt,
      events,
      uninstall() {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("input", onInput, true);
        document.removeEventListener("change", onChange, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", scrollHandler, true);
        this.installed = false;
      },
    };
    return { ok: true, started: true };
  }

  function _pageMacroStop() {
    const m = window.__autodomMacro;
    if (!m) return { ok: false, error: "no recording in progress" };
    const events = m.events.slice();
    try { m.uninstall(); } catch (_) {}
    try { delete window.__autodomMacro; } catch (_) { window.__autodomMacro = null; }
    return { ok: true, count: events.length, events };
  }

  function _pageMacroReplay(events, speed) {
    return new Promise((resolve) => {
      if (!Array.isArray(events) || events.length === 0) {
        return resolve({ ok: false, error: "empty macro" });
      }
      const s = Math.max(0.1, Math.min(10, speed || 1));
      let i = 0;
      const errors = [];
      const replayOne = () => {
        if (i >= events.length) return resolve({ ok: true, replayed: events.length, errors });
        const ev = events[i++];
        try {
          const el = ev.selector ? document.querySelector(ev.selector) : null;
          switch (ev.type) {
            case "click":
              if (el) {
                el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: ev.x, clientY: ev.y }));
              }
              break;
            case "input":
            case "change":
              if (el && "value" in el) {
                el.focus();
                el.value = ev.value || "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
              break;
            case "key":
              if (el) {
                el.dispatchEvent(new KeyboardEvent("keydown", { key: ev.key, bubbles: true }));
                el.dispatchEvent(new KeyboardEvent("keyup", { key: ev.key, bubbles: true }));
              }
              break;
            case "scroll":
              window.scrollTo(ev.x, ev.y);
              break;
          }
        } catch (err) {
          errors.push({ index: i - 1, error: String(err && err.message) });
        }
        const next = events[i];
        const dt = next ? Math.max(10, (next.t - ev.t) / s) : 0;
        setTimeout(replayOne, dt);
      };
      replayOne();
    });
  }

  // ── SW-side tool handlers ────────────────────────────────────────────
  // ctx = { getActiveTab, executeInTab, executeInFrames, captureRegion,
  //         onCallCancel, sendToOffscreen }, supplied by the service worker.
  // Each handler gets the SW's per-call context as its second argument
  // and resolves its tab through getActiveTab(callCtx).

  // "3:m1" (frame 3, media m1) → { frameId: 3, id: "m1" }. Top-frame ids
  // carry no prefix.
  function _mediaTarget(params) {
    const p = { ...(params || {}) };
    const m = typeof p.id === "string" && /^(\d+):(.+)$/.exec(p.id);
    if (m) {
      p.frameId = Number(m[1]);
      p.id = m[2];
    }
    return p;
  }

  // Merge per-frame media_list results: frame-prefixed ids, one primary
  // across all frames, and embeds only when their frame showed no media
  // of its own (a scripted YouTube frame lists its <video> directly).
  function _mergeMediaLists(frames) {
    const media = [];
    const embeds = [];
    const scanned = [];
    for (const { frameId, result } of frames) {
      if (!result || !Array.isArray(result.media)) continue;
      if (frameId && result.media.length) scanned.push(result.url || "");
      for (const m of result.media) media.push(frameId ? { ...m, id: `${frameId}:${m.id}`, frameId } : m);
      embeds.push(...(result.embeds || []));
    }
    const sameDoc = (u, v) => {
      try {
        const x = new URL(u);
        const y = new URL(v);
        return x.origin === y.origin && x.pathname === y.pathname;
      } catch (_) {
        return false;
      }
    };
    let primary = null;
    for (const m of media) if (m.score > 0 && (!primary || m.score > primary.score)) primary = m;
    for (const m of media) {
      if (m === primary) m.primary = true;
      delete m.score;
    }
    const unscanned = embeds
      .filter((e) => !scanned.some((u) => sameDoc(u, e.src)))
      .map((e) => ({ ...e, note: "player frame shows no <video> yet (it may load on click)" }));
    return {
      count: media.length,
      primary: primary ? primary.id : null,
      media,
      ...(unscanned.length && { embeds: unscanned }),
    };
  }

  function makeHandlers(ctx) {
    const { getActiveTab, executeInTab, executeInFrames, captureRegion, onCallCancel, sendToOffscreen } = ctx;

    // One _pageMedia op in the frame the target names, else the top frame.
    async function run(tab, op, args) {
      if (args.frameId == null || !executeInFrames) return executeInTab(tab.id, _pageMedia, [op, args]);
      const [r] = await executeInFrames(tab.id, _pageMedia, [op, args], [args.frameId]);
      return r ? r.result : { ok: false, error: `frame ${args.frameId} is gone (call media_list again)` };
    }

    // The page cannot read a cross-origin video's pixels, but the tab's
    // rendering can: seek, hold, screenshot the player, crop. Top frame only
    // (an iframe's offset in the viewport is unknown here).
    async function viewportFrames(tab, args, tainted, callCtx) {
      if (!captureRegion || args.frameId) return tainted;
      const frames = [];
      let prev = null;
      try {
        for (const t of tainted.times.slice(0, 8)) {
          const s = await run(tab, "seekPause", { ...args, t });
          if (!s || !s.ok) continue;
          prev = prev || s.prev;
          const shot = await captureRegion(s.bbox, args, callCtx);
          if (shot) frames.push({ t: s.t, requestedT: Math.round(t * 100) / 100, ...shot });
        }
      } finally {
        if (prev) await run(tab, "restore", { ...args, prev }).catch(() => {});
      }
      if (!frames.length) return { ...tainted, error: `${tainted.error}; viewport capture failed too` };
      return {
        ok: true,
        source: "viewport",
        video: tainted.video,
        frames,
        note: "cross-origin video: frames are screenshots of the player area and may include its controls or overlays",
      };
    }

    async function sampleFrames(params, callCtx, single) {
      const tab = await getActiveTab(callCtx);
      const args = { ..._mediaTarget(params), single, runId: Math.random().toString(36).slice(2) };
      const detach = onCallCancel ? onCallCancel(callCtx, () => run(tab, "cancel", args).catch(() => {})) : () => {};
      try {
        const res = await run(tab, "frames", args);
        return res && res.tainted ? await viewportFrames(tab, args, res, callCtx) : res;
      } finally {
        detach();
      }
    }

    return {
      media_list: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        const args = { visibleOnly: !!params?.visibleOnly, limit: params?.limit };
        let frames = null;
        if (executeInFrames) {
          try {
            frames = await executeInFrames(tab.id, _pageMedia, ["list", args]);
          } catch (_) {}
        }
        if (!frames || !frames.length) frames = [{ frameId: 0, result: await executeInTab(tab.id, _pageMedia, ["list", args]) }];
        return _mergeMediaLists(frames);
      },
      media_control: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return run(tab, "control", _mediaTarget(params));
      },
      media_get_captions: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return run(tab, "captions", _mediaTarget(params));
      },
      media_capture_frame: (params, callCtx) => sampleFrames(params, callCtx, true),
      media_sample_frames: (params, callCtx) => sampleFrames(params, callCtx, false),
      image_list: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return executeInTab(tab.id, _pageMedia, ["images", { limit: params?.limit }]);
      },
      image_get_data: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return executeInTab(tab.id, _pageMedia, ["image", { ...(params || {}) }]);
      },
      macro_record_start: async (_params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return executeInTab(tab.id, _pageMacroInstall, []);
      },
      macro_record_stop: async (_params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return executeInTab(tab.id, _pageMacroStop, []);
      },
      macro_replay: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        return executeInTab(
          tab.id,
          _pageMacroReplay,
          [params?.events || [], params?.speed || 1],
        );
      },
      tab_recording_start: async (params, callCtx) => {
        const tab = await getActiveTab(callCtx);
        // `tabCapture` is an optional permission (declared in
        // optional_permissions) so that adding it never forces a
        // disable-on-update re-authorization prompt for existing installs.
        // It must be granted at runtime from a user gesture via the popup
        // ("Enable tab recording"). The service-worker MCP path has no user
        // gesture, so we only check — never request — here.
        const hasTabCapture = await new Promise((resolve) => {
          try {
            chrome.permissions.contains(
              { permissions: ["tabCapture"] },
              (granted) => {
                if (chrome.runtime.lastError) resolve(false);
                else resolve(granted === true);
              },
            );
          } catch (_) {
            resolve(false);
          }
        });
        if (!hasTabCapture) {
          return {
            ok: false,
            error:
              "Tab recording permission not granted. Open the AutoDOM extension popup and click \"Enable tab recording\" to grant the tabCapture permission, then retry.",
            permissionRequired: "tabCapture",
          };
        }
        // From the SW, getMediaStreamId names the tab with targetTabId; the
        // offscreen document consumes the id with getUserMedia.
        const streamId = await new Promise((resolve, reject) => {
          try {
            chrome.tabCapture.getMediaStreamId(
              { targetTabId: tab.id },
              (id) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else resolve(id);
              },
            );
          } catch (err) { reject(err); }
        });
        return sendToOffscreen({
          type: "AUTODOM_REC_START",
          streamId,
          mimeType: params?.mimeType || "video/webm;codecs=vp9,opus",
          videoBitsPerSecond: params?.videoBitsPerSecond || 2_500_000,
          maxDurationSec: params?.maxDurationSec,
          maxBytes: params?.maxBytes,
        });
      },
      tab_recording_stop: async () => sendToOffscreen({ type: "AUTODOM_REC_STOP" }),
      tab_recording_status: async () => sendToOffscreen({ type: "AUTODOM_REC_STATUS" }),
    };
  }

  // ─── Tool catalog (exposed to the in-panel agent) ───────────────────
  // The MCP server declares the same tools with zod in server/index.js.
  const TARGET = {
    id: { type: "string", description: "Media id from media_list (\"m1\", or \"3:m1\" inside a frame). Default: the primary video." },
    index: { type: "integer", description: "Position in media_list (top frame)" },
    selector: { type: "string", description: "CSS selector of the element or its player container" },
  };
  const ENCODING = {
    maxWidth: { type: "integer", description: "Frame width cap in px, 128–1568 (default 768)" },
    format: { type: "string", enum: ["jpeg", "webp", "png"], description: "Default jpeg" },
    quality: { type: "number", description: "1–100 (default 60)" },
  };
  const CATALOG = [
    {
      name: "media_list",
      description: "Find <video>/<audio> in every frame and open shadow root (state, size, visibility, live/DRM/seekable) plus player iframes (YouTube, Vimeo, ...). Marks the primary (largest visible) video. Pass a returned `id` to the other media_* tools.",
      parameters: {
        type: "object",
        properties: {
          visibleOnly: { type: "boolean" },
          limit: { type: "integer", description: "default 50" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "media_control",
      description: "Control playback of a <video>/<audio> (default: the primary video). Actions: play, pause, toggle, mute, unmute, seekTo, seekBy, playbackRate, volume, fullscreen, pip. Pass `value` (number) for seekTo/seekBy (seconds), playbackRate (e.g. 1.5), volume (0–1).",
      parameters: {
        type: "object",
        properties: {
          ...TARGET,
          action: { type: "string", enum: ["play","pause","toggle","mute","unmute","seekTo","seekBy","playbackRate","volume","fullscreen","pip"] },
          value: { type: "number" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "media_get_captions",
      description: "Caption/subtitle cues of one track (chosen by track, lang, else the showing one), loading disabled tracks. On YouTube, the full transcript. Cheapest way to know what a video says — try before frames.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET,
          track: { type: "integer" },
          lang: { type: "string", description: "Language prefix, e.g. en" },
          fromSec: { type: "number" },
          toSec: { type: "number" },
          maxCues: { type: "integer", description: "default 400" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "media_capture_frame",
      description: "One downscaled frame of a <video> (default: primary video), at the current time or `atSec` (play state restored). Cross-origin video without CORS falls back to a screenshot of the player.",
      parameters: {
        type: "object",
        properties: { ...TARGET, atSec: { type: "number" }, ...ENCODING },
        additionalProperties: false,
      },
    },
    {
      name: "media_sample_frames",
      description: "Keyframes of a <video> for vision analysis: seeks (no playback), drops blank and near-duplicate frames, restores play state. mode \"scene\" picks the biggest visual changes; \"even\" spaces them. Live streams sample over time.",
      parameters: {
        type: "object",
        properties: {
          ...TARGET,
          count: { type: "integer", description: "1–20 (default 6)" },
          mode: { type: "string", enum: ["even", "scene"] },
          fromSec: { type: "number" },
          toSec: { type: "number" },
          intervalMs: { type: "integer", description: "Live streams only: gap between frames (default 1000)" },
          ...ENCODING,
        },
        additionalProperties: false,
      },
    },
    {
      name: "image_list",
      description: "Enumerate <img> elements (including open shadow roots) with src, alt, natural dimensions, and bounding box.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "default 60" } },
        additionalProperties: false,
      },
    },
    {
      name: "image_get_data",
      description: "One page image, downscaled and re-encoded (fetch with credentials, canvas fallback). Fails on cross-origin images served without CORS headers.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index from image_list" },
          selector: { type: "string" },
          maxWidth: { type: "integer", description: "128–1568 (default 1024)" },
          format: ENCODING.format,
          quality: ENCODING.quality,
        },
        additionalProperties: false,
      },
    },
    {
      name: "macro_record_start",
      description: "Begin recording user-style interactions on the active tab (clicks, inputs, key presses, scroll). Returns immediately.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "macro_record_stop",
      description: "Stop the macro recorder and return the captured event sequence (timestamped, with CSS selectors). Pass this `events` array back to `macro_replay`.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "macro_replay",
      description: "Replay a previously recorded macro on the active tab. Supports playback `speed` (default 1.0).",
      parameters: {
        type: "object",
        properties: {
          events: { type: "array", items: { type: "object" } },
          speed: { type: "number" },
        },
        required: ["events"],
      },
    },
    {
      name: "tab_recording_start",
      description: "Start recording the active tab to a WebM video via tabCapture + MediaRecorder (runs in the offscreen document). Needs the optional tabCapture permission (popup → \"Enable tab recording\"). Stops itself at maxDurationSec (default 600) or maxBytes (default 200 MB).",
      parameters: {
        type: "object",
        properties: {
          mimeType: { type: "string" },
          videoBitsPerSecond: { type: "integer" },
          maxDurationSec: { type: "integer" },
          maxBytes: { type: "integer" },
        },
      },
    },
    {
      name: "tab_recording_stop",
      description: "Stop the active tab recording. Returns an objectURL + size; the chat panel can download it. The recording is freed once downloaded, on finish_session, or after 10 minutes.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "tab_recording_status",
      description: "Query whether a tab recording is in progress and how many bytes a finished one still holds.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  globalThis.AutoDOMMediaTools = {
    makeHandlers,
    catalog: CATALOG,
    // Exported for unit tests.
    _mergeMediaLists,
    _mediaTarget,
    _pageHelpers: {
      _pageMedia,
      _pageMacroInstall,
      _pageMacroStop,
      _pageMacroReplay,
    },
  };
})();
