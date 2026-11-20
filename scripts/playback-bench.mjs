// Run against an unpacked extension in a fresh Chrome for Testing profile.
// CHROME_BIN selects Chrome for Testing. PLAYWRIGHT_PATH selects an existing
// Playwright install if it is outside the project's Node resolution path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const extension = fileURLToPath(new URL("../extension", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "autodom-playback-"));
let browser;
let site;
try {
  const clips = new Map();
  for (const fps of [30, 60]) {
    const path = join(work, fps + ".mp4");
    // A white full-frame flash at exactly 2s makes alignment independently checkable.
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
      `testsrc2=size=640x360:rate=${fps}:duration=7`, "-vf",
      `drawbox=color=white:t=fill:enable='eq(n,${2 * fps})'`,
      "-c:v", "libx264", "-preset", "ultrafast", "-movflags", "+faststart", path]);
    clips.set("/" + fps + ".mp4", await readFile(path));
  }
  site = createServer((req, res) => {
    const clip = clips.get(req.url);
    if (!clip) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end('<!doctype html><title>Playback benchmark</title><video muted preload="auto"></video>');
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = Number(range?.[1] || 0);
    const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
    res.writeHead(range ? 206 : 200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1, ...(range && { "Content-Range": `bytes ${start}-${end}/${clip.length}` }) });
    res.end(clip.subarray(start, end + 1));
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launchPersistentContext(join(work, "profile"), {
    executablePath: process.env.CHROME_BIN, headless: true, channel: "chromium",
    args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension, "--autoplay-policy=no-user-gesture-required"],
  });
  const isAutoDOM = worker => worker.url().endsWith("/background/service-worker.js");
  const worker = browser.serviceWorkers().find(isAutoDOM) ||
    await browser.waitForEvent("serviceworker", { predicate: isAutoDOM, timeout: 15000 });
  const page = browser.pages()[0] || await browser.newPage();
  const url = "http://127.0.0.1:" + site.address().port + "/";
  await page.goto(url);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, url);
  const call = (tool, params) => worker.evaluate(async ({ tool, params, tabId }) => {
    return TOOL_HANDLERS.get(tool)(params, _makeCallContext({ tabId, clientId: "playback-bench" }));
  }, { tool, params, tabId });
  const quality = () => page.locator("video").evaluate(v => {
    const { droppedVideoFrames: dropped, totalVideoFrames: total } = v.getVideoPlaybackQuality();
    return { dropped, total, time: v.currentTime, rate: v.playbackRate, paused: v.paused };
  });
  console.log("Browser:", await page.evaluate(() => navigator.userAgent));
  for (const fps of [30, 60]) {
    let baseline;
    for (const mode of ["disabled", "sample", "smart", "detailed"]) {
      await page.locator("video").evaluate(async (v, fps) => {
        v.src = "/" + fps + ".mp4";
        await v.play();
        await new Promise(resolve => v.requestVideoFrameCallback(resolve));
      }, fps);
      const before = await quality();
      const start = performance.now();
      let result;
      if (mode === "disabled") await new Promise(resolve => setTimeout(resolve, 5000));
      else if (mode === "sample") result = await call("media_sample_frames", { fromSec: 0, toSec: 5 });
      else result = await call("media_verify_playback", { mode, durationSec: 5 });
      const wallMs = Math.round(performance.now() - start);
      const after = await quality();
      const drops = after.dropped - before.dropped;
      const total = after.total - before.total;
      const dropPercent = total ? (100 * drops) / total : 0;
      if (mode === "disabled") baseline = dropPercent;
      if (result) assert.ok(result.ok, JSON.stringify(result).slice(0, 400));
      const resultBytes = result ? Buffer.byteLength(JSON.stringify(result)) : 0;
      const row = { fps, mode, wallMs, total, drops, dropPercent, resultBytes,
        clockAdvanceSec: +(after.time - before.time).toFixed(3),
        toolCalls: result ? 1 : 0, callbackMs: result?.callbackMs ?? null,
        frameProcessingMs: result?.frameProcessingMs ?? null, peakRetainedBytes: result?.peakRetainedBytes ?? null };
      if (result?.verificationId) {
        row.observed = result.counters.observed;
        row.missedCallbacks = result.counters.missedCallbacks;
        row.skippedEncodes = result.counters.skippedEncodes;
        row.observedHealth = result.health;
        row.recoveredFrames = result.counters.recoveredFrames;
        row.signatures = result.counters.signatures;
        row.surfaceProbe = result.surfaceProbe;
        assert.ok(row.observed > 0);
        assert.equal(result.chunks.length, 5);
        // Use media timestamps to find the flash, regardless of when collection started.
        const chunk = result.chunks.find(c => c.mediaStart <= 2 && c.mediaEnd >= 2);
        const target = { verificationId: result.verificationId, chunkIndex: chunk?.chunkIndex ?? 1 };
        const highlight = chunk?.highlights?.find(h => Math.abs(h.mediaTime - 2) < 0.001);
        let offset = highlight?.offset ?? 0;
        let found = false;
        do {
          const evidence = await call("media_read_chunk", { ...target, offset, limit: highlight ? 1 : 100 });
          assert.ok(evidence.ok, evidence.error);
          row.toolCalls++;
          const marker = evidence.frames.find(f => Math.abs(f.mediaTime - 2) < 0.001);
          if (marker) {
            assert.ok(marker.dataUrl, "observed marker must have a retained thumbnail");
            const white = await page.evaluate(async data => {
              const img = new Image();
              img.src = data;
              await img.decode();
              const ctx = document.createElement("canvas").getContext("2d");
              ctx.drawImage(img, 0, 0, 1, 1);
              return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).every(n => n > 230);
            }, marker.dataUrl);
            assert.ok(white, "thumbnail pixels must match timestamp of marker");
            found = true;
          }
          offset = evidence.nextOffset;
        } while (!found && offset != null);
        row.markerVerified = found;
        row.gates = { callback: result.callbackMs.p95 < 2,
          manifest: resultBytes < 32768, drops: dropPercent - baseline <= 1 };
        // Audit the fixture's independently known frame grid after the timed run.
        // The public chunk API must supply actual pixels for each timestamp.
        const indices = new Set();
        let invalid = 0;
        for (const c of result.chunks) {
          let offset = 0;
          do {
            const page = await call("media_read_chunk", { verificationId: result.verificationId, chunkIndex: c.chunkIndex, offset, limit: 100 });
            assert.ok(page.ok, page.error);
            for (const f of page.frames) {
              const index = Math.round(f.pixelMediaTime * fps);
              if (!f.signature || f.pixelAlignment !== "verified-pts" || indices.has(index) ||
                  Math.abs(f.pixelMediaTime - index / fps) > .0001 ||
                  Math.abs(f.mediaTime - index / fps) > .00051 || (mode === "detailed" && !f.dataUrl)) {
                invalid++;
                continue;
              }
              indices.add(index);
            }
            offset = page.nextOffset;
          } while (offset != null);
        }
        row.verifiedFrames = indices.size;
        assert.ok(result.pixelWindow, "live pixel timestamps required at both observation boundaries");
        const first = Math.round(result.pixelWindow.startMediaTime * fps);
        const last = Math.round(result.pixelWindow.endMediaTime * fps);
        const span = last - first + 1;
        row.expectedFrames = span;
        row.gates = { ...row.gates, marker: found, everyFrame: invalid === 0 && indices.size === span &&
          Math.min(...indices) === first && Math.max(...indices) === last &&
          span >= 5 * fps - 1 && span <= 5 * fps + 2 && result.counters.unrecoveredCallbacks === 0,
          playbackPace: after.rate === 1 && !after.paused && Math.abs(row.clockAdvanceSec - wallMs / 1000) < .08 };
      }
      console.log(JSON.stringify(row));
      if (row.gates && Object.values(row.gates).includes(false)) process.exitCode = 1;
      if (row.markerVerified === false && !row.missedCallbacks && !drops) {
        throw new Error("Marker missing without reported presentation gaps");
      }
    }
  }
} finally {
  await browser?.close();
  if (site?.listening) await new Promise(resolve => site.close(resolve));
  await rm(work, { recursive: true, force: true });
}
