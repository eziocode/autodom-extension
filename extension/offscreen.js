/**
 * AutoDOM offscreen document.
 *
 * Two responsibilities:
 *   1. Keepalive heartbeat (optional, gated by user setting in the SW) so
 *      long MCP sessions keep the service worker warm.
 *   2. Tab recorder host — owns the MediaStream returned by tabCapture and
 *      drives a MediaRecorder. The service worker relays messages tagged
 *      with `__autodom_recorder: true` to this document.
 *
 * Recorder protocol (request → response):
 *   { type: "AUTODOM_REC_START", streamId, mimeType, videoBitsPerSecond, maxDurationSec, maxBytes }
 *     → { ok, mimeType }
 *   { type: "AUTODOM_REC_STOP" }
 *     → { ok, mimeType, sizeBytes, durationMs, objectUrl }
 *   { type: "AUTODOM_REC_STATUS" }
 *     → { ok, recording, sizeBytes, durationMs, mimeType, heldBytes }
 *   { type: "AUTODOM_REC_RELEASE" }
 *     → { ok, freedBytes }   (revokes the objectUrl, drops the blob)
 *
 * The objectUrl is created via URL.createObjectURL(blob) inside this
 * document. The chat panel saves it through the SW's
 * DOWNLOAD_LAST_RECORDING handler (chrome.downloads), which releases the
 * recording here once the download completes.
 */

(function () {
  // ── Keepalive (existing behaviour) ────────────────────────
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
    } catch (_) {}
  }, 20_000);

  // ── Recorder state ────────────────────────────────────────
  // A finished recording is held only until it is downloaded (the SW sends
  // AUTODOM_REC_RELEASE), finish_session, the next start, or
  // RELEASE_AFTER_MS — about 19 MB per minute at the default bitrate.
  const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
  const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000;
  const RELEASE_AFTER_MS = 10 * 60 * 1000;
  let recorder = null;
  let chunks = [];
  let chunkBytes = 0;
  let mimeType = "video/webm";
  let stream = null;
  let startedAt = 0;
  let stopped = null; // Promise of the stop result for the current recording
  let stopReason = null;
  let recorderError = null;
  let capTimer = null;
  let releaseTimer = null;
  let lastBlob = null;
  let lastObjectUrl = null;

  function _stopStream() {
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    stream = null;
    clearTimeout(capTimer);
    capTimer = null;
  }

  function _reset() {
    try { recorder && recorder.state !== "inactive" && recorder.stop(); } catch (_) {}
    _stopStream();
    recorder = null;
    chunks = [];
    chunkBytes = 0;
    startedAt = 0;
  }

  function release() {
    clearTimeout(releaseTimer);
    releaseTimer = null;
    const freedBytes = lastBlob ? lastBlob.size : 0;
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = null;
    lastBlob = null;
    return { ok: true, freedBytes };
  }

  function autoStop(reason) {
    if (!recorder || recorder.state === "inactive") return;
    stopReason = reason;
    try { recorder.stop(); } catch (_) {}
  }

  function finalize() {
    const durationMs = Date.now() - startedAt;
    try {
      lastBlob = new Blob(chunks, { type: mimeType });
      lastObjectUrl = URL.createObjectURL(lastBlob);
      return {
        ok: true,
        mimeType,
        sizeBytes: lastBlob.size,
        durationMs,
        objectUrl: lastObjectUrl,
        ...(stopReason && { stopReason }),
        ...(recorderError && { recorderError }),
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    } finally {
      chunks = [];
      chunkBytes = 0;
      _stopStream();
      recorder = null;
      releaseTimer = setTimeout(release, RELEASE_AFTER_MS);
    }
  }

  async function startRecording({ streamId, mimeType: mt, videoBitsPerSecond, maxDurationSec, maxBytes }) {
    if (recorder && recorder.state === "recording") {
      return { ok: false, error: "recorder already running" };
    }
    if (!streamId) return { ok: false, error: "missing streamId" };
    release();
    try {
      // Chrome's tabCapture stream id is consumed by getUserMedia with a
      // mandatory chromeMediaSource constraint. Video is required.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
        },
        video: {
          mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
        },
      });
    } catch (err) {
      return { ok: false, error: "getUserMedia failed: " + (err && err.message) };
    }
    try {
      mimeType = (mt && MediaRecorder.isTypeSupported(mt)) ? mt
        : (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm");
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: videoBitsPerSecond || 2_500_000,
      });
      chunks = [];
      chunkBytes = 0;
      stopReason = null;
      recorderError = null;
      const byteCap = maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
      recorder.ondataavailable = (ev) => {
        if (!ev.data || !ev.data.size) return;
        chunks.push(ev.data);
        chunkBytes += ev.data.size;
        if (chunkBytes >= byteCap) autoStop("size cap");
      };
      recorder.onerror = (ev) => {
        recorderError = String((ev && ev.error && ev.error.message) || "recorder error");
        autoStop("error");
      };
      stopped = new Promise((resolve) => { recorder.onstop = () => resolve(finalize()); });
      recorder.start(1000); // 1s chunk cadence
      startedAt = Date.now();
      capTimer = setTimeout(
        () => autoStop("duration cap"),
        maxDurationSec > 0 ? maxDurationSec * 1000 : DEFAULT_MAX_DURATION_MS,
      );
      return { ok: true, mimeType };
    } catch (err) {
      _reset();
      return { ok: false, error: "MediaRecorder failed: " + (err && err.message) };
    }
  }

  async function stopRecording() {
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch (err) {
        return { ok: false, error: String(err && err.message) };
      }
      return await stopped;
    }
    // Stopped by a cap before the caller asked: hand back that result.
    if (stopped && lastBlob) return await stopped;
    return { ok: false, error: "no active recording" };
  }

  function getStatus() {
    const recording = !!recorder && recorder.state === "recording";
    return {
      ok: true,
      recording,
      sizeBytes: recording ? chunkBytes : 0,
      durationMs: recording ? (Date.now() - startedAt) : 0,
      mimeType: recording ? mimeType : null,
      heldBytes: lastBlob ? lastBlob.size : 0,
      lastObjectUrl: lastObjectUrl || null,
      ...(stopReason && { stopReason }),
    };
  }

  // Route only recorder-tagged messages.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__autodom_recorder) return false;
    const handle = async () => {
      try {
        switch (msg.type) {
          case "AUTODOM_REC_START":
            return await startRecording(msg);
          case "AUTODOM_REC_STOP":
            return await stopRecording();
          case "AUTODOM_REC_STATUS":
            return getStatus();
          case "AUTODOM_REC_RELEASE":
            return release();
          default:
            return { ok: false, error: "unknown recorder message: " + msg.type };
        }
      } catch (err) {
        return { ok: false, error: String(err && err.message) };
      }
    };
    handle().then(sendResponse);
    return true; // async response
  });
})();
