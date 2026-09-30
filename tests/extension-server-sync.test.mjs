import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(resolve(here, "../extension/background/service-worker.js"), "utf8");
const fn = (name) => {
  const start = sw.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const next = sw.indexOf("\nfunction ", start + 10);
  const nextAsync = sw.indexOf("\nasync function ", start + 10);
  const end = Math.min(...[next, nextAsync].filter((n) => n > 0));
  return sw.slice(start, end);
};

test("the port probe no longer opens a WebSocket (refused ones land in the Errors page)", () => {
  const probe = fn("_probeWsPort");
  assert.doesNotMatch(probe, /new WebSocket/);
  assert.match(probe, /fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/`/);
  assert.match(sw, /PORT_PROBE_MIN_FAILURES = 3/);
  assert.match(sw, /PORT_PROBE_THROTTLE_MS = 5 \* 60 \* 1000/);
  // The background probe waits for repeated failures and the counter resets on connect.
  assert.match(fn("probeBridgePortMismatch"), /_connectFailureStreak < PORT_PROBE_MIN_FAILURES/);
  assert.match(sw, /ws\.onopen = \(\) => \{\s+isConnected = true;\s+_connectFailureStreak = 0;/);
});

test("server sync follows the extension, and never touches unpacked installs without the switch", () => {
  const sync = fn("_maybeSyncServerToExtension");
  // Only when the server is behind the extension.
  assert.match(sync, /_compareExtensionVersions\(serverVersion, extVersion\) >= 0\) return false/);
  // Development installs honour "Auto-apply updates"; managed installs do not need it.
  assert.match(sync, /isDevelopment && stored\[UPDATE_STORAGE_KEYS\.autoUpdateEnabled\] !== true/);
  // Managed installs get a server-only update; the extension is left to the browser.
  assert.match(sync, /scope: isDevelopment \? "all" : "server"/);
  // A cooldown and an in-flight guard prevent retry storms.
  assert.match(sync, /SERVER_SYNC_COOLDOWN_MS/);
  assert.match(sync, /state === "downloading"/);
  // When only the running process is stale, the bridge restarts itself.
  assert.match(sync, /info\?\.staleOnDisk\) return false/);
  // Triggered when the extension identifies itself to a bridge.
  assert.match(sw, /_maybeSyncServerToExtension\(String\(message\.version\)\)/);
});

test("the extension is reloaded only when its own files were replaced", () => {
  const handler = sw.slice(sw.indexOf("async function _onWsConn_SELF_UPDATE_RESULT"));
  const body = handler.slice(0, handler.indexOf("\nasync function ", 10));
  assert.match(body, /message\.extensionUpdated !== false && message\.alreadyCurrent !== true/);
  assert.ok(
    body.indexOf("chrome.runtime.reload()") > body.indexOf("extensionUpdated !== false"),
    "reload sits behind the guard",
  );
});

test("Fix updates the server and restarts stale bridges, and says so for bridges too old to do it", () => {
  const fix = sw.slice(sw.indexOf("async function _runBridgeFix"));
  const body = fix.slice(0, fix.indexOf("\n}\n") + 3);
  assert.match(body, /_requestRestartStale\(\)/);
  assert.match(body, /info\.autoRestart === undefined/);
  assert.match(body, /predates self-updating/);
  assert.match(sw, /RESTART_STALE_RESULT: _onWsConn_RESTART_STALE_RESULT/);
});

test("Bridge check explains version drift instead of pointing at setup.sh", () => {
  assert.doesNotMatch(sw, /Update the server \(setup\.sh\) or the extension/);
  assert.match(sw, /Server files are v\$\{info\.diskVersion\}, but this bridge process still runs/);
  assert.match(sw, /is older than extension v\$\{extVersion\}\. AutoDOM updates the server by itself/);
});
