/**
 * AutoDOM — Media, Image, Recorder tools
 *
 * Adds the following to the agent surface:
 *   Video / audio:
 *     - media_list            list <video>/<audio> on the page
 *     - media_control         play / pause / seek / rate / volume / mute
 *     - media_get_captions    return active TextTrack cues
 *     - media_capture_frame   grab current <video> frame as PNG dataURL
 *     - media_sample_frames   sample N evenly-spaced frames
 *   Images:
 *     - image_list            enumerate <img> elements + bbox + alt
 *     - image_get_data        fetch a specific image as base64 dataURL
 *   Macro recorder (programmatic action capture/replay):
 *     - macro_record_start    install user-event listeners in the active tab
 *     - macro_record_stop     return captured macro JSON
 *     - macro_replay          replay a previously recorded macro
 *   Tab recorder (video of the tab):
 *     - tab_recording_start   begin tabCapture+MediaRecorder via offscreen doc
 *     - tab_recording_stop    finalize blob, return objectURL + size
 *     - tab_recording_status  query current recording state
 *
 * Exposed via globalThis.AutoDOMMediaTools = {
 *   handlers:  Map-compatible array of [name, fn]
 *   catalog:   array of { name, description, parameters } for the agent surface
 *   tiers:     { safeRead: Set<string>, destructive: Set<string> }
 *              (everything else defaults to "mutating" in action-gate.js)
 * }
 *
 * Handlers expect to be bound by the service worker so they can use the
 * SW-scoped helpers (getActiveTab, executeInTab). The SW does this in its
 * registration block (see service-worker.js TOOL_HANDLERS section).
 */
