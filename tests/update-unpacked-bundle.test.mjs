import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANON = "https://github.com/eziocode/autodom-extension/releases/download";
const EXT_ID = "kpjdffgogiajnkajnjneiboaincnaokf";

function writeExtension(dir, version) {
  for (const f of ["background/service-worker.js", "popup/popup.js", "common/webext-api.js"]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), `// ${version}`);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version }));
}
function writeServer(dir, version, lock) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["index.js", "self-restart.js"]) writeFileSync(join(dir, f), `// ${version}`);
  // The real module: the updater re-imports it from server/ on the next run.
  copyFileSync(join(repo, "server/update-utils.js"), join(dir, "update-utils.js"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version, type: "module" }));
  writeFileSync(join(dir, "package-lock.json"), lock);
}

// `bash update.sh` is the documented one-time migration for a share-bundle
// install, so it has to update server/ as well as extension/.
test("update-unpacked installs server + extension from the share bundle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodom-unpacked-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // installed share folder at 9.4.0 (no .git)
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts/update-unpacked.mjs"), join(root, "scripts/update-unpacked.mjs"));
  mkdirSync(join(root, "server"));
  copyFileSync(join(repo, "server/update-utils.js"), join(root, "server/update-utils.js"));
  writeFileSync(join(root, "server/package.json"), JSON.stringify({ version: "9.4.0", type: "module" }));
  writeFileSync(join(root, "server/package-lock.json"), "same-lock");
  mkdirSync(join(root, "server/node_modules/ws"), { recursive: true });
  writeFileSync(join(root, "server/node_modules/ws/index.js"), "ws");
  writeExtension(join(root, "extension"), "9.4.0");

  // published 9.5.0 bundle
  const build = join(root, "_build");
  const top = join(build, "autodom-9.5.0-share");
  writeServer(join(top, "server"), "9.5.0", "same-lock");
  writeExtension(join(top, "extension"), "9.5.0");
  execFileSync("zip", ["-qr", "bundle.zip", "autodom-9.5.0-share"], { cwd: build });
  const bundle = readFileSync(join(build, "bundle.zip"));
  const sha = createHash("sha256").update(bundle).digest("hex");

  const http = createServer((req, res) => {
    if (req.url === "/updates.json") {
      res.end(JSON.stringify({
        schemaVersion: 1,
        extensionId: EXT_ID,
        version: "9.5.0",
        artifacts: {
          crx: { url: `${CANON}/v9.5.0/autodom-9.5.0.crx`, sha256: "a".repeat(64) },
          zip: { url: `${CANON}/v9.5.0/autodom-chrome-9.5.0.zip`, sha256: "b".repeat(64) },
          share: { url: `${CANON}/v9.5.0/autodom-9.5.0-share.zip`, sha256: sha },
        },
      }));
    } else if (/-share\.zip$/.test(req.url)) {
      res.end(bundle);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => http.close());
  const base = `http://127.0.0.1:${http.address().port}`;

  const { stdout } = await execFileAsync(process.execPath, [join(root, "scripts/update-unpacked.mjs")], {
    env: {
      ...process.env,
      AUTODOM_UPDATE_METADATA_URL: `${base}/updates.json`,
      AUTODOM_UPDATE_DOWNLOAD_BASE: `${base}/`,
    },
  });
  assert.match(stdout, /Updated safely to v9\.5\.0 \(server \+ extension\)/);
  assert.equal(JSON.parse(readFileSync(join(root, "server/package.json"), "utf8")).version, "9.5.0");
  assert.equal(JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8")).version, "9.5.0");
  assert.equal(readFileSync(join(root, "server/node_modules/ws/index.js"), "utf8"), "ws", "dependencies reused, not lost");
  assert.deepEqual(
    readdirSync(root).filter((n) => n.startsWith(".autodom-")),
    [],
    "no staging or backup folders left behind",
  );

  // Running it again is a no-op.
  const again = await execFileAsync(process.execPath, [join(root, "scripts/update-unpacked.mjs")], {
    env: { ...process.env, AUTODOM_UPDATE_METADATA_URL: `${base}/updates.json`, AUTODOM_UPDATE_DOWNLOAD_BASE: `${base}/` },
  });
  assert.match(again.stdout, /Already up to date/);
});
