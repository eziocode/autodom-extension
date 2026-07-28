import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

test("policy templates use the canonical managed update settings", async () => {
  const templates = await Promise.all([
    read("enterprise/linux/autodom-policy.json.tmpl"),
    read("enterprise/macos/com.google.Chrome.plist.tmpl"),
    read("enterprise/macos/com.microsoft.Edge.plist.tmpl"),
    read("enterprise/macos/com.brave.Browser.plist.tmpl"),
    read("enterprise/windows/autodom-policy.reg.tmpl"),
  ]);

  for (const template of templates) {
    assert.match(template, /__AUTODOM_EXTENSION_ID__/);
    assert.match(template, /force_installed/);
    assert.match(
      template,
      /https:\/\/eziocode\.github\.io\/autodom-extension\/updates\.xml/,
    );
  }
});

test("enterprise installers verify policy values after writing", async () => {
  const [shellInstaller, powershellInstaller] = await Promise.all([
    read("enterprise/install.sh"),
    read("enterprise/install.ps1"),
  ]);

  assert.match(shellInstaller, /verify_policy_file "\$2"/);
  assert.match(shellInstaller, /grep -Fq "\$UPDATE_URL"/);
  assert.match(powershellInstaller, /Get-ItemProperty -Path \$sub/);
  assert.match(powershellInstaller, /Policy verification failed/);
  assert.match(shellInstaller, /remove_if_present "\$out"/);
  assert.match(powershellInstaller, /Remove-Item -Path \$sub -Recurse -Force/);
  for (const target of [
    "com.google.Chrome",
    "com.microsoft.Edge",
    "com.brave.Browser",
    "/etc/opt/chrome/policies/managed/autodom.json",
    "/etc/chromium/policies/managed/autodom.json",
    "/etc/opt/edge/policies/managed/autodom.json",
    "/etc/brave/policies/managed/autodom.json",
  ]) {
    assert.match(shellInstaller, new RegExp(target.replaceAll(".", "\\.")));
  }
  for (const registryRoot of [
    "Policies\\\\Google\\\\Chrome\\\\ExtensionSettings",
    "Policies\\\\Microsoft\\\\Edge\\\\ExtensionSettings",
    "Policies\\\\BraveSoftware\\\\Brave\\\\ExtensionSettings",
  ]) {
    assert.match(powershellInstaller, new RegExp(registryRoot));
  }
});

test("Windows setup propagates elevated installer failures", async () => {
  const setup = await read("setup.ps1");

  assert.match(setup, /\$LASTEXITCODE -ne 0/);
  assert.match(setup, /-PassThru/);
  assert.match(setup, /\$policyProcess\.ExitCode -ne 0/);
});

test("installer messaging does not promise unverified browser support", async () => {
  const files = await Promise.all([
    read("enterprise/install.sh"),
    read("enterprise/install.ps1"),
    read("setup.sh"),
    read("setup.ps1"),
  ]);

  for (const source of files) {
    assert.match(source, /Arc.*Ulaa|Arc\/Ulaa/s);
    assert.match(source, /best-effort.*Brave|Brave.*best-effort/s);
  }
});

test("installation docs separate managed and unpacked update paths", async () => {
  const [readme, install, updates, enterpriseReadme] = await Promise.all([
    read("README.md"),
    read("INSTALL.md"),
    read("UPDATES.md"),
    read("enterprise/README.md"),
  ]);

  assert.doesNotMatch(install, /Updates from the self-hosted channel work either way/);
  assert.match(install, /share bundles use AutoDOM's bridge updater/);
  assert.match(updates, /Arc \/ Ulaa \/ other Chromium browsers/);
  assert.match(updates, /restart cannot apply a CRX that the browser never downloaded/i);
  assert.match(
    readme,
    /Arc, Ulaa, and\s+other browsers use the unpacked\/manual path/,
  );
  assert.match(enterpriseReadme, /Managed self-hosted updates are evidence-backed/);
});
