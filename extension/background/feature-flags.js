/**
 * AutoDOM — Feature flags
 *
 * One chrome.storage.local key ("autodom.features") holds the user-facing
 * switches for the v6 features (vision heal, run mode, undo, parallel runs,
 * overlays, toolbar buttons, performance). The popup's Features tab writes
 * it; the service worker, workflow engine and content scripts read it.
 *
 * Plain script, no ES module syntax, so the same file loads via
 * importScripts() in the service worker, a <script src> in the popup, or a
 * content-script entry. Exposed as globalThis.AutoDOMFeatures:
 *
 *   KEY            storage key
 *   DEFAULTS       frozen default values
 *   normalize(o)   fill defaults, clamp numbers, reject unknown enum values
 *   get()          normalized flags; cached until storage.onChanged fires
 *   set(patch)     merge a patch into the stored flags, returns the result
 *
 * Content scripts that do not load this file read the same key directly and
 * fall back to the same defaults.
 */
(function () {
  if (globalThis.AutoDOMFeatures) return;

  const KEY = "autodom.features";

  const DEFAULTS = Object.freeze({
    // Workflows
    visionHeal: "auto", // auto = on only when an AI provider is enabled
    defaultRunMode: "heal",
    undoTracking: true,
    parallelConcurrency: 3,
    runHistoryLimit: 50,
    // Performance
    compactSnapshotsDefault: false,
    webmcp: true,
    perfMode: "fast",
    toolLanes: true,
    // On-page overlays
    overlaySessionBorder: true,
    overlayTakeoverPill: true,
    overlayVisionMarks: true,
    overlayAutomationRunning: true,
    overlayRecordingIndicator: true,
    // Chat toolbar
    toolbarShowTabRecord: true,
    toolbarShowDescribeImages: true,
  });

  const ENUMS = {
    visionHeal: ["auto", "on", "off"],
    defaultRunMode: ["heal", "strict"],
    perfMode: ["fast", "balanced"],
  };
  const RANGES = {
    parallelConcurrency: [1, 5],
    runHistoryLimit: [10, 200],
  };

  function normalize(obj) {
    const src = obj && typeof obj === "object" ? obj : {};
    const out = {};
    for (const [key, def] of Object.entries(DEFAULTS)) {
      const v = src[key];
      if (ENUMS[key]) {
        out[key] = ENUMS[key].includes(v) ? v : def;
      } else if (RANGES[key]) {
        const n = Number(v);
        const [lo, hi] = RANGES[key];
        out[key] = v === null || v === "" || !Number.isFinite(n)
          ? def
          : Math.max(lo, Math.min(hi, Math.round(n)));
      } else {
        out[key] = typeof v === "boolean" ? v : def;
      }
    }
    return out;
  }

  function storageArea() {
    try {
      return (globalThis.chrome && chrome.storage && chrome.storage.local) || null;
    } catch (_) {
      return null;
    }
  }

  // Promise-based read that also works with the callback-only API shape.
  function readRaw() {
    const area = storageArea();
    if (!area || typeof area.get !== "function") return Promise.resolve(undefined);
    return new Promise((resolve) => {
      try {
        const maybe = area.get([KEY], (items) => {
          try { void chrome.runtime.lastError; } catch (_) {}
          resolve(items ? items[KEY] : undefined);
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then((items) => resolve(items ? items[KEY] : undefined), () => resolve(undefined));
        }
      } catch (_) {
        resolve(undefined);
      }
    });
  }

  function writeRaw(value) {
    const area = storageArea();
    if (!area || typeof area.set !== "function") return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const maybe = area.set({ [KEY]: value }, () => {
          try { void chrome.runtime.lastError; } catch (_) {}
          resolve(true);
        });
        if (maybe && typeof maybe.then === "function") {
          maybe.then(() => resolve(true), () => resolve(false));
        }
      } catch (_) {
        resolve(false);
      }
    });
  }

  let cache = null; // normalized flags, or null when stale
  let pending = null; // in-flight read shared by concurrent get() calls

  async function get() {
    if (cache) return { ...cache };
    if (!pending) {
      pending = readRaw()
        .then((raw) => {
          cache = normalize(raw);
          return cache;
        })
        .finally(() => {
          pending = null;
        });
    }
    return { ...(await pending) };
  }

  async function set(patch) {
    const current = normalize(await readRaw());
    const next = normalize({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
    await writeRaw(next);
    cache = next;
    return { ...next };
  }

  try {
    if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes || !changes[KEY]) return;
        cache = null;
      });
    }
  } catch (_) {}

  globalThis.AutoDOMFeatures = { KEY, DEFAULTS, normalize, get, set };
})();