(function () {
  // ─── Page-side helpers (serialized into the active tab) ─────────────
  // Each of these is `.toString()`d into chrome.scripting.executeScript so
  // they must be self-contained (no outer references).

  function _pageMediaList() {
    const out = [];
    const all = Array.from(document.querySelectorAll("video, audio"));
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const rect = el.getBoundingClientRect();
      out.push({
        index: i,
        tag: el.tagName.toLowerCase(),
        src: el.currentSrc || el.src || null,
        duration: Number.isFinite(el.duration) ? el.duration : null,
        currentTime: el.currentTime,
        paused: el.paused,
        ended: el.ended,
        muted: el.muted,
        volume: el.volume,
        playbackRate: el.playbackRate,
        readyState: el.readyState,
        width: el.tagName === "VIDEO" ? el.videoWidth : null,
        height: el.tagName === "VIDEO" ? el.videoHeight : null,
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        textTracks: el.textTracks ? el.textTracks.length : 0,
      });
    }
    return { count: out.length, media: out };
  }

  function _pageMediaControl(index, selector, action, value) {
    let el = null;
    if (typeof index === "number") {
      el = document.querySelectorAll("video, audio")[index] || null;
    } else if (selector) {
      el = document.querySelector(selector);
    }
    if (!el) return { ok: false, error: "media element not found" };
    try {
      switch (action) {
        case "play":
          // play() returns a Promise; we don't await — SW timeout would block.
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
          if (typeof value === "number" && !Number.isNaN(value)) {
            el.currentTime = Math.max(0, value);
          }
          break;
        case "seekBy":
          if (typeof value === "number" && !Number.isNaN(value)) {
            el.currentTime = Math.max(0, (el.currentTime || 0) + value);
          }
          break;
        case "playbackRate":
          if (typeof value === "number" && value > 0) el.playbackRate = value;
          break;
        case "volume":
          if (typeof value === "number") {
            el.volume = Math.max(0, Math.min(1, value));
          }
          break;
        case "fullscreen":
          if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
          break;
        case "pip":
          if (typeof el.requestPictureInPicture === "function") {
            el.requestPictureInPicture().catch(() => {});
          }
          break;
        default:
          return { ok: false, error: `unknown action: ${action}` };
      }
      return {
        ok: true,
        action,
        state: {
          currentTime: el.currentTime,
          paused: el.paused,
          muted: el.muted,
          volume: el.volume,
          playbackRate: el.playbackRate,
        },
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message) || "control failed" };
    }
  }

  function _pageMediaCaptions(index) {
    const list = Array.from(document.querySelectorAll("video, audio"));
    const el = list[index || 0];
    if (!el) return { ok: false, error: "media element not found" };
    const out = [];
    const tracks = el.textTracks || [];
    for (let t = 0; t < tracks.length; t++) {
      const tr = tracks[t];
      const cues = [];
      const cueList = tr.cues || tr.activeCues || [];
      for (let c = 0; c < cueList.length; c++) {
        const cue = cueList[c];
        cues.push({
          start: cue.startTime,
          end: cue.endTime,
          text: String(cue.text || "").slice(0, 500),
        });
      }
      out.push({
        index: t,
        kind: tr.kind,
        label: tr.label,
        language: tr.language,
        mode: tr.mode,
        cues,
      });
    }
    // YouTube fallback: pull DOM-rendered caption segments if no TextTrack cues.
    if (out.every((t) => t.cues.length === 0)) {
      const ytSegs = Array.from(
        document.querySelectorAll(".ytp-caption-segment, .caption-window .ytp-caption-segment"),
      ).map((n) => (n.textContent || "").trim()).filter(Boolean);
      if (ytSegs.length) {
        out.push({ index: -1, kind: "dom-fallback", label: "youtube-dom", cues: [{ start: el.currentTime, end: el.currentTime + 2, text: ytSegs.join(" ") }] });
      }
    }
    return { ok: true, tracks: out };
  }

  function _pageMediaCaptureFrame(index, mimeType, quality) {
    const list = Array.from(document.querySelectorAll("video"));
    const el = list[index || 0];
    if (!el) return { ok: false, error: "video element not found" };
    if (!el.videoWidth || !el.videoHeight) {
      return { ok: false, error: "video not ready (no dimensions)" };
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL(mimeType || "image/png", quality || 0.92);
      return {
        ok: true,
        index: index || 0,
        width: canvas.width,
        height: canvas.height,
        currentTime: el.currentTime,
        dataUrl,
      };
    } catch (err) {
      // CORS-tainted canvas → toDataURL throws SecurityError.
      return { ok: false, error: String(err && err.message) || "capture failed" };
    }
  }

  function _pageMediaSampleFrames(index, count, fromSec, toSec, mimeType, quality) {
    return new Promise((resolve) => {
      const list = Array.from(document.querySelectorAll("video"));
      const el = list[index || 0];
      if (!el) return resolve({ ok: false, error: "video element not found" });
      if (!Number.isFinite(el.duration) || el.duration <= 0) {
        return resolve({ ok: false, error: "video duration unknown" });
      }
      const n = Math.max(1, Math.min(20, count || 4));
      const start = Math.max(0, fromSec ?? 0);
      const end = Math.min(el.duration, toSec ?? el.duration);
      if (end <= start) return resolve({ ok: false, error: "invalid range" });
      const times = [];
      for (let i = 0; i < n; i++) {
        times.push(start + ((end - start) * (i + 0.5)) / n);
      }
      const wasPaused = el.paused;
      const prevTime = el.currentTime;
      const frames = [];
      const canvas = document.createElement("canvas");
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      const ctx = canvas.getContext("2d");
      let i = 0;
      const seekNext = () => {
        if (i >= times.length) {
          try { el.currentTime = prevTime; } catch (_) {}
          if (!wasPaused) el.play().catch(() => {});
          return resolve({ ok: true, count: frames.length, frames });
        }
        const onSeeked = () => {
          el.removeEventListener("seeked", onSeeked);
          try {
            ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
            frames.push({
              t: el.currentTime,
              dataUrl: canvas.toDataURL(mimeType || "image/jpeg", quality || 0.7),
            });
          } catch (err) {
            frames.push({ t: el.currentTime, error: String(err && err.message) });
          }
          i++;
          seekNext();
        };
        el.addEventListener("seeked", onSeeked);
        try {
          el.pause();
          el.currentTime = times[i];
        } catch (err) {
          el.removeEventListener("seeked", onSeeked);
          frames.push({ t: times[i], error: String(err && err.message) });
          i++;
          seekNext();
        }
      };
      seekNext();
    });
  }

  function _pageImageList(limit) {
    const out = [];
    const imgs = Array.from(document.querySelectorAll("img"));
    const cap = Math.min(imgs.length, limit || 60);
    for (let i = 0; i < cap; i++) {
      const img = imgs[i];
      const rect = img.getBoundingClientRect();
      out.push({
        index: i,
        src: img.currentSrc || img.src,
        alt: img.alt || "",
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      });
    }
    return { count: imgs.length, returned: out.length, images: out };
  }

  // Resolve a page image to base64. Uses fetch (preferred — bypasses canvas
  // CORS tainting issues for cross-origin images served with CORS headers).
  // Returns Promise resolving to { ok, dataUrl }.
  function _pageImageGetData(index, selector) {
    return new Promise((resolve) => {
      let img = null;
      if (typeof index === "number") {
        img = document.querySelectorAll("img")[index] || null;
      } else if (selector) {
        const node = document.querySelector(selector);
        if (node && node.tagName === "IMG") img = node;
      }
      if (!img) return resolve({ ok: false, error: "image not found" });
      const src = img.currentSrc || img.src;
      if (!src) return resolve({ ok: false, error: "image has no src" });
      // Try fetch first.
      fetch(src, { credentials: "include" })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("HTTP " + r.status))))
        .then((blob) => new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(blob);
        }))
        .then((dataUrl) => resolve({
          ok: true,
          src,
          dataUrl,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }))
        .catch(() => {
          // Canvas fallback (will fail on tainted canvases).
          try {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext("2d").drawImage(img, 0, 0);
            resolve({ ok: true, src, dataUrl: c.toDataURL("image/png"),
              naturalWidth: c.width, naturalHeight: c.height });
          } catch (err) {
            resolve({ ok: false, error: "Cross-origin image — cannot read: " + (err && err.message) });
          }
        });
    });
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

  // ── SW-side tool handlers (bound at registration) ────────────────────
  // These all expect `this` to be a context object exposing
  // { getActiveTab, executeInTab, sendToOffscreen } — assigned by SW.

  function makeHandlers(ctx) {
    const { getActiveTab, executeInTab, sendToOffscreen } = ctx;

    return {
      media_list: async () => {
        const tab = await getActiveTab();
        return executeInTab(tab.id, _pageMediaList, []);
      },
      media_control: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(
          tab.id,
          _pageMediaControl,
          [params?.index, params?.selector, params?.action || "toggle", params?.value],
        );
      },
      media_get_captions: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(tab.id, _pageMediaCaptions, [params?.index || 0]);
      },
      media_capture_frame: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(
          tab.id,
          _pageMediaCaptureFrame,
          [params?.index || 0, params?.mimeType, params?.quality],
        );
      },
      media_sample_frames: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(
          tab.id,
          _pageMediaSampleFrames,
          [
            params?.index || 0,
            params?.count || 4,
            params?.fromSec,
            params?.toSec,
            params?.mimeType,
            params?.quality,
          ],
        );
      },
      image_list: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(tab.id, _pageImageList, [params?.limit || 60]);
      },
      image_get_data: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(
          tab.id,
          _pageImageGetData,
          [params?.index, params?.selector],
        );
      },
      macro_record_start: async () => {
        const tab = await getActiveTab();
        return executeInTab(tab.id, _pageMacroInstall, []);
      },
      macro_record_stop: async () => {
        const tab = await getActiveTab();
        return executeInTab(tab.id, _pageMacroStop, []);
      },
      macro_replay: async (params) => {
        const tab = await getActiveTab();
        return executeInTab(
          tab.id,
          _pageMacroReplay,
          [params?.events || [], params?.speed || 1],
        );
      },
      tab_recording_start: async (params) => {
        const tab = await getActiveTab();
        // chrome.tabCapture.getMediaStreamId must be invoked from a user
        // gesture context in the page; from the SW we use targetTabId.
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
        });
      },
      tab_recording_stop: async () => sendToOffscreen({ type: "AUTODOM_REC_STOP" }),
      tab_recording_status: async () => sendToOffscreen({ type: "AUTODOM_REC_STATUS" }),
    };
  }

  // ─── Tool catalog (exposed to the AI) ───────────────────────────────
  const CATALOG = [
    {
      name: "media_list",
      description: "List all <video> and <audio> elements on the active page with their state (currentTime, paused, duration, dimensions, indexes). Use the returned `index` with other media_* tools.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "media_control",
      description: "Control playback of a <video>/<audio>. Provide `index` (from media_list) or `selector`. Actions: play, pause, toggle, mute, unmute, seekTo, seekBy, playbackRate, volume, fullscreen, pip. Pass `value` (number) for seekTo/seekBy (seconds), playbackRate (e.g. 1.5), volume (0–1).",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer" },
          selector: { type: "string" },
          action: { type: "string", enum: ["play","pause","toggle","mute","unmute","seekTo","seekBy","playbackRate","volume","fullscreen","pip"] },
          value: { type: "number" },
        },
        required: ["action"],
      },
    },
    {
      name: "media_get_captions",
      description: "Return active TextTrack cues (subtitles/captions) for a video. Falls back to scraping YouTube DOM caption segments if no programmatic tracks are exposed.",
      parameters: { type: "object", properties: { index: { type: "integer" } } },
    },
    {
      name: "media_capture_frame",
      description: "Capture the CURRENT frame of a <video> as a base64 PNG/JPEG dataURL. Will fail with a CORS error on tainted videos (cross-origin without CORS headers).",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer" },
          mimeType: { type: "string", description: "image/png or image/jpeg" },
          quality: { type: "number", description: "0–1 (jpeg only)" },
        },
      },
    },
    {
      name: "media_sample_frames",
      description: "Sample N evenly-spaced frames from a <video>. Pauses, seeks, captures, then restores play state. Useful for video summarisation by vision models.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer" },
          count: { type: "integer", description: "1–20 (default 4)" },
          fromSec: { type: "number" },
          toSec: { type: "number" },
          mimeType: { type: "string" },
          quality: { type: "number" },
        },
      },
    },
    {
      name: "image_list",
      description: "Enumerate <img> elements on the page with src, alt, natural dimensions, and bounding box.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "default 60" } },
      },
    },
    {
      name: "image_get_data",
      description: "Fetch a page image's bytes as base64 dataURL (uses fetch with credentials, falls back to canvas). Returns CORS error if the image is cross-origin without CORS headers.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index from image_list" },
          selector: { type: "string" },
        },
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
      description: "Start recording the active tab to a WebM video via tabCapture + MediaRecorder (runs in the offscreen document). Requires a user gesture in some contexts; if blocked, surface this through the chat panel.",
      parameters: {
        type: "object",
        properties: {
          mimeType: { type: "string" },
          videoBitsPerSecond: { type: "integer" },
        },
      },
    },
    {
      name: "tab_recording_stop",
      description: "Stop the active tab recording. Returns an objectURL + size; the chat panel can download it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "tab_recording_status",
      description: "Query whether a tab recording is in progress.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  // action-gate tiers for the new tools.
  const TIERS = {
    safeRead: new Set([
      "media_list",
      "media_get_captions",
      "media_capture_frame",
      "media_sample_frames",
      "image_list",
      "image_get_data",
      "macro_record_stop",
      "tab_recording_status",
    ]),
    // tab/macro recorders mutate user-visible state OR persist data; require
    // confirmation. media_control is plain mutating.
    destructive: new Set([
      "macro_record_start",
      "macro_replay",
      "tab_recording_start",
      "tab_recording_stop",
    ]),
  };

  globalThis.AutoDOMMediaTools = {
    makeHandlers,
    catalog: CATALOG,
    tiers: TIERS,
    // Exported for unit tests.
    _pageHelpers: {
      _pageMediaList,
      _pageMediaControl,
      _pageMediaCaptions,
      _pageImageList,
      _pageMacroInstall,
      _pageMacroStop,
      _pageMacroReplay,
    },
  };
})();
