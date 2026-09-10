import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  // setup.sh and setup.ps1 shell out to both of these. If the bundle omits
  // one, setup fails only for share-bundle users — never in-repo.
  const [pack, sh, ps1] = await Promise.all([
    readFile(join(root, "scripts/pack-release.sh"), "utf8"),
    readFile(join(root, "setup.sh"), "utf8"),
    readFile(join(root, "setup.ps1"), "utf8"),
  ]);
  for (const script of ["jetbrains-mcp-upsert.mjs", "mcp-selftest.mjs"]) {
    const referenced = sh.includes(script) || ps1.includes(script);
    assert.ok(referenced, `no installer references ${script}`);
    assert.match(
      pack,
      new RegExp(`cp scripts/${script.replace(".", "\\.")} "\\$STAGE/scripts/"`),
      `pack-release.sh does not stage ${script}`,
    );
  }
});
