import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";

async function workflow(name) {
  return readFile(join(root, ".github/workflows", name), "utf8");
}

test("GitHub Actions use reviewed immutable revisions", async () => {
  const workflows = await Promise.all([
    workflow("build.yml"),
    workflow("prepare-release.yml"),
    workflow("release.yml"),
  ]);

  for (const source of workflows) {
    assert.match(source, new RegExp(`actions/checkout@${CHECKOUT_SHA}`));
    assert.match(source, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`));
    assert.doesNotMatch(source, /actions\/(?:checkout|setup-node)@v\d/);
  }
});

test("release workflow pins the CRX packer version", async () => {
  const source = await workflow("release.yml");
  assert.match(source, /npx --yes crx3@2\.0\.0/);
  assert.doesNotMatch(source, /npx --yes crx3@\d+\s/);
});

test("share bundle includes verified unpacked updater implementation", async () => {
  const source = await readFile(join(root, "scripts/pack-release.sh"), "utf8");
  assert.match(source, /cp scripts\/update-unpacked\.mjs "\$STAGE\/scripts\/"/);
});

test("share bundle ships the scripts its installers invoke", async () => {
  // setup.sh and setup.ps1 shell out to all of these. If the bundle omits
  // one, setup fails only for share-bundle users — never in-repo.
  const [pack, sh, ps1] = await Promise.all([
    readFile(join(root, "scripts/pack-release.sh"), "utf8"),
    readFile(join(root, "setup.sh"), "utf8"),
    readFile(join(root, "setup.ps1"), "utf8"),
  ]);
  for (const script of [
    "jetbrains-mcp-upsert.mjs",
    "mcp-selftest.mjs",
    "native-host-install.mjs",
  ]) {
    const referenced = sh.includes(script) || ps1.includes(script);
    assert.ok(referenced, `no installer references ${script}`);
    assert.match(
      pack,
      new RegExp(`cp scripts/${script.replace(".", "\\.")} "\\$STAGE/scripts/"`),
      `pack-release.sh does not stage ${script}`,
    );
  }
});


test("release inputs and signing secrets stay outside executable shell source", async () => {
  const source = await workflow("release.yml");
  // env accepts data; run must reference shell variables after validation.
  const runs = [...source.matchAll(/        run: \|\n([\s\S]*?)(?=\n      (?:- |#)|$)/g)].map((m) => m[1]);
  for (const run of runs) {
    assert.doesNotMatch(run, /\$\{\{\s*(?:inputs\.|secrets\.)/);
  }
  assert.match(source, /INPUT_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(source, /trap 'shred -u "\$KEY_FILE"' EXIT/);
  assert.match(await workflow("prepare-release.yml"), /npm audit --audit-level=high/);
});

test("version bump rejects code-like versions before touching manifests", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "autodom-bump-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, "scripts"));
  await mkdir(join(temp, "extension"));
  await copyFile(join(root, "scripts/bump-version.sh"), join(temp, "scripts/bump-version.sh"));
  const manifest = '{"version":"6.2.1"}\n';
  await writeFile(join(temp, "extension/manifest.json"), manifest);
  const run = promisify(execFile);
  for (const bad of ["6.2.2'; throw new Error('injected');//", "6.2.2$(touch injected)", "6.2.2-extra", "06.2.2"]) {
    await assert.rejects(run("bash", [join(temp, "scripts/bump-version.sh"), bad]), (e) => {
      assert.equal(e.code, 2);
      assert.match(e.stderr, /not a plain semver version/);
      return true;
    });
    assert.equal(await readFile(join(temp, "extension/manifest.json"), "utf8"), manifest);
  }
  const good = await run("bash", [join(temp, "scripts/bump-version.sh"), "patch", "--dry-run"]);
  assert.match(good.stdout, /6.2.1 -> 6.2.2/);
});
