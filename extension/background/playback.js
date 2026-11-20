// Playback evidence lives in the extension's isolated world in the selected
// document. The service worker retains only an opaque handle and its owner.
(function () {
  const entries = new Map();
  const storageKey = "autodom.completedPlaybackRoutes";
  let executePage, restored, writing = Promise.resolve();
  function inject(entry, op, params) {
    return executePage(entry.tabId, playbackPage, [op, { ...params, verificationId: entry.id }],
      "ISOLATED", entry.frameId, entry.documentId);
  }
  function saveRoutes() {
    const storage = globalThis.chrome?.storage?.session;
    if (!storage) return Promise.resolve();
    writing = writing.catch(() => {}).then(() => {
      const routes = [...entries.values()].filter(e => e.expiresAt).map(
        ({ id, owner, tabId, frameId, documentId, expiresAt }) =>
          ({ id, owner, tabId, frameId, ...(documentId && { documentId }), expiresAt })
      );
      return routes.length ? storage.set({ [storageKey]: routes }) : storage.remove(storageKey);
    });
    return writing;
  }
  function restoreRoutes() {
    if (!restored) restored = (async () => {
      const storage = globalThis.chrome?.storage?.session;
      if (!storage) return;
      const saved = (await storage.get(storageKey))[storageKey] || [];
      const now = Date.now();
      for (const entry of saved) {
        if (entry.expiresAt <= now) continue;
        entries.set(entry.id, entry);
        entry.timer = setTimeout(() => remove(entry), entry.expiresAt - now);
      }
      if (saved.length !== entries.size) await saveRoutes();
    })();
    return restored;
  }
  const owner = ctx => JSON.stringify([ctx?.origin || "bridge", ctx?.clientId ?? null]);

  // Serialized by chrome.scripting.executeScript. No closure dependencies.
  async function playbackPage(op, a) {
    const key = Symbol.for("autodom.playback.evidence");
    const records = globalThis[key] ||= new Map();
    const id = a.verificationId;
    const rec = records.get(id);
    const error = message => ({ ok: false, error: message });
    if (op === "release") {
      rec?.release();
      return { ok: true };
    }
    if (op === "read") {
      if (!rec?.ready || Date.now() >= rec.expiresAt) {
        rec?.release();
        return error("Playback evidence expired or document changed");
      }
      return rec.read(a);
    }
    // The legacy id registry belongs to MAIN. One composed event passes the
    // actual selected DOM node into ISOLATED. Its random name is independent
    // of the private evidence id. No shared attributes or selectors are used.
    if (op === "arm") {
      if (rec) return error("Duplicate playback verification");
      const pin = { element: null, release() {
        document.removeEventListener(a.eventName, captureTarget, true);
        clearTimeout(timer);
        records.delete(id);
        pin.element = null;
      } };
      function captureTarget(event) {
        pin.element = event.composedPath()[0];
        document.removeEventListener(a.eventName, captureTarget, true);
      }
      const timer = setTimeout(pin.release, 5000);
      records.set(id, pin);
      document.addEventListener(a.eventName, captureTarget, true);
      return { ok: true };
    }
    if (op !== "observe" || !rec || !("element" in rec)) return error("Media target handoff expired");
    const el = rec.element;
    rec.release();
    if (!el || el.isConnected === false || el.tagName !== a.tag) return error("Media target changed before observation");

    const video = el.tagName === "VIDEO";
    const rvfc = video && typeof el.requestVideoFrameCallback === "function";
    const durationMs = a.durationSec * 1000;
    const budget = 16 * 1024 * 1024;
    const start = performance.now();
    const elapsed = () => Math.min(durationMs, Math.max(0, performance.now() - start));
    const round = n => Math.round(n * 1000) / 1000;
    const sec = ms => round(ms / 1000);
    const trackedEvents = ["waiting", "stalled", "playing", "pause", "ended", "seeking", "seeked", "emptied", "loadstart", "encrypted", "error"];
    const chunks = Array.from({ length: Math.ceil(a.durationSec) }, (_, i) => ({
      chunkIndex: i, startSec: i, endSec: Math.min(i + 1, a.durationSec),
      observed: 0, signatures: 0, recoveredFrames: 0, edgeFrames: 0, missedCallbacks: 0, images: 0, skippedEncodes: 0,
      mediaStart: null, mediaEnd: null, frames: [], events: [], captions: []
    }));
    const bucket = ms => chunks[Math.min(chunks.length - 1, Math.floor(ms / 1000))];
    const counters = { observed: 0, signatures: 0, recoveredFrames: 0, edgeFrames: 0, missedCallbacks: 0, skippedEncodes: 0, images: 0, truncatedEvents: 0, truncatedCues: 0 };
    const skips = {};
    const coverage = new Set();
    const times = [], processingTimes = [];
    // Reserve conservative bounds for serialized rows and cues; blobs use
    // exact byte sizes. Timing takes precedence if it needs an image's space.
    let retainedBytes = 2048 + chunks.length * 512, peakRetainedBytes = retainedBytes;
    const retainedImages = [];
    function reserve(bytes, timing) {
      while (timing && retainedBytes + bytes > budget && retainedImages.length) {
        const row = retainedImages.pop();
        retainedBytes -= row.blob.size;
        delete row.blob;
        counters.images--;
        chunks[row.chunkIndex].images--;
        skipped(row, "evicted-for-timing");
      }
      if (retainedBytes + bytes > budget) return false;
      retainedBytes += bytes;
      peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);
      return true;
    }
    let alive = true, finished = false, stopped = false, segment = 0;
    let callback, poll, deadline, expiry, drainDeadline, resolveObservation;
    let priorCounter = null, priorMedia = null, priorElapsed = null, priorLuma = null;
    let lastPresentationAt = start, maxPresentationGapMs = 0;
    let progressAt = start, progressTime = el.currentTime, stalledAt = null, stallMs = 0;
    let observedProgress = false, waited = false, wasPaused = !!el.paused;
    let source = el.currentSrc, stream = el.srcObject;
    let protectedContent = !!el.mediaKeys;
    const removers = [];
    const listen = (target, name, fn) => {
      target?.addEventListener?.(name, fn);
      removers.push(() => target?.removeEventListener?.(name, fn));
    };
    function addEvent(name, ms = elapsed()) {
      const chunk = bucket(ms);
      if (chunk.events.length >= 40 || !reserve(192, true)) { counters.truncatedEvents++; return; }
      chunk.events.push({ type: name, elapsedSec: sec(ms), mediaTime: round(el.currentTime), segment });
    }
    function boundary(reason) {
      segment++;
      priorCounter = priorMedia = priorElapsed = priorLuma = priorPts = null;
      progressAt = performance.now();
      progressTime = el.currentTime;
      addEvent(reason);
    }
    function checkSource() {
      if (source !== el.currentSrc || stream !== el.srcObject) {
        source = el.currentSrc;
        stream = el.srcObject;
        protectedContent = !!el.mediaKeys;
        unreadable = false;
        if (tiny) tiny.node.width = 16; // discard a preceding source's tainted bitmap
        boundary("source-change");
        previousCue = "";
      }
    }
    // A hidden/paused/seeking interval is never diagnosed as a playback stall.
    function checkProgress() {
      const now = Math.min(performance.now(), start + durationMs);
      checkSource();
      const t = el.currentTime;
      if (el.isConnected === false) coverage.add("target-detached");
      const active = el.isConnected !== false && !el.paused && !el.ended && !el.seeking && !document.hidden;
      if (!active) lastPresentationAt = now;
      else if (rvfc) maxPresentationGapMs = Math.max(maxPresentationGapMs, now - lastPresentationAt);
      if (document.hidden) coverage.add("hidden-tab");
      if (el.mediaKeys) protectedContent = true;
      if (protectedContent) coverage.add("protected-video");
      if (el.paused) wasPaused = true;
      const moved = Math.abs(t - progressTime) >= 0.005;
      if (active && moved) observedProgress = true;
      if (!active || moved) {
        if (stalledAt !== null) {
          stallMs += now - stalledAt;
          addEvent("stall-end");
          stalledAt = null;
        }
        progressTime = t;
        progressAt = now;
      } else if (stalledAt === null && now - progressAt >= 500 && now - start >= 500) {
        stalledAt = progressAt;
        addEvent("stall-start", Math.max(0, progressAt - start));
      }
      if (!active || protectedContent || unreadable) setProbeInterval(0);
      readCaptions();
    }
    let previousCue = "";
    function readCaptions() {
      const cues = [];
      for (const track of Array.from(el.textTracks || [])) {
        if (!["captions", "subtitles"].includes(track.kind) || track.mode === "disabled") continue;
        for (const cue of Array.from(track.activeCues || []).slice(0, 4)) {
          if (typeof cue.text === "string") cues.push({ language: String(track.language || "").slice(0, 32),
            start: round(cue.startTime), end: round(cue.endTime), text: cue.text.slice(0, 512) });
        }
        if (cues.length >= 4) break;
      }
      const identity = JSON.stringify(cues);
      const group = bucket(elapsed());
      if (identity !== previousCue || (cues.length && !group.captions.length)) {
        for (const cue of cues) {
          if (group.captions.length < 8 && reserve(192 + 4 * (cue.text.length + cue.language.length), true)) group.captions.push({ ...cue, elapsedSec: sec(elapsed()), segment });
          else counters.truncatedCues++;
        }
      }
      previousCue = identity;
    }
    const quality = () => {
      const q = video && el.getVideoPlaybackQuality?.();
      return q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null;
    };
    let previousQuality = quality();
    const decoder = previousQuality ? { dropped: 0, total: 0 } : null;
    function updateQuality() {
      const now = quality();
      if (!now || !decoder) return 0;
      const drops = now.dropped >= previousQuality.dropped ? now.dropped - previousQuality.dropped : now.dropped;
      decoder.dropped += drops;
      decoder.total += now.total >= previousQuality.total ? now.total - previousQuality.total : now.total;
      previousQuality = now;
      return drops;
    }

    // Keep two tiny reusable luminance buffers. Scene cuts include large
    // local changes so a one-frame marker need not cover the whole image.
    function canvas(w, h, frequent = false) {
      const node = document.createElement("canvas");
      node.width = w;
      node.height = h;
      return { node, ctx: node.getContext("2d", { alpha: false, willReadFrequently: frequent }) };
    }
    const tiny = rvfc ? canvas(16, 9, true) : null;
    const luma = [new Uint8Array(144), new Uint8Array(144)];
    let lumaIndex = 0, unreadable = false;
    function fingerprint(row, src) {
      tiny.ctx.drawImage(src, 0, 0, 16, 9);
      const pixels = tiny.ctx.getImageData(0, 0, 16, 9).data;
      const current = luma[lumaIndex ^= 1];
      let hash = 2166136261, total = 0, maxDelta = 0, diff = 0, changed = 0;
      for (let i = 0; i < 144; i++) {
        const j = i * 4;
        const y = current[i] = (77 * pixels[j] + 150 * pixels[j + 1] + 29 * pixels[j + 2]) >>> 8;
        hash = Math.imul(hash ^ y, 16777619);
        total += y;
        if (priorLuma) {
          const delta = Math.abs(y - priorLuma[i]);
          diff += delta;
          if (delta >= 32) changed++;
          maxDelta = Math.max(maxDelta, delta);
        }
      }
      row.signature = (hash >>> 0).toString(16).padStart(8, "0");
      row.meanLuma = Math.round(total / 144);
      row.changeScore = priorLuma ? Math.round(diff / 144) : 0;
      row.sceneChange = !!priorLuma && (diff / 144 >= 18 || (changed <= 3 && maxDelta >= 112));
      priorLuma = current;
    }

    // Copy pixels synchronously while the callback refers to this frame.
    // Each encoding uses a separate snapshot, never a live video reference.
    const jobs = new Set(), pool = [];
    let rolling = null, last = null;
    const thumbnail = (sourceW, sourceH) => {
      const scale = Math.min(1, 192 / Math.max(1, sourceW), 144 / Math.max(1, sourceH));
      const w = Math.max(1, Math.round(sourceW * scale)), h = Math.max(1, Math.round(sourceH * scale));
      const out = pool.pop() || canvas(w, h, true);
      if (out.node.width !== w) out.node.width = w;
      if (out.node.height !== h) out.node.height = h;
      return out;
    };
    function skipped(row, why) {
      if (row.imageStatus === "skipped") return;
      row.imageStatus = "skipped";
      row.skipReason = why;
      counters.skippedEncodes++;
      chunks[row.chunkIndex].skippedEncodes++;
      skips[why] = (skips[why] || 0) + 1;
    }
    function queue(row, snapshot, reason) {
      if (!snapshot || row.imageStatus !== "not-selected") return;
      row.imageReason = reason;
      if (jobs.size >= 3) return skipped(row, "queue-full");
      if (retainedBytes >= budget) return skipped(row, "byte-budget");
      const { width, height } = snapshot.node;
      row.imageStatus = "pending";
      const job = { row };
      jobs.add(job);
      const complete = blob => {
        if (!jobs.delete(job)) return;
        if (!alive) return;
        if (!blob || blob.type !== "image/webp") skipped(row, "encode-failed");
        else if (!reserve(blob.size, false)) skipped(row, "byte-budget");
        else {
          retainedImages.push(row);
          row.blob = blob;
          row.width = width;
          row.height = height;
          row.imageStatus = "retained";
          counters.images++;
          chunks[row.chunkIndex].images++;
        }
        if (stopped && jobs.size === 0) finish();
      };
      // toBlob snapshots the bitmap before returning and encodes that copy
      // asynchronously. The rolling canvas can be reused by the next frame.
      try { snapshot.node.toBlob(complete, "image/webp", 0.55); }
      catch (_) { complete(null); }
    }

    // VideoFrame(video) pins the decoder surface and exposes its own media
    // PTS. Reading the live video element later can return a neighboring frame.
    // Match nearby snapshots by PTS before consuming rows in presentation order.
    const pending = [], snapshots = [];
    let processTimer, surfaceTimer, processedSegment = null;
    let probeInterval = 0, probeCount = 0, probeWorkMs = 0;
    function setProbeInterval(ms) {
      if (ms === probeInterval) return;
      clearInterval(surfaceTimer);
      probeInterval = ms;
      surfaceTimer = ms ? setInterval(probeSurface, ms) : undefined;
    }
    let priorPts = null, lastPin = null, firstSurfacePts = null, finalSurfacePts = null;
    // Chromium can coalesce main-thread presentation callbacks while its
    // compositor advances. Briefly pin distinct live surfaces between callbacks.
    // The callback counters remain the authority on how many presentations occurred.
    function pinSurface() {
      const frame = new VideoFrame(el);
      const pts = frame.timestamp / 1e6;
      if (!Number.isFinite(pts) || (lastPin?.segment === segment && lastPin.pts === pts)) {
        frame.close();
        return Number.isFinite(pts) ? pts : null;
      }
      lastPin = { pts, segment };
      snapshots.push({ frame, pts, segment, ms: elapsed() });
      if (snapshots.length > 6) snapshots.shift().frame.close();
      return pts;
    }
    function probeSurface() {
      if (document.hidden || el.paused || el.ended || el.seeking || el.isConnected === false ||
          protectedContent || el.mediaKeys || unreadable || el.readyState < 2) return;
      const began = performance.now();
      checkSource();
      try { return pinSurface(); }
      catch (err) {
        if (err.name === "SecurityError") {
          unreadable = true;
          coverage.add("unreadable-pixels");
        }
      }
      finally { probeCount++; probeWorkMs += performance.now() - began; }
    }
    function recordSurfaces(pins, counter) {
      for (const pin of pins) {
        const ms = Math.max(priorElapsed ?? 0, pin.ms);
        const group = bucket(ms);
        if (!reserve(512, true)) break;
        const row = { chunkIndex: group.chunkIndex, elapsedSec: Math.floor(ms * 1000) / 1e6,
          mediaTime: round(pin.pts), presentedFrames: null, segment, imageStatus: "not-selected", observationSource: "live-surface" };
        group.frames.push(row);
        group.mediaStart ??= row.mediaTime;
        group.mediaEnd = row.mediaTime;
        group.firstSegment ??= segment;
        group.lastSegment = segment;
        pending.push({ row, pts: pin.pts, flags: { surfaceCounter: counter } });
      }
    }
    function surfacesBetween(lower, upper) {
      return snapshots.filter(s => s.segment === segment && s.pts > lower && s.pts < upper)
        .sort((a, b) => a.pts - b.pts);
    }
    function recover(missed, pts) {
      if (el.seeking || protectedContent || el.mediaKeys || unreadable) return;
      if (priorPts === null) {
        if (segment === 0 && firstSurfacePts != null) {
          recordSurfaces(surfacesBetween(firstSurfacePts - .0001, pts - .0001), "edgeFrames");
        }
      } else if (missed && pts > priorPts) {
        const pins = surfacesBetween(priorPts + .0001, pts - .0001);
        // Extra candidates make the correspondence ambiguous.
        if (pins.length <= missed) recordSurfaces(pins, "recoveredFrames");
      }
    }
    function analyse(row, flags, image) {
      const workStart = performance.now();
      const { missed, dropped, gap } = flags;
      if (processedSegment !== row.segment) priorLuma = null;
      processedSegment = row.segment;
      try {
        const current = thumbnail(image.displayWidth || el.videoWidth, image.displayHeight || el.videoHeight);
        current.ctx.drawImage(image, 0, 0, current.node.width, current.node.height);
        fingerprint(row, current.node);
        counters.signatures++;
        chunks[row.chunkIndex].signatures++;
        if (flags.surfaceCounter) {
          counters[flags.surfaceCounter]++;
          chunks[row.chunkIndex][flags.surfaceCounter]++;
        }
        const anomaly = missed || dropped || gap || (row.meanLuma < 5 && last?.meanLuma >= 5);
        const reason = !last || last.segment !== row.segment ? "start" : row.sceneChange ? "scene-change" : anomaly ? "anomaly" : null;
        if (a.mode === "smart" && reason && last) queue(last, rolling, "before-" + reason);
        if (rolling) pool.push(rolling);
        rolling = current;
        if (a.mode === "detailed" || reason) queue(row, rolling, reason || "frame");
        last = row;
      } catch (err) {
        const why = err.name === "SecurityError" ? "unreadable-pixels" : "frame-read-failed";
        unreadable = why === "unreadable-pixels";
        coverage.add(why);
        skipped(row, why);
      }
      processingTimes.push(performance.now() - workStart);
    }
    function processPending(flush) {
      clearTimeout(processTimer);
      processTimer = undefined;
      while (pending.length) {
        const { row, flags, pts } = pending[0];
        const index = snapshots.findIndex(s => s.segment === row.segment && Math.abs(s.pts - pts) < 0.0001);
        if (index < 0 && !flush && pending.length < 3) break;
        pending.shift();
        if (index < 0) {
          skipped(row, "pixel-timestamp-mismatch");
          coverage.add("pixel-timestamp-mismatch");
          continue;
        }
        const [{ frame, pts: pixelTime }] = snapshots.splice(index, 1);
        row.pixelMediaTime = pixelTime;
        row.pixelAlignment = "verified-pts";
        try { analyse(row, flags, frame); }
        finally { frame.close(); }
      }
      if (flush) for (const s of snapshots.splice(0)) s.frame.close();
    }
    function capture(row, flags, pts) {
      if (protectedContent || unreadable) return skipped(row, protectedContent ? "protected-video" : "unreadable-pixels");
      if (typeof VideoFrame !== "function") {
        // On insecure origins WebCodecs may be unavailable. Canvas evidence
        // is tied only to this callback; it cannot certify an exact-frame PTS.
        row.pixelAlignment = "callback-only";
        coverage.add("approximate-pixel-timestamp");
        analyse(row, flags, el);
        return;
      }
      try {
        pinSurface();
        pending.push({ row, flags, pts });
        if (pending.length >= 8) processPending(false);
        if (processTimer === undefined) processTimer = setTimeout(() => processPending(false), 0);
      } catch (err) {
        const why = err.name === "SecurityError" ? "unreadable-pixels" : "frame-snapshot-failed";
        unreadable = why === "unreadable-pixels";
        coverage.add(why);
        skipped(row, why);
      }
    }

    function frame(_now, meta) {
      if (!alive || stopped) return;
      const workStart = performance.now();
      lastPresentationAt = workStart;
      if (workStart - start >= durationMs) { stop(); return; }
      callback = el.requestVideoFrameCallback(frame);
      checkSource();
      const ms = elapsed();
      const group = bucket(ms);
      const t = round(meta.mediaTime);
      const count = Number.isFinite(meta.presentedFrames) ? meta.presentedFrames : null;
      if (priorMedia !== null && t + 0.02 < priorMedia) boundary("media-time-discontinuity");
      const missed = priorCounter !== null && count !== null ? Math.max(0, count - priorCounter - 1) : 0;
      const dropped = updateQuality();
      if (typeof VideoFrame === "function" && !document.hidden && !el.paused && !el.ended && !el.seeking &&
          !protectedContent && !el.mediaKeys && !unreadable) {
        const period = priorPts !== null && el.playbackRate > 0
          ? (meta.mediaTime - priorPts) * 1000 / ((missed + 1) * el.playbackRate) : 0;
        setProbeInterval(period >= 28 ? 10 : 5);
      }
      if (!dropped) recover(missed, meta.mediaTime);
      priorPts = meta.mediaTime;
      const gap = priorElapsed !== null && ms - priorElapsed > 500;
      const row = { chunkIndex: group.chunkIndex, elapsedSec: Math.floor(ms * 1000) / 1e6, mediaTime: t, presentedFrames: count, segment, imageStatus: "not-selected" };
      if (missed) row.missedCallbacks = missed;
      if (dropped) row.browserDrops = dropped;
      if (gap) row.presentationGap = true;
      counters.observed++;
      counters.missedCallbacks += missed;
      group.observed++;
      group.missedCallbacks += missed;
      group.mediaStart ??= t;
      group.mediaEnd = t;
      if (!reserve(512, true)) {
        counters.truncatedFrameMetadata = (counters.truncatedFrameMetadata || 0) + 1;
        skipped(row, "byte-budget");
        priorCounter = count;
        priorMedia = t;
        priorElapsed = ms;
        return;
      }
      group.firstSegment ??= segment;
      group.lastSegment = segment;
      group.frames.push(row);
      priorCounter = count;
      priorMedia = t;
      priorElapsed = ms;
      if (el.mediaKeys) protectedContent = true;
      capture(row, { missed, dropped, gap }, meta.mediaTime);
      times.push(performance.now() - workStart);
    }

    function stopListeners() {
      clearTimeout(deadline);
      clearInterval(poll);
      setProbeInterval(0);
      if (callback !== undefined) el.cancelVideoFrameCallback?.(callback);
      for (const off of removers.splice(0)) off();
    }
    function abandonJobs(reason) {
      for (const job of jobs) {
        skipped(job.row, reason);
      }
      jobs.clear();
    }
    function stop() {
      if (stopped || !alive) return;
      stopListeners();
      if (typeof VideoFrame === "function" && priorPts != null && el.readyState >= 2) {
        finalSurfacePts = probeSurface() ?? null;
        if (priorPts != null && finalSurfacePts != null) {
          recordSurfaces(surfacesBetween(priorPts + .0001, finalSurfacePts + .0001), "edgeFrames");
        }
      }
      processPending(true);
      stopped = true;
      if (performance.now() > start + durationMs + 250) coverage.add("delayed-observation-end");
      checkProgress();
      updateQuality();
      if (last && a.mode === "smart") queue(last, rolling, "end");
      rolling = null;
      if (!jobs.size) finish();
      else drainDeadline = setTimeout(() => { abandonJobs("encode-timeout"); finish(); }, 750);
    }
    function release() {
      if (!alive) return;
      alive = false;
      stopListeners();
      clearTimeout(processTimer);
      pending.length = 0;
      for (const s of snapshots.splice(0)) s.frame.close();
      clearTimeout(drainDeadline);
      clearTimeout(expiry);
      abandonJobs("cancelled");
      records.delete(id);
      resolveObservation?.(error("Playback observation cancelled or document changed"));
    }
    function finish() {
      if (!alive || finished) return;
      finished = true;
      clearTimeout(drainDeadline);
      pool.length = 0;
      retainedImages.length = 0;
      rolling = null;
      const record = records.get(id);
      record.ready = true;
      record.expiresAt = Date.now() + 120000;
      expiry = setTimeout(release, 120000);
      if (!video) coverage.add("audio-only");
      else if (!rvfc) coverage.add("frame-callback-unavailable");
      if (rvfc && !counters.observed) coverage.add("no-presented-frames");
      if (!video || !decoder) coverage.add("decoder-counters-unavailable");
      if (protectedContent) coverage.add("protected-video");
      counters.unrecoveredCallbacks = counters.missedCallbacks - counters.recoveredFrames;
      if (counters.unrecoveredCallbacks) coverage.add("unrecovered-presentations");
      let health = "inconclusive";
      if (el.error) health = "error";
      else if (coverage.has("target-detached")) health = "target-detached";
      else if (el.ended) health = "ended";
      else if (el.paused) health = "paused";
      else if (stalledAt !== null || stallMs > 0) health = "stalled";
      else if (video && observedProgress && (!rvfc || counters.observed < 2)) health = "clock-progress-only";
      else if (rvfc && observedProgress && maxPresentationGapMs >= 750) health = "presentation-gap";
      else if (observedProgress) health = "progressing";
      const stallDuration = stallMs + (stalledAt === null ? 0 : Math.max(0, start + durationMs - stalledAt));
      function durations(samples) {
        samples.sort((x, y) => x - y);
        const quantile = f => samples.length ? round(samples[Math.ceil(samples.length * f) - 1]) : null;
        return { p50: quantile(0.5), p95: quantile(0.95) };
      }
      function highlights(frames) {
        return frames.flatMap((row, offset) => row.imageStatus === "retained" ? [{ row, offset }] : [])
          .sort((a, b) => {
            const rank = ({ row }) => (row.missedCallbacks || row.browserDrops || row.presentationGap ? 512 : 0) +
              row.changeScore + (row.imageReason === "start" || row.imageReason === "end" ? 1 : 0);
            return rank(b) - rank(a);
          }).slice(0, 4).map(({ row, offset }) => ({
            offset, mediaTime: row.mediaTime, elapsedSec: row.elapsedSec, reason: row.imageReason, changeScore: row.changeScore
          }));
      }
      resolveObservation({ ok: true, verificationId: id, mode: a.mode, durationSec: a.durationSec,
        health, clockProgress: observedProgress, longestPresentationGapSec: sec(maxPresentationGapMs), stallSec: sec(stallDuration), pausedDuringObservation: wasPaused, waitingEvent: waited,
        counters, skipReasons: skips, decoder, coverage: [...coverage], audibleOutput: "unverified",
        ...(segment === 0 && firstSurfacePts != null && finalSurfacePts != null && {
          pixelWindow: { startMediaTime: firstSurfacePts, endMediaTime: finalSurfacePts }
        }),
        surfaceProbe: { calls: probeCount, totalMs: round(probeWorkMs) },
        callbackMs: durations(times), frameProcessingMs: durations(processingTimes), peakRetainedBytes,
        expiresAt: record.expiresAt,
        chunks: chunks.map(({ frames, events, captions, ...summary }) => ({
          ...summary, eventCount: events.length, captionCount: captions.length, highlights: highlights(frames),
          ...(events.length && { eventTypes: [...new Set(events.map(e => e.type))] })
        })) });
    }
    async function read(opts) {
      const chunkIndex = opts.chunkIndex ?? Math.floor(opts.elapsedSec ?? 0);
      const chunk = chunks[chunkIndex];
      if (!chunk || (opts.elapsedSec != null && opts.elapsedSec >= a.durationSec)) return error("Chunk outside observation");
      const offset = opts.offset ?? 0, limit = opts.limit ?? 20;
      if (offset > chunk.frames.length) return error("Frame offset outside chunk");
      const frames = [];
      let imageCount = 0, bytes = 0;
      for (const stored of chunk.frames.slice(offset, offset + limit)) {
        const { blob, ...row } = stored;
        if (blob) {
          const size = 4 * Math.ceil(blob.size / 3) + 32;
          if (imageCount >= 8 || (frames.length && bytes + size > 512 * 1024)) break;
          row.dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          if (!alive) return error("Playback evidence expired");
          imageCount++;
          bytes += size;
        }
        frames.push(row);
      }
      const end = offset + frames.length;
      return { ok: true, verificationId: id, chunkIndex, startSec: chunk.startSec, endSec: chunk.endSec,
        offset, nextOffset: end < chunk.frames.length ? end : null, frames,
        events: chunk.events, captions: chunk.captions };
    }

    records.set(id, { read, release, ready: false });
    const result = new Promise(resolve => { resolveObservation = resolve; });
    for (const name of trackedEvents) listen(el, name, () => {
      if (name === "seeking") boundary(name);
      else addEvent(name);
      if (name === "encrypted") protectedContent = true;
      if (name === "waiting" || name === "stalled") waited = true;
      checkProgress();
    });
    for (const track of Array.from(el.textTracks || [])) listen(track, "cuechange", readCaptions);
    listen(document, "visibilitychange", checkProgress);
    listen(globalThis, "pagehide", release);
    checkProgress();
    if (rvfc) {
      if (typeof VideoFrame === "function" && el.readyState >= 2) {
        firstSurfacePts = probeSurface() ?? null;
        if (firstSurfacePts != null) setProbeInterval(5);
      }
      callback = el.requestVideoFrameCallback(frame);
    }
    poll = setInterval(checkProgress, 200);
    deadline = setTimeout(stop, durationMs);
    return result;
  }

  function remove(entry) {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    clearTimeout(entry.timer);
    entry.cancel?.();
    if (entry.expiresAt) saveRoutes().catch(() => {});
    // A frozen renderer may defer execution until the tab resumes. Its
    // own TTL guards every read; session cleanup must still return promptly.
    inject(entry, "release", {}).catch(() => {});
  }
  async function clearMatching(predicate) {
    await restoreRoutes();
    const pending = [...entries.values()].filter(predicate).map(remove);
    await Promise.all([...pending, writing]);
  }
  async function verify({ tab, args, found, callCtx, executeInTab, onCallCancel, bindTarget }) {
    const durationSec = args.durationSec ?? 5, mode = args.mode ?? "smart";
    if (!Number.isFinite(durationSec) || durationSec < 1 || durationSec > 30 ||
        !["smart", "detailed"].includes(mode)) return { ok: false, error: "Use smart/detailed mode and 1–30 seconds" };
    if (callCtx?.signal?.aborted) return { ok: false, error: "Playback observation cancelled" };
    executePage = executeInTab;
    await restoreRoutes();
    if (callCtx?.signal?.aborted) return { ok: false, error: "Playback observation cancelled" };
    const id = crypto.randomUUID();
    const entry = { id, owner: owner(callCtx), tabId: tab.id, frameId: args.frameId || 0, documentId: args.documentId };
    entries.set(id, entry);
    const interrupted = new Promise(resolve => { entry.cancel = () => resolve({ ok: false, error: "Playback observation cancelled or document changed" }); });
    const detach = onCallCancel?.(callCtx, () => remove(entry));
    // Suspended renderers can delay every page timer. Bound worker lifetime too.
    entry.timer = setTimeout(() => remove(entry), durationSec * 1000 + 5000);
    try {
      const eventName = "autodom-playback-" + crypto.randomUUID();
      const observe = async () => {
        const armed = await inject(entry, "arm", { eventName });
        if (!armed?.ok || entries.get(id) !== entry) return armed;
        const bound = await bindTarget(eventName);
        if (!bound?.ok || entries.get(id) !== entry) return bound;
        return inject(entry, "observe", { tag: found.tag, durationSec, mode });
      };
      const result = await Promise.race([observe(), interrupted]);
      if (!result?.ok || entries.get(id) !== entry) {
        remove(entry);
        return result?.ok ? { ok: false, error: "Playback observation cancelled" } : result || { ok: false, error: "Media document unavailable" };
      }
      clearTimeout(entry.timer);
      entry.cancel = null;
      entry.expiresAt = result.expiresAt;
      entry.timer = setTimeout(() => remove(entry), Math.max(0, result.expiresAt - Date.now()));
      await saveRoutes();
      return entries.get(id) === entry ? result : { ok: false, error: "Playback observation cancelled" };
    } catch (err) {
      remove(entry);
      return { ok: false, error: String(err.message || err) };
    } finally { detach?.(); }
  }
  async function read(params, ctx) {
    await restoreRoutes();
    const entry = entries.get(params?.verificationId);
    if (!entry || entry.owner !== owner(ctx) || !entry.expiresAt || entry.expiresAt <= Date.now()) {
      return { ok: false, error: "Playback evidence unavailable for this session" };
    }
    if ((params.chunkIndex != null && (!Number.isInteger(params.chunkIndex) || params.chunkIndex < 0)) ||
        (params.elapsedSec != null && (!Number.isFinite(params.elapsedSec) || params.elapsedSec < 0)) ||
        (params.chunkIndex != null && params.elapsedSec != null) ||
        (params.offset != null && (!Number.isInteger(params.offset) || params.offset < 0)) ||
        (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))) {
      return { ok: false, error: "Invalid chunk index, elapsed time or page bounds" };
    }
    try {
      const page = await inject(entry, "read", params);
      if (entries.get(entry.id) !== entry) return { ok: false, error: "Playback evidence expired" };
      return page || { ok: false, error: "Media document unavailable" };
    } catch (_) { remove(entry); return { ok: false, error: "Media document unavailable" }; }
  }
  globalThis.AutoDOMPlayback = { verify, read, configure: fn => { executePage = fn; },
    clearSession: ctx => clearMatching(entry => entry.owner === owner(ctx)),
    clearTab: (tabId, frameId, newDocumentId) => clearMatching(entry => entry.tabId === tabId &&
      (!frameId || entry.frameId === frameId) && (!newDocumentId || entry.documentId !== newDocumentId)),
    clearAll: () => clearMatching(() => true), playbackPage };
})();
