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
 *   { type: "AUTODOM_REC_START", streamId, mimeType, videoBitsPerSecond }
 *     → { ok, mimeType }
 *   { type: "AUTODOM_REC_STOP" }
 *     → { ok, mimeType, sizeBytes, durationMs, objectUrl }
 *   { type: "AUTODOM_REC_STATUS" }
 *     → { ok, recording, sizeBytes, durationMs, mimeType }
 *
 * The objectUrl is created via URL.createObjectURL(blob) inside this
 * document. It is only usable from the same document — for the chat panel
 * to save the file, the panel should invoke chrome.downloads via the SW,
 * passing { type: "DOWNLOAD_LAST_RECORDING" } which we handle below.
 */

(function () {
  // ── Keepalive (existing behaviour) ────────────────────────
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
    } catch (_) {}
  }, 20_000);

  // ── Recorder state ────────────────────────────────────────
  let recorder = null;
  let chunks = [];
  let mimeType = "video/webm";
  let stream = null;
  let startedAt = 0;
  let lastBlob = null;
  let lastObjectUrl = null;

  function _reset() {
    try { recorder && recorder.state !== "inactive" && recorder.stop(); } catch (_) {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    recorder = null;
    stream = null;
    chunks = [];
    startedAt = 0;
  }

  async function startRecording({ streamId, mimeType: mt, videoBitsPerSecond }) {
    if (recorder && recorder.state === "recording") {
      return { ok: false, error: "recorder already running" };
    }
    if (!streamId) return { ok: false, error: "missing streamId" };
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
      lastBlob = null;
      if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      recorder.start(1000); // 1s chunk cadence
      startedAt = Date.now();
      return { ok: true, mimeType };
    } catch (err) {
      _reset();
      return { ok: false, error: "MediaRecorder failed: " + (err && err.message) };
    }
  }

  function stopRecording() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        return resolve({ ok: false, error: "no active recording" });
      }
      const duration = Date.now() - startedAt;
      recorder.onstop = () => {
        try {
          lastBlob = new Blob(chunks, { type: mimeType });
          if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
          lastObjectUrl = URL.createObjectURL(lastBlob);
          const sizeBytes = lastBlob.size;
          try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
          stream = null;
          recorder = null;
          resolve({
            ok: true,
            mimeType,
            sizeBytes,
            durationMs: duration,
            objectUrl: lastObjectUrl,
          });
        } catch (err) {
          resolve({ ok: false, error: String(err && err.message) });
        }
      };
      try { recorder.stop(); } catch (err) {
        resolve({ ok: false, error: String(err && err.message) });
      }
    });
  }

  function getStatus() {
    const sizeBytes = chunks.reduce((s, c) => s + (c.size || 0), 0);
    const recording = !!recorder && recorder.state === "recording";
    return {
      ok: true,
      recording,
      sizeBytes,
      durationMs: recording ? (Date.now() - startedAt) : 0,
      mimeType: recording ? mimeType : null,
      lastObjectUrl: lastObjectUrl || null,
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
