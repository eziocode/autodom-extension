import { WebSocket } from "ws";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PORT = 19876;
const PACKAGED_CHROME_ORIGIN = "chrome-extension://kpjdffgogiajnkajnjneiboaincnaokf";
const CONFIGURED_MOZ_ORIGIN =
  "moz-extension://11111111-1111-1111-1111-111111111111";
const proc = spawn("node", ["index.js", "--port", String(PORT)], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    AUTODOM_INACTIVITY_TIMEOUT: "0",
    AUTODOM_ALLOWED_EXTENSION_ORIGINS: CONFIGURED_MOZ_ORIGIN,
  },
});
proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
proc.on("exit", (c) => console.log("[srv exited]", c));

await new Promise((r) => setTimeout(r, 1500));

function tryConnect(opts, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${opts.path||""}`, undefined, {
      headers: opts.headers || {},
    });
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve({ label, ...result }); ws.terminate(); } };
    ws.on("open", () => finish({ ok: true }));
    ws.on("unexpected-response", (req, res) => finish({ ok: false, status: res.statusCode }));
    ws.on("error", (e) => finish({ ok: false, err: e.message }));
    setTimeout(() => finish({ ok: false, err: "timeout" }), 1500);
  });
}

const lockPath = join(tmpdir(), `autodom-bridge-${PORT}.json`);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const st = statSync(lockPath);
const mode = (st.mode & 0o777).toString(8);

const results = [];
results.push(await tryConnect({}, "no-origin-no-token"));
results.push(await tryConnect({ headers: { Origin: "https://evil.example" } }, "evil-origin"));
results.push(await tryConnect({ headers: { Origin: PACKAGED_CHROME_ORIGIN } }, "packaged-chrome-origin"));
results.push(await tryConnect({ headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }, "unknown-chrome-origin"));
results.push(await tryConnect({ headers: { Origin: CONFIGURED_MOZ_ORIGIN } }, "configured-moz-origin"));
results.push(await tryConnect({ headers: { Origin: "moz-extension://22222222-2222-2222-2222-222222222222" } }, "unknown-moz-origin"));
results.push(await tryConnect({ path: `/?token=${lock.token}` }, "valid-token"));
results.push(await tryConnect({ path: `/?token=wrongtoken` }, "wrong-token"));

console.log("lockfile mode:", mode, "token len:", lock.token?.length);
for (const r of results) console.log(JSON.stringify(r));

const expected = {
  "no-origin-no-token": false,
  "evil-origin": false,
  "packaged-chrome-origin": true,
  "unknown-chrome-origin": false,
  "configured-moz-origin": true,
  "unknown-moz-origin": false,
  "valid-token": true,
  "wrong-token": false,
};
let pass = mode === "600" && lock.token?.length === 64;
for (const r of results) if (!!r.ok !== expected[r.label]) pass = false;
console.log(pass ? "PASS" : "FAIL");
proc.kill();
process.exit(pass ? 0 : 1);
