import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const popupSrc = readFileSync(
  resolve(here, "../extension/popup/popup.js"),
  "utf8",
);
const serviceWorkerSrc = readFileSync(
  resolve(here, "../extension/background/service-worker.js"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(resolve(here, "../extension/manifest.json"), "utf8"),
);

function makeElement() {
  return {
    textContent: "",
    title: "",
    disabled: false,
    dataset: {},
    style: {},
    addEventListener() {},
    classList: {
      add() {},
      remove() {},
    },
    setAttribute() {},
  };
}

function loadPopup(overrides = {}) {
  const elements = new Map();
  const getElement = (sel) => {
    if (!elements.has(sel)) elements.set(sel, makeElement());
    return elements.get(sel);
  };
  const localGetImpl = overrides.localGet || (async () => ({}));
  const localSetImpl = overrides.localSet || (async () => {});
  const sendMessageImpl = overrides.sendMessage || (async () => ({ ok: true }));
  const installType = overrides.installType || "normal";
  const sandbox = {
    chrome: {
      runtime: {
        getManifest: () => ({ version: manifest.version }),
        sendMessage(message, callback) {
          Promise.resolve(sendMessageImpl(message)).then((response) => {
            if (typeof callback === "function") callback(response);
          });
          return undefined;
        },
        onMessage: { addListener() {} },
      },
      management: {
        getSelf(callback) {
          if (typeof callback === "function") {
            Promise.resolve().then(() => callback({ installType }));
          }
        },
      },
      storage: {
        local: {
          get(keys, callback) {
            const resultPromise = Promise.resolve(localGetImpl(keys));
            if (typeof callback === "function") {
              resultPromise.then((result) => callback(result));
              return undefined;
            }
            return resultPromise;
          },
          set(values, callback) {
            const resultPromise = Promise.resolve(localSetImpl(values));
            if (typeof callback === "function") {
              resultPromise.then(() => callback());
              return undefined;
            }
            return resultPromise;
          },
          remove(keys, callback) {
            const resultPromise = Promise.resolve();
            if (typeof callback === "function") {
              resultPromise.then(() => callback());
              return undefined;
            }
            return resultPromise;
          },
        },
        session: {
          get(keys, callback) {
            return sandbox.chrome.storage.local.get(keys, callback);
          },
          set(values, callback) {
            return sandbox.chrome.storage.local.set(values, callback);
          },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
    document: {
      body: {
        classList: {
          add() {},
          contains() { return false; },
        },
        appendChild() {},
        removeChild() {},
      },
      querySelector(sel) {
        return getElement(sel);
      },
      getElementById(id) {
        return getElement(`#${id}`);
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
    },
    location: { search: "" },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    URLSearchParams,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  getElement("#appVersion");
  getElement("#checkUpdateBtn");
  getElement("#updatePolicyNotice");
  getElement("#updatePolicyNoticeText");
  getElement("#updatePolicyCommand");
  getElement("#copyUpdatePolicyCommandBtn");
  vm.createContext(sandbox);
  vm.runInContext(popupSrc, sandbox);
  return { sandbox, elements };
}

function extractFunctionSource(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  let depth = 0;
  let inString = "";
  let escaped = false;
  let seenBody = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      seenBody = true;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (seenBody && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function loadServiceWorkerUpdateSanitizer(stored) {
  const removed = [];
  const writes = [];
  const sandbox = {
    Date: {
      now: () => 1_000_000,
    },
    UPDATE_STORAGE_KEYS: {
      pending: "pendingUpdate",
      available: "availableUpdate",
      applyRequestedVersion: "autodomApplyRequestedVersion",
      applyRequestedAt: "autodomApplyRequestedAt",
      autoUpdateApplyAttemptAt: "autodomAutoUpdateApplyAttemptAt",
    },
    UPDATE_APPLY_SANITIZE_GRACE_MS: 2 * 60 * 1000,
    chrome: {
      runtime: {
        getManifest: () => ({ version: manifest.version }),
      },
      storage: {
        local: {
          remove(keys, callback) {
            removed.push(...(Array.isArray(keys) ? keys : [keys]));
            if (callback) callback();
          },
        },
      },
    },
    _readUpdateStorage: async () => stored,
    _writeUpdateStorage: async (values) => {
      writes.push(values);
      return true;
    },
  };
  sandbox._compareExtensionVersions = function _compareExtensionVersions(a, b) {
    const left = String(a || "").split(".");
    const right = String(b || "").split(".");
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      const l = Number.parseInt(left[i] || "0", 10) || 0;
      const r = Number.parseInt(right[i] || "0", 10) || 0;
      if (l !== r) return l > r ? 1 : -1;
    }
    return 0;
  };
  sandbox._isVersionNewerThanCurrent = function _isVersionNewerThanCurrent(version) {
    const currentVersion = sandbox.chrome.runtime.getManifest().version;
    if (!version || version === "?") return false;
    return sandbox._compareExtensionVersions(version, currentVersion) > 0;
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunctionSource(serviceWorkerSrc, "_sanitizeStoredUpdateState")}; globalThis._sanitizeStoredUpdateState = _sanitizeStoredUpdateState;`,
    sandbox,
  );
  return { sandbox, removed, writes };
}

function loadServiceWorkerFunction(name, sandbox) {
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunctionSource(serviceWorkerSrc, name)}; globalThis.${name} = ${name};`,
    sandbox,
  );
  return sandbox[name];
}

test("paintUpdateButton ignores stale versions", () => {
  const { sandbox, elements } = loadPopup();
  const btn = elements.get("#checkUpdateBtn");
  const versionEl = elements.get("#appVersion");

  sandbox.paintUpdateButton(null, { version: "0.0.1" });

  assert.equal(btn.textContent, "↻");
  assert.equal(btn.dataset.updateState, undefined);
  assert.equal(versionEl.textContent, `v${manifest.version}`);
});

test("legacy apply_not_effective state does not show blocked update warning", () => {
  const { sandbox, elements } = loadPopup();
  const versionParts = manifest.version.split(".");
  const futureVersion = [
    versionParts[0] || "0",
    versionParts[1] || "0",
    String((Number(versionParts[2]) || 0) + 1),
  ].join(".");
  const versionEl = elements.get("#appVersion");

  sandbox.paintUpdateButton(null, {
    version: futureVersion,
    runtimeStatus: "apply_not_effective",
  });

  assert.equal(
    sandbox.shouldPromptUpdateInstallIntervention({
      version: futureVersion,
      runtimeStatus: "apply_not_effective",
    }),
    false,
  );
  assert.equal(
    sandbox.shouldPromptUpdateInstallIntervention({
      version: futureVersion,
      runtimeStatus: "apply_not_effective",
      manualInterventionRequired: true,
    }),
    true,
  );
  assert.equal(versionEl.textContent, `v${manifest.version} → v${futureVersion}`);
});

test("paintUpdateButton shows persistent policy command for non-pending update", () => {
  const { sandbox, elements } = loadPopup();
  const versionParts = manifest.version.split(".");
  const futureVersion = [
    versionParts[0] || "0",
    versionParts[1] || "0",
    String((Number(versionParts[2]) || 0) + 1),
  ].join(".");
  const notice = elements.get("#updatePolicyNotice");
  const noticeText = elements.get("#updatePolicyNoticeText");
  const command = elements.get("#updatePolicyCommand");

  sandbox.paintUpdateButton(null, { version: futureVersion });

  assert.equal(notice.style.display, "");
  assert.match(noticeText.textContent, /managed-policy installer/);
  assert.equal(
    command.textContent,
    "sudo AUTODOM_EXTENSION_ID=kpjdffgogiajnkajnjneiboaincnaokf ./enterprise/install.sh",
  );
});

test("runUpdateCheck shows policy notice when bridge unavailable for unpacked install", async () => {
  const versionParts = manifest.version.split(".");
  const futureVersion = [
    versionParts[0] || "0",
    versionParts[1] || "0",
    String((Number(versionParts[2]) || 0) + 1),
  ].join(".");
  const calls = [];
  const { sandbox, elements } = loadPopup({
    installType: "development",
    localGet: async () => ({ availableUpdate: { version: futureVersion } }),
    sendMessage: async (message) => {
      calls.push(message);
      // Bridge not connected — self-update fails
      if (message.type === "AUTODOM_SELF_UPDATE") {
        return { ok: false, error: "Bridge not connected" };
      }
      return { ok: true };
    },
  });

  const btn = elements.get("#checkUpdateBtn");
  const notice = elements.get("#updatePolicyNotice");
  const command = elements.get("#updatePolicyCommand");

  btn.dataset.updateState = "found";
  await sandbox.runUpdateCheck();

  assert.ok(
    !calls.some((m) => m.type === "AUTODOM_CHECK_FOR_UPDATE"),
    "should not re-check for unpacked found state",
  );
  assert.ok(calls.some((m) => m.type === "AUTODOM_SELF_UPDATE"), "should try server self-update");
  assert.equal(notice.style.display, "");
  assert.match(command.textContent, /enterprise\/install\.sh/);
});

test("runUpdateCheck reloads via bridge when server-based self-update succeeds", async () => {
  const versionParts = manifest.version.split(".");
  const futureVersion = [
    versionParts[0] || "0",
    versionParts[1] || "0",
    String((Number(versionParts[2]) || 0) + 1),
  ].join(".");
  const calls = [];
  let reloaded = false;
  const { sandbox, elements } = loadPopup({
    installType: "development",
    // When the popup reads selfUpdateStatus after registering the onChanged listener,
    // return the completed state to simulate the bridge finishing before the popup checks.
    localGet: async (keys) => {
      if (keys === "selfUpdateStatus" || (Array.isArray(keys) && keys.includes("selfUpdateStatus"))) {
        return { selfUpdateStatus: { state: "complete", version: futureVersion } };
      }
      return { availableUpdate: { version: futureVersion } };
    },
    sendMessage: async (message) => {
      calls.push(message);
      if (message.type === "AUTODOM_SELF_UPDATE") {
        // New: SW responds immediately; download tracked via storage
        return { ok: true, started: true };
      }
      return { ok: true };
    },
  });
  sandbox.chrome.runtime.reload = () => { reloaded = true; };

  const btn = elements.get("#checkUpdateBtn");
  btn.dataset.updateState = "found";
  await sandbox.runUpdateCheck();

  assert.ok(calls.some((m) => m.type === "AUTODOM_SELF_UPDATE"), "should send AUTODOM_SELF_UPDATE");
  // reload is scheduled via setTimeout(800ms) inside applyStatus
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(reloaded, true, "should reload after successful server-based update");
});


test("sanitize update state keeps pending update after reload race", async () => {
  const versionParts = manifest.version.split(".");
  const futureVersion = [
    versionParts[0] || "0",
    versionParts[1] || "0",
    String((Number(versionParts[2]) || 0) + 1),
  ].join(".");
  const keys = {
    pending: "pendingUpdate",
    applyRequestedVersion: "autodomApplyRequestedVersion",
    applyRequestedAt: "autodomApplyRequestedAt",
    autoUpdateApplyAttemptAt: "autodomAutoUpdateApplyAttemptAt",
  };
  const { sandbox, removed, writes } = loadServiceWorkerUpdateSanitizer({
    [keys.pending]: { version: futureVersion },
    [keys.applyRequestedVersion]: futureVersion,
    [keys.applyRequestedAt]: 1,
  });

  await sandbox._sanitizeStoredUpdateState("test");

  assert.ok(!removed.includes(keys.pending), "pending update must survive reload races");
  assert.ok(removed.includes(keys.applyRequestedVersion));
  assert.ok(removed.includes(keys.applyRequestedAt));
  assert.ok(removed.includes(keys.autoUpdateApplyAttemptAt));
  assert.deepEqual(writes, []);
});

test("runUpdateCheck applies a pending update that appears after a release is found", async () => {
  const versionParts = manifest.version.split(".");
  const futureVersion = [
    versionParts[0] || "0",
    versionParts[1] || "0",
    String((Number(versionParts[2]) || 0) + 1),
  ].join(".");
  const calls = [];
  const { sandbox, elements } = loadPopup({
    localGet: async (keys) => {
      const wantsPending =
        Array.isArray(keys) ? keys.includes("pendingUpdate") : keys === "pendingUpdate";
      const wantsAvailable =
        Array.isArray(keys)
          ? keys.includes("availableUpdate")
          : keys === "availableUpdate";
      if (wantsPending) {
        const readCount = calls.filter((msg) => msg.type === "AUTODOM_CHECK_FOR_UPDATE").length;
        if (readCount >= 1) {
          return { pendingUpdate: { version: futureVersion } };
        }
      }
      if (wantsAvailable) {
        return {};
      }
      return {};
    },
    sendMessage: async (message) => {
      calls.push(message);
      if (message.type === "AUTODOM_CHECK_FOR_UPDATE") {
        return {
          ok: true,
          status: "new_release_found",
          details: { version: futureVersion },
          availableUpdate: { version: futureVersion },
        };
      }
      if (message.type === "AUTODOM_APPLY_UPDATE") {
        return { ok: true, pendingVersion: futureVersion };
      }
      return { ok: true };
    },
  });

  await sandbox.runUpdateCheck();

  assert.ok(
    calls.some((msg) => msg.type === "AUTODOM_APPLY_UPDATE"),
    "manual update check should apply the pending update",
  );
  assert.equal(elements.get("#checkUpdateBtn").disabled, false);
});

test("auto apply defers reload while an agent run is active", async () => {
  let storageReads = 0;
  let reloaded = false;
  const sandbox = {
    _activeAgentRun: { runId: "active" },
    _debugLog() {},
    _readUpdateStorage: async () => {
      storageReads += 1;
      return { autodomAutoUpdateEnabled: true };
    },
    _writeUpdateStorage: async () => true,
    UPDATE_STORAGE_KEYS: {
      autoUpdateEnabled: "autodomAutoUpdateEnabled",
      autoUpdateApplyAttemptAt: "autodomAutoUpdateApplyAttemptAt",
    },
    AUTO_UPDATE_RELOAD_COOLDOWN_MS: 10 * 60 * 1000,
    chrome: { runtime: { reload() { reloaded = true; } } },
    setTimeout,
    Date,
  };
  const maybeApply = loadServiceWorkerFunction("_maybeAutoApplyPendingUpdate", sandbox);
  assert.equal(await maybeApply({ version: "9.0.0" }, "test"), false);
  assert.equal(storageReads, 0);
  assert.equal(reloaded, false);
});

test("periodic scheduler clears alarm when preference is disabled", async () => {
  let ensured = 0;
  let cleared = 0;
  const sandbox = {
    _isPeriodicUpdateChecksEnabled: async () => false,
    _ensureUpdateCheckAlarm: () => { ensured += 1; },
    _clearUpdateCheckAlarm: () => { cleared += 1; },
  };
  const refresh = loadServiceWorkerFunction("_refreshPeriodicUpdateScheduler", sandbox);
  const result = await refresh("test");
  assert.equal(result.enabled, false);
  assert.equal(result.source, "test");
  assert.equal(ensured, 0);
  assert.equal(cleared, 1);
});
