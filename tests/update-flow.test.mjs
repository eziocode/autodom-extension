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
const manifest = JSON.parse(
  readFileSync(resolve(here, "../extension/manifest.json"), "utf8"),
);

function makeElement() {
  return {
    textContent: "",
    title: "",
    disabled: false,
    dataset: {},
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
        },
        session: {
          get(keys, callback) {
            return sandbox.chrome.storage.local.get(keys, callback);
          },
          set(values, callback) {
            return sandbox.chrome.storage.local.set(values, callback);
          },
        },
        onChanged: { addListener() {} },
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
    console,
    URLSearchParams,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  getElement("#appVersion");
  getElement("#checkUpdateBtn");
  vm.createContext(sandbox);
  vm.runInContext(popupSrc, sandbox);
  return { sandbox, elements };
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
