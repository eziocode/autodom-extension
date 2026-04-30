/**
 * AutoDOM — Popup Controller
 * Manages the popup UI — Status tab + Config tab.
 * Lets the user connect to the MCP server and opt into auto-connect.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
  appVersion: $("#appVersion"),
  checkUpdateBtn: $("#checkUpdateBtn"),
  actionBtn: $("#actionBtn"),
  actionBtnText: $("#actionBtnText"),
  portInput: $("#portInput"),
  portMismatchHint: $("#portMismatchHint"),
  portMismatchText: $("#portMismatchText"),
  portMismatchFixBtn: $("#portMismatchFixBtn"),
  statusCard: $("#statusCard"),
  statusLabel: $("#statusLabel"),
  statusDetail: $("#statusDetail"),
  tabUrl: $("#tabUrl"),
  logContainer: $("#logContainer"),
  logFilter: $("#logFilter"),
  logClear: $("#logClear"),
  connectBtn: $("#connectBtn"),
  autoConnectToggle: $("#autoConnectToggle"),
  autoUpdateToggle: $("#autoUpdateToggle"),
  aiChatBtn: $("#aiChatBtn"),
  providerSelect: $("#providerSelect"),
  providerApiKey: $("#providerApiKey"),
  providerModel: $("#providerModel"),
  providerBaseUrl: $("#providerBaseUrl"),
  providerCliKind: $("#providerCliKind"),
  providerCliBinary: $("#providerCliBinary"),
  providerCliExtraArgs: $("#providerCliExtraArgs"),
  providerEnabledToggle: $("#providerEnabledToggle"),
  providerPreset: $("#providerPreset"),
  saveProviderBtn: $("#saveProviderBtn"),
  testProviderBtn: $("#testProviderBtn"),
  checkCliBtn: $("#checkCliBtn"),
  providerStatus: $("#providerStatus"),
  cliPromptBox: $("#cliPromptBox"),
  cliPromptText: $("#cliPromptText"),
  cliPromptInstall: $("#cliPromptInstall"),
  cliPromptUseDefault: $("#cliPromptUseDefault"),
  cliPromptInstallBtn: $("#cliPromptInstallBtn"),
  cliPromptDocsBtn: $("#cliPromptDocsBtn"),
  rateLimitToggle: $("#rateLimitToggle"),
  rateLimitMax: $("#rateLimitMax"),
  rateLimitWindow: $("#rateLimitWindow"),
  rateLimitSettings: $("#rateLimitSettings"),
  confirmSubmitToggle: $("#confirmSubmitToggle"),
  scriptBackend: $("#scriptBackend"),
  scriptFile: $("#scriptFile"),
  scriptSource: $("#scriptSource"),
  scriptTimeout: $("#scriptTimeout"),
  validateScriptBtn: $("#validateScriptBtn"),
  runScriptBtn: $("#runScriptBtn"),
  scriptStatus: $("#scriptStatus"),
  scriptOutput: $("#scriptOutput"),
  clearScriptOutputBtn: $("#clearScriptOutputBtn"),
};

let isRunning = false;
let isConnected = false;

const REFRESH_GLYPH = "↻";
const UPDATE_LABEL = "Update";
const AUTO_UPDATE_STORAGE_KEY = "autodomAutoUpdateEnabled";

// Render the ↻ button in either its idle (refresh) state or its
// "update available" CTA state. Driven by chrome.storage.local.pendingUpdate
// which the service worker writes when chrome.runtime.onUpdateAvailable
// fires (or when the popup itself surfaces an update_available result).
function paintUpdateButton(pending) {
  const btn = DOM.checkUpdateBtn;
  const versionEl = DOM.appVersion;
  if (!btn) return;
  if (pending && pending.version) {
    btn.classList.add("has-update");
    btn.textContent = UPDATE_LABEL;
    btn.title = `Update to v${pending.version} ready — click to apply`;
    btn.setAttribute("aria-label", `Update to v${pending.version}`);
    if (versionEl) {
      versionEl.textContent = `v${chrome.runtime.getManifest().version} → v${pending.version}`;
    }
  } else {
    btn.classList.remove("has-update");
    btn.textContent = REFRESH_GLYPH;
    btn.title = "Check for updates";
    btn.setAttribute("aria-label", "Check for updates");
    if (versionEl) {
      versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
    }
  }
}

async function readLocalStorage(keys, context) {
  try {
    const result = await chrome.storage.local.get(keys);
    if (result && typeof result === "object") return result;
    console.warn(
      `[AutoDOM Popup] ${context} storage read returned no data; using defaults.`,
    );
    return {};
  } catch (err) {
    console.warn(
      `[AutoDOM Popup] ${context} storage read failed:`,
      err?.message || err,
    );
    return {};
  }
}

async function readPendingUpdate() {
  try {
    const { pendingUpdate } = await readLocalStorage(
      "pendingUpdate",
      "pending update",
    );
    return pendingUpdate || null;
  } catch (_) {
    return null;
  }
}

async function applyPendingUpdate() {
  const btn = DOM.checkUpdateBtn;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "updating…";
  }
  try {
    // Asks the service worker to call chrome.runtime.reload(), which unloads
    // the SW and applies the pre-downloaded CRX. The popup will then close
    // automatically as the extension reloads.
    await chrome.runtime.sendMessage({ type: "AUTODOM_APPLY_UPDATE" });
  } catch (err) {
    // sendMessage can throw if the SW just woke up; fall back to direct
    // reload from the popup context.
    try { chrome.runtime.reload(); } catch (_) {}
  }
}

// Runs Chromium / Firefox's built-in extension update check against the
// configured `update_url`. Browsers throttle this to a few times per hour,
// so failures with status="throttled" are normal and surfaced to the user.
async function runUpdateCheck() {
  const btn = DOM.checkUpdateBtn;
  const versionEl = DOM.appVersion;
  if (!btn || !versionEl) return;

  // If an update is already pending, this click means "apply it now".
  if (btn.classList.contains("has-update")) {
    await applyPendingUpdate();
    return;
  }

  const setLabel = (text, ttl = 4000) => {
    versionEl.textContent = text;
    if (ttl > 0) {
      setTimeout(async () => {
        // Re-read pending so the label reverts to the right state if an
        // update was discovered mid-check.
        const pending = await readPendingUpdate();
        paintUpdateButton(pending);
      }, ttl);
    }
  };

  btn.disabled = true;
  btn.classList.add("spin");
  versionEl.textContent = "checking…";

  try {
    const result = await sendRuntimeMessage({
      type: "AUTODOM_CHECK_FOR_UPDATE",
      force: true,
      source: "popup_manual",
    });
    if (result?.error || result?.ok === false || result?.success === false) {
      setLabel(`error: ${(result && result.error) || "check failed"}`.slice(0, 40));
      return;
    }

    const status = (result && result.status) || "unknown";
    if (status === "update_available") {
      const v =
        (result.pendingUpdate && result.pendingUpdate.version) ||
        (result.details && result.details.version) ||
        "?";
      btn.classList.remove("spin");
      btn.disabled = false;
      paintUpdateButton({ version: v });
      return;
    } else if (status === "no_update") {
      setLabel("up to date");
    } else if (status === "throttled") {
      setLabel("rate-limited");
    } else if (status === "skipped" && result.reason === "not_due") {
      setLabel("checked recently");
    } else if (status === "unsupported") {
      setLabel("not supported");
    } else {
      setLabel(String(status));
    }
  } catch (err) {
    setLabel(`error: ${(err && err.message) || err}`.slice(0, 40));
  } finally {
    btn.classList.remove("spin");
    btn.disabled = false;
  }
}

async function requestDueUpdateCheck(source) {
  try {
    const result = await sendRuntimeMessage({
      type: "AUTODOM_CHECK_FOR_UPDATE",
      force: false,
      source,
    });
    if (result?.pendingUpdate) {
      paintUpdateButton(result.pendingUpdate);
    }
  } catch (err) {
    console.warn(
      "[AutoDOM Popup] Background update check failed:",
      err?.message || err,
    );
  }
}

const ACTIVITY_LOG_KEY = "autodomActivityLogs";
const ACTIVITY_FILTER_KEY = "autodomActivityLogFilter";
const activityStorage = (() => {
  try {
    return chrome.storage.session || chrome.storage.local;
  } catch (_) {
    return chrome.storage.local;
  }
})();
let providerSettings = {
  source: "ide",
  apiKey: "",
  model: "",
  baseUrl: "",
  cliBinary: "",
  cliKind: "claude",
  cliExtraArgs: "",
  enabled: false,
  preset: "custom",
};
const TAB_ACTIVATED_EVENT = "autodom:tab-activated";

// Provider presets — each maps a vendor to the underlying API protocol
// AutoDOM already speaks (openai-compatible / anthropic / ollama) plus
// sensible default base URL and model. Inspired by mostbean-cn/coding-switch.
const PROVIDER_PRESETS = {
  custom: null,
  "openai-official": {
    source: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  "anthropic-official": {
    source: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-sonnet-latest",
  },
  "ollama-local": {
    source: "ollama",
    baseUrl: "http://localhost:11434",
    model: "llama3.2",
  },
  deepseek: {
    source: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  zhipu: {
    source: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-plus",
  },
  moonshot: {
    source: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
  qianfan: {
    source: "openai",
    baseUrl: "https://qianfan.baidubce.com/v2",
    model: "ernie-4.0-8k",
  },
  dashscope: {
    source: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-turbo",
  },
};

// Suppress autosave / preset-reset while we're programmatically applying a preset.
let _suppressFieldEvents = false;

// Per-CLI-kind metadata used to prompt the user to install / configure
// the chosen local CLI binary. Inspired by mostbean-cn/coding-switch's
// CLI-aware provider flow.
const CLI_KIND_INFO = {
  claude: {
    label: "Claude Code CLI",
    binary: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    install: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
  },
  codex: {
    label: "Codex CLI",
    binary: "codex",
    npmPackage: "@openai/codex",
    install: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex",
  },
  copilot: {
    label: "GitHub Copilot CLI",
    binary: "copilot",
    npmPackage: "@github/copilot",
    install: "npm install -g @github/copilot",
    docsUrl: "https://docs.github.com/en/copilot/github-copilot-in-the-cli",
    authHint:
      "Run `copilot` once interactively and follow the GitHub device-login prompt to authenticate.",
  },
  custom: {
    label: "Custom CLI",
    binary: "",
    install: "# Install your CLI of choice, then enter its name or absolute path above.",
    docsUrl: "",
  },
};

function getCliKindInfo(kind) {
  return CLI_KIND_INFO[kind] || CLI_KIND_INFO.claude;
}

let activityLogs = [];
let activityFilter = "all";

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(
        response ?? {
          success: false,
          error: "No response from extension background worker.",
        },
      );
    });
  });
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Embedded mode: when popup.html is rendered inside the chat
  // panel via iframe (?embedded=1), we relax the fixed 360px width
  // so the iframe content reflows with the side panel, and we hide
  // affordances that would conflict with the surrounding chat
  // (e.g. the "Open AI Chat" button that would spawn a second chat).
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("embedded") === "1") {
      document.body.classList.add("embedded");
    }
  } catch (_) {}

  if (DOM.appVersion) {
    DOM.appVersion.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  if (DOM.checkUpdateBtn) {
    DOM.checkUpdateBtn.addEventListener("click", () => runUpdateCheck());
    // Initial paint: if the service worker has already detected a pending
    // update on a previous popup-less browser session, show the CTA state
    // immediately.
    readPendingUpdate().then((pending) => paintUpdateButton(pending));
    // Live updates: react to onUpdateAvailable arriving while the popup
    // is open (e.g. the user opens it just before the browser's scheduled
    // check fires).
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes.pendingUpdate) return;
        paintUpdateButton(changes.pendingUpdate.newValue || null);
      });
    } catch (_) {}
    requestDueUpdateCheck("popup_open");
  }

// API keys live in chrome.storage.session (RAM-only). Falls back to local
// on browsers that don't yet expose `session` storage.
const _secretArea = (chrome.storage && chrome.storage.session) || chrome.storage.local;
const _secretAreaName =
  chrome.storage && chrome.storage.session && _secretArea === chrome.storage.session
    ? "session"
    : "local";

  // Load saved port, server path, auto-connect preference, and provider settings
  const stored = await readLocalStorage([
    "mcpPort",
    "serverPath",
    "autoConnect",
    AUTO_UPDATE_STORAGE_KEY,
    "aiProviderSource",
    "aiProviderApiKey",
    "aiProviderModel",
    "aiProviderBaseUrl",
    "aiProviderCliBinary",
    "aiProviderCliKind",
    "aiProviderCliExtraArgs",
    "aiProviderEnabled",
    "aiProviderPreset",
  ], "startup settings");
  const secretStored = await new Promise((resolve) => {
    try {
      _secretArea.get(["aiProviderApiKey"], (r) => resolve(r || {}));
    } catch (_) {
      resolve({});
    }
  });
  // Migrate legacy plaintext key from local → session storage.
  const apiKey = secretStored.aiProviderApiKey || stored.aiProviderApiKey || "";
  if (!secretStored.aiProviderApiKey && stored.aiProviderApiKey) {
    try {
      _secretArea.set({ aiProviderApiKey: apiKey });
      chrome.storage.local.remove("aiProviderApiKey");
    } catch (_) {}
  }
  const port = stored.mcpPort || 9876;
  const serverPath = stored.serverPath || null;
  const autoConnect = stored.autoConnect === true;
  const autoUpdate = stored[AUTO_UPDATE_STORAGE_KEY] === true;

  providerSettings = {
    source: stored.aiProviderSource || "ide",
    apiKey,
    model: stored.aiProviderModel || "",
    baseUrl: stored.aiProviderBaseUrl || "",
    cliBinary: stored.aiProviderCliBinary || "",
    cliKind: stored.aiProviderCliKind || "claude",
    cliExtraArgs: stored.aiProviderCliExtraArgs || "",
    enabled: stored.aiProviderEnabled === true,
    preset: stored.aiProviderPreset || "custom",
  };

  // One-shot migration: older builds auto-filled a hardcoded model
  // (e.g. "gpt-5") for CLI providers. We no longer hardcode — let the
  // CLI use its own configured default. Clear stored values that match
  // those legacy defaults so the field shows blank and `--model` is
  // omitted at runtime. Users who deliberately picked a different model
  // are left untouched.
  const _LEGACY_CLI_MODELS = new Set([
    "gpt-5",
    "gpt-5-codex",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-7",
    "claude-sonnet-4.5",
    "o4-mini",
  ]);
  const _isCliSource =
    providerSettings.source === "cli" || providerSettings.source === "ide";
  if (_isCliSource && _LEGACY_CLI_MODELS.has(providerSettings.model)) {
    providerSettings.model = "";
    try {
      chrome.storage.local.set({ aiProviderModel: "" });
    } catch (_) {}
  }

  DOM.portInput.value = port;
  DOM.autoConnectToggle.checked = autoConnect;
  if (DOM.autoUpdateToggle) DOM.autoUpdateToggle.checked = autoUpdate;
  if (DOM.providerSelect) DOM.providerSelect.value = providerSettings.source;
  if (DOM.providerApiKey) DOM.providerApiKey.value = providerSettings.apiKey;
  if (DOM.providerModel) DOM.providerModel.value = providerSettings.model;
  if (DOM.providerBaseUrl) DOM.providerBaseUrl.value = providerSettings.baseUrl;
  if (DOM.providerCliBinary)
    DOM.providerCliBinary.value = providerSettings.cliBinary;
  if (DOM.providerCliKind)
    DOM.providerCliKind.value = providerSettings.cliKind || "claude";
  if (DOM.providerCliExtraArgs)
    DOM.providerCliExtraArgs.value = providerSettings.cliExtraArgs;
  if (DOM.providerEnabledToggle)
    DOM.providerEnabledToggle.checked = !!providerSettings.enabled;
  if (DOM.providerPreset)
    DOM.providerPreset.value = providerSettings.preset || "custom";
  updateProviderUI();

  const storedActivity = await activityStorage.get([ACTIVITY_LOG_KEY]);
  activityLogs = Array.isArray(storedActivity[ACTIVITY_LOG_KEY])
    ? storedActivity[ACTIVITY_LOG_KEY]
    : [];

  const storedUiState = await readLocalStorage(
    [ACTIVITY_FILTER_KEY],
    "activity filter",
  );
  activityFilter = storedUiState[ACTIVITY_FILTER_KEY] || "all";
  if (DOM.logFilter) DOM.logFilter.value = activityFilter;
  renderActivityLogs(activityLogs);

  // Load guardrails settings
  const guardrails = await readLocalStorage([
    "rateLimitConfig",
    "confirmBeforeSubmitConfig",
  ], "guardrails");
  if (guardrails.rateLimitConfig) {
    if (DOM.rateLimitToggle)
      DOM.rateLimitToggle.checked = !!guardrails.rateLimitConfig.enabled;
    if (DOM.rateLimitMax)
      DOM.rateLimitMax.value =
        guardrails.rateLimitConfig.maxCallsPerDomain || 100;
    if (DOM.rateLimitWindow)
      DOM.rateLimitWindow.value = String(
        guardrails.rateLimitConfig.windowMs || 60000,
      );
    if (DOM.rateLimitSettings)
      DOM.rateLimitSettings.style.display = guardrails.rateLimitConfig.enabled
        ? "block"
        : "none";
  }
  if (guardrails.confirmBeforeSubmitConfig) {
    if (DOM.confirmSubmitToggle)
      DOM.confirmSubmitToggle.checked =
        !!guardrails.confirmBeforeSubmitConfig.enabled;
  }

  // Get active tab info
  refreshTabInfo();

  // Request current status
  const response = await sendRuntimeMessage({ type: "GET_STATUS" });
  if (response && !response.error) {
    isRunning = !!response.running;
    isConnected = !!response.connected;
    updateUI();
    if (response.connected) {
      addLog("Connected to MCP bridge server", "success");
    } else if (response.running) {
      addLog("MCP connection attempt in progress.", "info");
    } else {
      addLog("Disconnected. Click Connect or enable auto-connect.", "info");
    }
  } else if (response?.error) {
    addLog(`Background worker unavailable: ${response.error}`, "error");
  }

  // Init tabs
  initTabs();

  // Generate config snippets with auto-detected path
  generateConfigs(port, serverPath);

  // Update config when port changes
  DOM.portInput.addEventListener("change", async () => {
    const s = await readLocalStorage(["serverPath"], "server path");
    generateConfigs(
      parseInt(DOM.portInput.value, 10) || 9876,
      s.serverPath || null,
    );
    refreshPortMismatchHint();
  });

  // Port-mismatch guardrail: surfaces the live bridge port when the
  // configured port is unreachable. Service worker writes mcpDetectedPort
  // after a probe; we react by showing a banner with a one-click fix.
  refreshPortMismatchHint();
  if (DOM.portMismatchFixBtn) {
    DOM.portMismatchFixBtn.addEventListener("click", async () => {
      const stored = await readLocalStorage(
        ["mcpDetectedPort"],
        "detected port",
      );
      const detected = Number(stored.mcpDetectedPort);
      if (!Number.isFinite(detected) || detected <= 0) return;
      DOM.portInput.value = String(detected);
      await chrome.storage.local.set({ mcpPort: detected });
      const s = await readLocalStorage(["serverPath"], "server path");
      generateConfigs(detected, s.serverPath || null);
      addLog(`Switched to detected bridge port ${detected}.`, "info");
      try {
        await sendRuntimeMessage({ type: "START_MCP", port: detected });
      } catch (_) {}
      refreshPortMismatchHint();
    });
  }

  // Update auto-connect preference
  DOM.autoConnectToggle.addEventListener("change", async (e) => {
    const autoConnect = e.target.checked;
    await chrome.storage.local.set({ autoConnect });
    // Tell service worker about the change
    const response = await sendRuntimeMessage({
      type: "SET_AUTO_CONNECT",
      value: autoConnect,
    });
    if (response?.error) {
      addLog(`Failed to update auto-connect: ${response.error}`, "error");
    }
  });

  if (DOM.autoUpdateToggle) {
    DOM.autoUpdateToggle.addEventListener("change", async (e) => {
      const enabled = e.target.checked;
      await chrome.storage.local.set({ [AUTO_UPDATE_STORAGE_KEY]: enabled });
      const response = await sendRuntimeMessage({
        type: "AUTODOM_SET_AUTO_UPDATE",
        enabled,
      });
      if (response?.error || response?.ok === false || response?.success === false) {
        addLog(
          `Failed to update auto-update: ${response?.error || "background worker unavailable"}`,
          "error",
        );
        return;
      }
      addLog(
        enabled
          ? "Auto-update enabled. Pending updates will apply automatically."
          : "Auto-update disabled. Updates will wait for manual apply.",
        "info",
      );
    });
  }

  // Listen for path/provider updates (both local and session areas)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (changes.serverPath) {
      generateConfigs(
        parseInt(DOM.portInput.value, 10) || 9876,
        changes.serverPath.newValue,
      );
    }

    if (areaName === "local" && (changes.mcpDetectedPort || changes.mcpPort)) {
      refreshPortMismatchHint();
    }

    if (
      areaName === "local" &&
      changes[AUTO_UPDATE_STORAGE_KEY] &&
      DOM.autoUpdateToggle
    ) {
      DOM.autoUpdateToggle.checked =
        changes[AUTO_UPDATE_STORAGE_KEY].newValue === true;
    }

    if (changes[ACTIVITY_LOG_KEY]) {
      activityLogs = Array.isArray(changes[ACTIVITY_LOG_KEY].newValue)
        ? changes[ACTIVITY_LOG_KEY].newValue
        : [];
      renderActivityLogs(activityLogs);
    }

    if (changes[ACTIVITY_FILTER_KEY]) {
      activityFilter = changes[ACTIVITY_FILTER_KEY].newValue || "all";
      if (DOM.logFilter) DOM.logFilter.value = activityFilter;
      renderActivityLogs(activityLogs);
    }

    // API key changes arrive on the session area; other settings on local.
    const apiKeyChange =
      areaName === _secretAreaName ? changes.aiProviderApiKey : undefined;
    if (
      changes.aiProviderSource ||
      apiKeyChange ||
      changes.aiProviderModel ||
      changes.aiProviderBaseUrl
    ) {
      providerSettings = {
        source: changes.aiProviderSource
          ? changes.aiProviderSource.newValue
          : providerSettings.source,
        apiKey: apiKeyChange
          ? apiKeyChange.newValue
          : providerSettings.apiKey,
        model: changes.aiProviderModel
          ? changes.aiProviderModel.newValue
          : providerSettings.model,
        baseUrl: changes.aiProviderBaseUrl
          ? changes.aiProviderBaseUrl.newValue
          : providerSettings.baseUrl,
      };

      if (DOM.providerSelect)
        DOM.providerSelect.value = providerSettings.source;
      if (DOM.providerApiKey)
        DOM.providerApiKey.value = providerSettings.apiKey || "";
      if (DOM.providerModel)
        DOM.providerModel.value = providerSettings.model || "";
      if (DOM.providerBaseUrl)
        DOM.providerBaseUrl.value = providerSettings.baseUrl || "";
      updateProviderUI();
    }
  });

  if (DOM.providerSelect) {
    DOM.providerSelect.addEventListener("change", () => {
      if (_suppressFieldEvents) return;
      providerSettings.source = DOM.providerSelect.value || "ide";
      // Manual change → preset no longer matches.
      _resetPresetIfManualEdit();
      updateProviderUI();
      // Auto-save when provider changes so settings persist immediately
      saveProviderSettings();
    });
  }

  if (DOM.providerPreset) {
    DOM.providerPreset.addEventListener("change", () => {
      applyPreset(DOM.providerPreset.value || "custom");
    });
  }

  // Manual edits to baseUrl / model should drop the preset label to "custom"
  // (otherwise the UI would lie about which preset is active).
  ["providerBaseUrl", "providerModel", "providerApiKey"].forEach((k) => {
    const el = DOM[k];
    if (!el) return;
    el.addEventListener("input", () => {
      if (_suppressFieldEvents) return;
      _resetPresetIfManualEdit();
    });
  });

  if (DOM.saveProviderBtn) {
    DOM.saveProviderBtn.addEventListener("click", () => saveProviderSettings());
  }

  if (DOM.testProviderBtn) {
    DOM.testProviderBtn.addEventListener("click", testProviderConnection);
  }

  // ─── CLI prompt wiring ────────────────────────────────────
  // When the user picks "Local CLI" we render an inline hint with the
  // expected default binary, an install command, and a one-click
  // "Use default" autofill. Triggered on kind/provider change.
  if (DOM.providerCliKind) {
    DOM.providerCliKind.addEventListener("change", () => {
      if (_suppressFieldEvents) return;
      // Auto-fill / replace the binary when the user switches CLI kind.
      // Behaviour:
      //   • If the binary field is empty → fill with the new default.
      //   • If the binary still matches a *different* kind's default
      //     (e.g. user had "claude" and switched to "codex") → swap to
      //     the new default so it actually works.
      //   • Otherwise the user has typed a custom path/binary — leave
      //     it alone so we don't clobber their override.
      const kind = DOM.providerCliKind.value || "claude";
      const info = getCliKindInfo(kind);
      const knownDefaults = Object.values(CLI_KIND_INFO)
        .map((i) => (i.binary || "").trim())
        .filter(Boolean);
      const current = (DOM.providerCliBinary?.value || "").trim();
      if (DOM.providerCliBinary && (!current || knownDefaults.includes(current))) {
        DOM.providerCliBinary.value = info.binary || "";
      }
      updateProviderUI();
      saveProviderSettings({ skipTest: true });
    });
  }

  if (DOM.providerCliBinary) {
    DOM.providerCliBinary.addEventListener("input", () => {
      if (_suppressFieldEvents) return;
      // Re-render so the prompt hides as soon as the user types a binary.
      renderCliPrompt();
    });
  }

  if (DOM.cliPromptUseDefault) {
    DOM.cliPromptUseDefault.addEventListener("click", () => {
      const kind = DOM.providerCliKind?.value || "claude";
      const info = getCliKindInfo(kind);
      if (!info.binary) {
        updateProviderUI(
          "Custom CLI has no default — enter the binary name or absolute path.",
        );
        DOM.providerCliBinary?.focus();
        return;
      }
      if (DOM.providerCliBinary) DOM.providerCliBinary.value = info.binary;
      saveProviderSettings({ skipTest: true });
      // Try a real probe so the user gets immediate feedback.
      checkCliBinary();
    });
  }

  if (DOM.cliPromptInstallBtn) {
    DOM.cliPromptInstallBtn.addEventListener("click", installDefaultCliPackage);
  }

  if (DOM.cliPromptDocsBtn) {
    DOM.cliPromptDocsBtn.addEventListener("click", () => {
      const kind = DOM.providerCliKind?.value || "claude";
      const info = getCliKindInfo(kind);
      if (info.docsUrl) {
        chrome.tabs.create({ url: info.docsUrl });
      }
    });
  }

  if (DOM.checkCliBtn) {
    DOM.checkCliBtn.addEventListener("click", checkCliBinary);
  }

  if (DOM.logFilter) {
    DOM.logFilter.addEventListener("change", async () => {
      activityFilter = DOM.logFilter.value || "all";
      await chrome.storage.local.set({
        [ACTIVITY_FILTER_KEY]: activityFilter,
      });
      renderActivityLogs(activityLogs);
    });
  }

  if (DOM.providerEnabledToggle) {
    DOM.providerEnabledToggle.addEventListener("change", () => {
      // Save provider settings when the toggle changes
      saveProviderSettings();
    });
  }

  initScriptRunner();
  initSecurityTab();
  initChatSettingsTab();
  initChatAppearanceTab();
});

// ─── Chat panel appearance (theme + accent colour) ───
// Shared with chat-panel.js via two storage keys:
//   __autodom_chat_theme  : "system" | "dark" | "light"
//   __autodom_chat_accent : CSS colour string, or null/unset = theme default
// chat-panel.js listens to storage.onChanged for both keys, so writes
// here are reflected live in the side panel without a reload.
function initChatAppearanceTab() {
  const THEME_KEY = "__autodom_chat_theme";
  const ACCENT_KEY = "__autodom_chat_accent";
  const themeSelect = document.getElementById("chatThemeSelect");
  const swatchesEl = document.getElementById("chatAccentSwatches");
  const customInput = document.getElementById("chatAccentCustom");
  const resetBtn = document.getElementById("chatAccentReset");
  const applyBtn = document.getElementById("chatAccentApply");
  const statusEl = document.getElementById("chatAccentStatus");
  const previewEl = document.getElementById("chatAccentPreview");
  if (!themeSelect || !swatchesEl || !customInput || !resetBtn || !applyBtn)
    return;

  const swatches = Array.from(swatchesEl.querySelectorAll(".accent-swatch"));

  // The currently *staged* accent (what the user picked but hasn't
  // applied yet). Empty string = "use theme default".
  let pendingAccent = "";
  // The accent currently persisted in storage. We use this to drive
  // the Apply button's enabled state so the user can see whether their
  // selection differs from what's already live in the chat panel.
  let appliedAccent = "";
  let statusTimer = null;

  function updatePreview(value) {
    if (!previewEl) return;
    if (!value) {
      previewEl.classList.add("is-default");
      previewEl.style.removeProperty("--preview-1");
      previewEl.style.removeProperty("--preview-2");
      return;
    }
    previewEl.classList.remove("is-default");
    previewEl.style.setProperty("--preview-1", value);
    previewEl.style.setProperty(
      "--preview-2",
      `color-mix(in oklch, ${value} 78%, white)`,
    );
  }

  function refreshApplyState() {
    const dirty = pendingAccent !== appliedAccent;
    applyBtn.disabled = !dirty;
    applyBtn.classList.toggle("is-dirty", dirty);
  }

  function flashStatus(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.add("is-visible");
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.classList.remove("is-visible");
    }, 1800);
  }

  function reflectAccentSelection(value, { stageOnly = false } = {}) {
    const v = value || "";
    pendingAccent = v;
    let matched = false;
    swatches.forEach((sw) => {
      const isMatch = (sw.dataset.accent || "") === v;
      sw.setAttribute("aria-checked", isMatch ? "true" : "false");
      if (isMatch) matched = true;
    });
    if (!matched && v) {
      try {
        customInput.value = v;
      } catch (_) {}
    }
    updatePreview(v);
    refreshApplyState();
    if (!stageOnly) {
      // Sync from storage — treat as already-applied.
      appliedAccent = v;
      refreshApplyState();
    }
  }

  // Initial load.
  chrome.storage?.local?.get?.([THEME_KEY, ACCENT_KEY], (items) => {
    const theme = (items && items[THEME_KEY]) || "system";
    const accent = (items && items[ACCENT_KEY]) || "";
    if (["system", "dark", "light"].includes(theme))
      themeSelect.value = theme;
    reflectAccentSelection(accent);
  });

  themeSelect.addEventListener("change", () => {
    chrome.storage?.local?.set?.({ [THEME_KEY]: themeSelect.value });
  });

  swatches.forEach((sw) => {
    sw.addEventListener("click", () => {
      reflectAccentSelection(sw.dataset.accent || "", { stageOnly: true });
    });
  });

  customInput.addEventListener("input", () => {
    reflectAccentSelection(customInput.value || "", { stageOnly: true });
  });

  applyBtn.addEventListener("click", () => {
    const value = pendingAccent;
    if (value) {
      chrome.storage?.local?.set?.({ [ACCENT_KEY]: value }, () => {
        appliedAccent = value;
        refreshApplyState();
        flashStatus("✓ Applied to chat panel");
      });
    } else {
      chrome.storage?.local?.remove?.(ACCENT_KEY, () => {
        appliedAccent = "";
        refreshApplyState();
        flashStatus("✓ Reset to theme default");
      });
    }
  });

  resetBtn.addEventListener("click", () => {
    reflectAccentSelection("", { stageOnly: true });
    chrome.storage?.local?.remove?.(ACCENT_KEY, () => {
      appliedAccent = "";
      refreshApplyState();
      flashStatus("✓ Reset to theme default");
    });
  });

  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[THEME_KEY]) {
        const v = changes[THEME_KEY].newValue || "system";
        if (["system", "dark", "light"].includes(v)) themeSelect.value = v;
      }
      if (changes[ACCENT_KEY]) {
        reflectAccentSelection(changes[ACCENT_KEY].newValue || "");
      }
    });
  }
}

// ─── Chat panel settings (mirrors __autodom_chat_settings used by chat-panel.js) ───
// chat-panel.js owns the storage shape; we only touch the two boolean
// fields that map to UI toggles here. A storage.onChanged listener
// keeps the popup in sync if the user flips the same toggle from
// another window/tab.
function initChatSettingsTab() {
  const STORAGE_KEY = "__autodom_chat_settings";
  const verboseToggle = document.getElementById("chatVerboseToggle");
  const persistToggle = document.getElementById("chatPersistToggle");
  const styleSelect = document.getElementById("chatResponseStyle");
  if (!verboseToggle || !persistToggle) return;

  function applyToUI(s) {
    if (!s || typeof s !== "object") return;
    if (typeof s.verboseLogs === "boolean")
      verboseToggle.checked = s.verboseLogs;
    if (typeof s.persistAcrossSessions === "boolean")
      persistToggle.checked = s.persistAcrossSessions;
    if (styleSelect && typeof s.responseStyle === "string" &&
        ["concise", "jetbrains", "chatbar"].includes(s.responseStyle)) {
      styleSelect.value = s.responseStyle;
    }
  }

  // Initial load — defaults match chat-panel.js (verboseLogs:true,
  // persistAcrossSessions:false, responseStyle:"concise") so first-time
  // users see the same state regardless of which surface they look at.
  chrome.storage?.local?.get?.([STORAGE_KEY], (items) => {
    const s = (items && items[STORAGE_KEY]) || {
      verboseLogs: true,
      persistAcrossSessions: false,
      responseStyle: "concise",
    };
    applyToUI({
      verboseLogs:
        typeof s.verboseLogs === "boolean" ? s.verboseLogs : true,
      persistAcrossSessions:
        typeof s.persistAcrossSessions === "boolean"
          ? s.persistAcrossSessions
          : false,
      responseStyle:
        typeof s.responseStyle === "string" ? s.responseStyle : "concise",
    });
  });

  function persistField(field, value) {
    chrome.storage?.local?.get?.([STORAGE_KEY], (items) => {
      const cur = (items && items[STORAGE_KEY]) || {};
      const next = { ...cur, [field]: value };
      chrome.storage.local.set({ [STORAGE_KEY]: next });
    });
  }

  verboseToggle.addEventListener("change", () => {
    persistField("verboseLogs", !!verboseToggle.checked);
  });
  persistToggle.addEventListener("change", () => {
    persistField("persistAcrossSessions", !!persistToggle.checked);
  });
  if (styleSelect) {
    styleSelect.addEventListener("change", () => {
      const v = styleSelect.value;
      if (["concise", "jetbrains", "chatbar"].includes(v)) {
        persistField("responseStyle", v);
      }
    });
  }

  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      applyToUI(changes[STORAGE_KEY].newValue);
    });
  }
}

// ─── Tab Switching ───────────────────────────────────────────
function initTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
    });
  });

  // Copy buttons
  $$(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.copy;
      const el = $(`#${targetId}`);
      if (el) {
        const textDetail = el.textContent.trim();
        let success = false;

        try {
          // Try modern API first
          await navigator.clipboard.writeText(textDetail);
          success = true;
        } catch (err) {
          // Fallback to legacy execCommand (reliable in extension popups)
          try {
            const textArea = document.createElement("textarea");
            textArea.value = textDetail;
            // Avoid scrolling to bottom
            textArea.style.top = "0";
            textArea.style.left = "0";
            textArea.style.position = "fixed";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            success = document.execCommand("copy");
            document.body.removeChild(textArea);
          } catch (_) {}
        }

        if (success) {
          btn.classList.add("copied");
          setTimeout(() => btn.classList.remove("copied"), 1500);
        } else {
          addLog("Failed to copy text", "error");
        }
      }
    });
  });
}

function activateTab(tabName) {
  if (!tabName) return false;

  let activated = false;
  $$(".tab").forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    activated = activated || isActive;
  });
  $$(".tab-content").forEach((content) => {
    content.classList.toggle("active", content.id === `tab-${tabName}`);
  });

  if (activated) {
    document.dispatchEvent(
      new CustomEvent(TAB_ACTIVATED_EVENT, {
        detail: { tab: tabName },
      }),
    );
  }

  return activated;
}

// ─── Port-Mismatch Hint ──────────────────────────────────────
// Service worker writes mcpDetectedPort after a probe finds a live
// bridge on a port other than the one the user configured. Reflect
// that into the popup so the user gets a one-click way to fix it
// instead of staring at a generic "connection refused" status.
async function refreshPortMismatchHint() {
  if (!DOM.portMismatchHint) return;
  try {
    const stored = await readLocalStorage([
      "mcpPort",
      "mcpDetectedPort",
    ], "port mismatch");
    const configured = Number(stored.mcpPort) || 9876;
    const detected = Number(stored.mcpDetectedPort);
    const showBanner =
      Number.isFinite(detected) &&
      detected > 0 &&
      detected !== configured;
    if (showBanner) {
      DOM.portMismatchText.textContent =
        `Bridge detected on port ${detected}, but extension is set to ${configured}.`;
      DOM.portMismatchHint.style.display = "block";
    } else {
      DOM.portMismatchHint.style.display = "none";
    }
  } catch (_) {
    DOM.portMismatchHint.style.display = "none";
  }
}

// ─── Config Generation ───────────────────────────────────────
function generateConfigs(port, detectedPath) {
  const isDetected = !!detectedPath;
  const serverPath = detectedPath || "autodom-extension/server/index.js";

  const portArgs = port !== 9876 ? `, "--port", "${port}"` : "";

  $("#configPort").textContent = port;

  $("#serverPath").textContent = isDetected
    ? serverPath
    : `${serverPath}  (connect to auto-detect full path)`;
  $("#serverPath").style.color = isDetected ? "#22c55e" : "#f59e0b";

  // Unified JSON config (VS Code, IntelliJ, Gemini CLI, Claude Desktop)
  $("#mcpConfig").textContent = `{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["${serverPath}"${portArgs}]
    }
  }
}`;

  // TOML config (Codex)
  const tomlArgs = port !== 9876
    ? `["${serverPath}", "--port", "${port}"]`
    : `["${serverPath}"]`;
  $("#tomlConfig").textContent = `[mcp_servers.autodom]
command = "node"
args = ${tomlArgs}`;
}

// ─── Event Listeners ─────────────────────────────────────────
DOM.actionBtn.addEventListener("click", () => {
  activateTab("config");
});

// ─── AI Chat Button ──────────────────────────────────────────
// Opens the AI chat panel on the active tab. Only works when MCP is connected.
//
// "NEW" badge logic — bump this key when shipping a wave of features you
// want current users to rediscover. We persist the *seen* version so the
// badge re-appears whenever AI_CHAT_NEW_VERSION bumps, even for long-time
// users.
const AI_CHAT_NEW_VERSION = "2.0.0";
(function _initAiChatNewBadge() {
  const badge = document.getElementById("aiChatNewBadge");
  if (!badge) return;
  try {
    chrome.storage.local.get(["aiChatNewSeenVersion"], (items) => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[AutoDOM Popup] AI chat badge storage read failed:",
          chrome.runtime.lastError.message,
        );
        return;
      }
      const seen = items && items.aiChatNewSeenVersion;
      if (seen === AI_CHAT_NEW_VERSION) {
        badge.setAttribute("hidden", "");
      }
    });
  } catch (_) {}
})();
DOM.aiChatBtn.addEventListener("click", async () => {
  // Dismiss the "NEW" badge — user has acknowledged the new features.
  const _badge = document.getElementById("aiChatNewBadge");
  if (_badge && !_badge.hasAttribute("hidden")) {
    _badge.setAttribute("hidden", "");
    try {
      chrome.storage.local.set({ aiChatNewSeenVersion: AI_CHAT_NEW_VERSION });
    } catch (_) {}
  }
  // Always send the toggle request — the service worker and content script
  // will handle connection state. Slash commands work even without MCP bridge.
  // This avoids blocking on stale popup-local isConnected state.
  const response = await sendRuntimeMessage({ type: "TOGGLE_CHAT_PANEL" });
  if (response && response.success) {
    if (response.mcpActive) {
      addLog("AI Chat panel toggled on active tab", "success");
    } else {
      addLog(
        "AI Chat opened (MCP offline — slash commands still work)",
        "info",
      );
    }
    // Close the popup so user can interact with the chat panel
    window.close();
  } else {
    addLog(response?.error || "Failed to toggle AI Chat", "error");
  }
});

async function saveProviderSettings(opts) {
  const { skipTest = false } = opts || {};

  providerSettings = {
    source: DOM.providerSelect?.value || "ide",
    apiKey: DOM.providerApiKey?.value?.trim() || "",
    model: DOM.providerModel?.value?.trim() || "",
    baseUrl: DOM.providerBaseUrl?.value?.trim() || "",
    cliBinary: DOM.providerCliBinary?.value?.trim() || "",
    cliKind: DOM.providerCliKind?.value || "claude",
    cliExtraArgs: DOM.providerCliExtraArgs?.value?.trim() || "",
    enabled: !!DOM.providerEnabledToggle?.checked,
    preset: DOM.providerPreset?.value || "custom",
  };

  // ── Pre-activation gating ─────────────────────────────────
  // If the user wants to enable a direct (network) provider, run a
  // connection test first. On failure, persist settings but flip
  // `enabled` off so the chat panel falls back to IDE / safe mode.
  // Inspired by coding-switch's pre-activation health check pattern.
  let activationDeniedReason = null;
  const isNetworkSource =
    providerSettings.source === "openai" ||
    providerSettings.source === "anthropic" ||
    providerSettings.source === "ollama";

  // Refuse to enable a network provider with an empty model — otherwise the
  // service-worker / server silently falls back to a hardcoded default and
  // the user thinks they're talking to the model they picked.
  if (providerSettings.enabled && isNetworkSource && !providerSettings.model) {
    providerSettings.enabled = false;
    if (DOM.providerEnabledToggle) DOM.providerEnabledToggle.checked = false;
    activationDeniedReason = "model is required";
    addLog(
      `Provider activation denied: pick a model for ${formatProviderLabel(providerSettings.source)}`,
      "error",
    );
  }

  if (!skipTest && providerSettings.enabled && isNetworkSource) {
    updateProviderUI("Testing connection before activating…");
    const test = await runConnectionTest(providerSettings);
    if (!test.ok) {
      providerSettings.enabled = false;
      if (DOM.providerEnabledToggle) DOM.providerEnabledToggle.checked = false;
      activationDeniedReason = test.error || "connection test failed";
      addLog(
        `Provider activation denied: ${activationDeniedReason}`,
        "error",
      );
    } else {
      addLog(
        `Provider connection OK (${test.latencyMs}ms${test.detail ? ` · ${test.detail}` : ""})`,
        "success",
      );
    }
  }

  await chrome.storage.local.set({
    aiProviderSource: providerSettings.source,
    aiProviderModel: providerSettings.model,
    aiProviderBaseUrl: providerSettings.baseUrl,
    aiProviderCliBinary: providerSettings.cliBinary,
    aiProviderCliKind: providerSettings.cliKind,
    aiProviderCliExtraArgs: providerSettings.cliExtraArgs,
    aiProviderEnabled: providerSettings.enabled,
    aiProviderPreset: providerSettings.preset,
  });
  // Persist API key into RAM-only session storage (never written to disk).
  try {
    _secretArea.set({ aiProviderApiKey: providerSettings.apiKey });
    chrome.storage.local.remove("aiProviderApiKey");
  } catch (_) {}

  const response = await sendRuntimeMessage({
    type: "SET_AI_PROVIDER",
    provider: {
      source: providerSettings.source,
      apiKey: providerSettings.apiKey,
      model: providerSettings.model,
      baseUrl: providerSettings.baseUrl,
      cliBinary: providerSettings.cliBinary,
      cliKind: providerSettings.cliKind,
      cliExtraArgs: providerSettings.cliExtraArgs,
      enabled: providerSettings.enabled,
      preset: providerSettings.preset,
    },
  });

  updateProviderUI(
    activationDeniedReason
      ? `✕ Activation denied: ${activationDeniedReason}`
      : undefined,
  );

  if (response?.success) {
    addLog(
      `AI provider saved: ${formatProviderLabel(providerSettings.source)}${providerSettings.enabled ? " · enabled" : ""}`,
      activationDeniedReason ? "warn" : "success",
    );
  } else {
    addLog(response?.error || "Failed to save AI provider settings", "error");
  }
}

// ─── Connection test (popup → SW → provider API) ────────────
// Calls the service worker which performs the actual network ping
// in its own context. Returns { ok, latencyMs, error, detail }.
async function runConnectionTest(settings) {
  try {
    const resp = await sendRuntimeMessage({
      type: "TEST_AI_PROVIDER",
      provider: {
        source: settings.source,
        apiKey: settings.apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
      },
    });
    if (resp && resp.success && resp.ok) {
      return {
        ok: true,
        latencyMs: resp.latencyMs || 0,
        detail: resp.detail || "",
      };
    }
    return {
      ok: false,
      error: (resp && (resp.error || resp.detail)) || "no response",
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function testProviderConnection() {
  if (!DOM.testProviderBtn) return;
  const settings = {
    source: DOM.providerSelect?.value || "ide",
    apiKey: DOM.providerApiKey?.value?.trim() || "",
    model: DOM.providerModel?.value?.trim() || "",
    baseUrl: DOM.providerBaseUrl?.value?.trim() || "",
  };
  if (settings.source === "ide" || settings.source === "cli") {
    updateProviderUI(
      "Test connection only applies to OpenAI / Anthropic / Ollama providers.",
    );
    return;
  }
  if (
    (settings.source === "openai" || settings.source === "anthropic") &&
    !settings.apiKey
  ) {
    updateProviderUI("Enter an API key before testing.");
    return;
  }
  DOM.testProviderBtn.disabled = true;
  updateProviderUI("Testing connection…");
  try {
    const t0 = Date.now();
    const test = await runConnectionTest(settings);
    const elapsed = Date.now() - t0;
    if (test.ok) {
      const latency = test.latencyMs || elapsed;
      const detail = test.detail ? ` · ${test.detail}` : "";
      updateProviderUI(`✓ Connected · ${latency}ms${detail}`);
      addLog(
        `Provider test OK: ${formatProviderLabel(settings.source)} (${latency}ms)`,
        "success",
      );
    } else {
      updateProviderUI(`✕ ${(test.error || "test failed").substring(0, 140)}`);
      addLog(`Provider test failed: ${test.error}`, "error");
    }
  } finally {
    DOM.testProviderBtn.disabled = false;
  }
}

// ─── Preset application ─────────────────────────────────────
// Applies a preset by writing source + baseUrl + model into the form.
// Suppresses field-event handlers so we don't trigger autosave or
// preset-reset partway through. Saves at the end (without test) so
// the user still has to explicitly opt-in by toggling "Enable".
function applyPreset(presetKey) {
  const preset = PROVIDER_PRESETS[presetKey];
  providerSettings.preset = presetKey;
  if (!preset) {
    // "custom" — no field changes, just persist the label
    chrome.storage.local.set({ aiProviderPreset: presetKey });
    updateProviderUI();
    return;
  }
  _suppressFieldEvents = true;
  try {
    if (DOM.providerSelect) DOM.providerSelect.value = preset.source;
    if (DOM.providerBaseUrl) DOM.providerBaseUrl.value = preset.baseUrl || "";
    if (DOM.providerModel) DOM.providerModel.value = preset.model || "";
    providerSettings.source = preset.source;
    providerSettings.baseUrl = preset.baseUrl || "";
    providerSettings.model = preset.model || "";
  } finally {
    _suppressFieldEvents = false;
  }
  updateProviderUI();
  // Persist immediately, but skip the test — user must explicitly enable.
  saveProviderSettings({ skipTest: true });
}

function _resetPresetIfManualEdit() {
  if (!DOM.providerPreset) return;
  const current = DOM.providerPreset.value;
  if (current === "custom") return;
  const preset = PROVIDER_PRESETS[current];
  if (!preset) return;
  const stillMatches =
    DOM.providerSelect?.value === preset.source &&
    (DOM.providerBaseUrl?.value || "") === (preset.baseUrl || "") &&
    (DOM.providerModel?.value || "") === (preset.model || "");
  if (!stillMatches) {
    DOM.providerPreset.value = "custom";
    providerSettings.preset = "custom";
  }
}

// ─── CLI presence check ─────────────────────────────────────
// Asks the bridge to spawn `<binary> --version` (short timeout) so the
// user can verify the chosen CLI is installed and reachable on PATH
// before sending real chat messages. Requires the MCP bridge to be
// connected (CLI execution itself happens server-side).
async function installDefaultCliPackage() {
  const kind = DOM.providerCliKind?.value || "claude";
  const info = getCliKindInfo(kind);
  if (!info.npmPackage || !info.binary) {
    updateProviderUI(
      "Custom CLI has no default npm package — install it manually and enter the binary.",
    );
    return;
  }

  const installCommand = info.install || `npm install -g ${info.npmPackage}`;
  const approved = window.confirm(
    `Install ${info.label}?\n\nThis will run on the local AutoDOM bridge host:\n${installCommand}\n\nContinue?`,
  );
  if (!approved) {
    updateProviderUI("CLI install cancelled.");
    return;
  }

  if (DOM.providerCliBinary && !DOM.providerCliBinary.value.trim()) {
    DOM.providerCliBinary.value = info.binary;
  }
  await saveProviderSettings({ skipTest: true });

  if (DOM.cliPromptInstallBtn) DOM.cliPromptInstallBtn.disabled = true;
  if (DOM.checkCliBtn) DOM.checkCliBtn.disabled = true;
  DOM.providerStatus.textContent = `Installing ${info.label} with npm…`;
  addLog(`Installing ${info.label}: ${installCommand}`, "info");

  try {
    const response = await sendRuntimeMessage({
      type: "INSTALL_CLI_PACKAGE",
      kind,
      binary: info.binary,
      npmPackage: info.npmPackage,
    });
    if (response?.ok) {
      DOM.providerStatus.textContent = `✓ Installed ${info.label}. Checking CLI…`;
      addLog(`Installed ${info.label}: ${installCommand}`, "success");
      await checkCliBinary();
    } else {
      const err = response?.error || "CLI install failed";
      DOM.providerStatus.textContent = `✕ ${err.substring(0, 120)}`;
      addLog(`CLI install failed: ${err}`, "error");
    }
  } catch (err) {
    DOM.providerStatus.textContent = `✕ ${err.message || err}`;
    addLog(`CLI install error: ${err.message || err}`, "error");
  } finally {
    if (DOM.cliPromptInstallBtn) DOM.cliPromptInstallBtn.disabled = false;
    if (DOM.checkCliBtn) DOM.checkCliBtn.disabled = false;
  }
}

async function checkCliBinary() {
  if (!DOM.checkCliBtn) return;
  const binary = (DOM.providerCliBinary?.value || "").trim();
  const kind = DOM.providerCliKind?.value || "claude";
  const info = getCliKindInfo(kind);
  if (!binary) {
    DOM.providerStatus.textContent = "Set a CLI binary first (e.g. claude).";
    return;
  }
  DOM.checkCliBtn.disabled = true;
  DOM.providerStatus.textContent = `Checking '${binary}'…`;
  try {
    const response = await sendRuntimeMessage({
      type: "CHECK_CLI_BINARY",
      binary,
      kind,
    });
    if (response?.ok) {
      const ver = (response.version || "").trim().split(/\r?\n/)[0] || "ok";
      DOM.providerStatus.textContent = `✓ ${kind} CLI ready · ${ver.substring(0, 80)}`;
      addLog(`CLI ready: ${binary} (${ver.substring(0, 60)})`, "success");
    } else {
      const err = response?.error || "CLI check failed";
      const installHint =
        response?.installCommand || (response?.notFound ? info.install : "");
      DOM.providerStatus.textContent = `✕ ${err.substring(0, 100)}${
        installHint ? " Use Install with npm below." : ""
      }`;
      addLog(
        `CLI check failed: ${err}${installHint ? ` · ${installHint}` : ""}`,
        "error",
      );
      renderCliPrompt();
    }
  } catch (err) {
    DOM.providerStatus.textContent = `✕ ${err.message || err}`;
    addLog(`CLI check error: ${err.message || err}`, "error");
  } finally {
    DOM.checkCliBtn.disabled = false;
  }
}

DOM.connectBtn.addEventListener("click", async () => {
  const port = parseInt(DOM.portInput.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    addLog("Invalid port. Must be 1024–65535.", "error");
    return;
  }

  await chrome.storage.local.set({ mcpPort: port });
  const stored = await readLocalStorage(["serverPath"], "server path");
  generateConfigs(port, stored.serverPath || null);

  if (!isRunning) {
    addLog(`Connecting to ws://127.0.0.1:${port}...`, "info");
    isRunning = true;
    isConnected = false;
    updateUI();

    const response = await sendRuntimeMessage({ type: "START_MCP", port });
    if (!response || !response.success) {
      isRunning = false;
      isConnected = false;
      updateUI();
      addLog(response?.error || "Could not start MCP.", "error");
      return;
    }
    if (response.connected) {
      isConnected = true;
      updateUI();
      addLog("MCP connection established!", "success");
    } else {
      addLog("MCP start requested.", "info");
    }
  } else {
    addLog("Stopping MCP...", "info");
    isRunning = false;
    isConnected = false;
    updateUI();

    const response = await sendRuntimeMessage({ type: "STOP_MCP" });
    if (response?.error) {
      addLog(`Failed to stop MCP: ${response.error}`, "error");
    } else {
      addLog("MCP stopped.", "warn");
    }
  }
});

DOM.logClear.addEventListener("click", () => {
  activityStorage.set({ [ACTIVITY_LOG_KEY]: [] }).catch(() => {});
  activityLogs = [];
  renderActivityLogs([]);
});

// ─── Guardrails Event Listeners ──────────────────────────────
function sendRateLimitConfig(enabled) {
  sendRuntimeMessage({
    type: "UPDATE_GUARDRAILS",
    rateLimitConfig: {
      enabled,
      maxCallsPerDomain: parseInt(DOM.rateLimitMax?.value || "100", 10),
      windowMs: parseInt(DOM.rateLimitWindow?.value || "60000", 10),
    },
  });
}

if (DOM.rateLimitToggle) {
  DOM.rateLimitToggle.addEventListener("change", () => {
    const enabled = DOM.rateLimitToggle.checked;
    if (DOM.rateLimitSettings)
      DOM.rateLimitSettings.style.display = enabled ? "block" : "none";
    sendRateLimitConfig(enabled);
  });
}

if (DOM.rateLimitMax) {
  DOM.rateLimitMax.addEventListener("change", () => {
    if (DOM.rateLimitToggle?.checked) sendRateLimitConfig(true);
  });
}

if (DOM.rateLimitWindow) {
  DOM.rateLimitWindow.addEventListener("change", () => {
    if (DOM.rateLimitToggle?.checked) sendRateLimitConfig(true);
  });
}

if (DOM.confirmSubmitToggle) {
  DOM.confirmSubmitToggle.addEventListener("change", () => {
    sendRuntimeMessage({
      type: "UPDATE_GUARDRAILS",
      confirmBeforeSubmit: DOM.confirmSubmitToggle.checked,
    });
  });
}

// ─── Local Automation Script Runner ─────────────────────────

function getScriptRequestPayload() {
  const backend = DOM.scriptBackend?.value || "browser-extension";
  const source = DOM.scriptSource?.value || "";
  const timeoutMs = Math.max(
    1000,
    parseInt(DOM.scriptTimeout?.value || "15000", 10) || 15000,
  );
  return {
    backend,
    source,
    timeoutMs,
    params: {},
  };
}

function setScriptStatus(text, level = "info") {
  if (!DOM.scriptStatus) return;
  DOM.scriptStatus.textContent = text;
  DOM.scriptStatus.dataset.level = level;
}

function renderScriptOutput(result) {
  if (!DOM.scriptOutput) return;
  DOM.scriptOutput.textContent =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

async function validateScriptSource() {
  const { backend, source } = getScriptRequestPayload();
  if (!source.trim()) {
    return { ok: false, error: "Choose a local file or paste script source." };
  }
  return await sendRuntimeMessage({
    type: "VALIDATE_AUTOMATION_SCRIPT",
    params: getScriptRequestPayload(),
  });
}

function initScriptRunner() {
  if (!DOM.scriptBackend || !DOM.scriptSource) return;

  DOM.scriptFile?.addEventListener("change", async () => {
    const file = DOM.scriptFile.files && DOM.scriptFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      DOM.scriptSource.value = text;
      setScriptStatus(`Loaded ${file.name} (${text.length} chars).`, "success");
      addLog(`Loaded automation script: ${file.name}`, "success");
    } catch (err) {
      setScriptStatus(`Failed to read file: ${err.message}`, "error");
      addLog(`Script file read failed: ${err.message}`, "error");
    }
  });

  DOM.validateScriptBtn?.addEventListener("click", async () => {
    const result = await validateScriptSource();
    if (result.ok) {
      setScriptStatus(`Validation OK · ${result.backend}`, "success");
      addLog(`Automation script validated (${result.backend})`, "success");
    } else {
      setScriptStatus(result.error, "error");
      addLog(`Automation validation failed: ${result.error}`, "error");
    }
    renderScriptOutput(result);
  });

  DOM.runScriptBtn?.addEventListener("click", async () => {
    const validation = await validateScriptSource();
    if (!validation.ok) {
      setScriptStatus(validation.error, "error");
      renderScriptOutput(validation);
      return;
    }

    const payload = getScriptRequestPayload();
    DOM.runScriptBtn.disabled = true;
    DOM.validateScriptBtn.disabled = true;
    setScriptStatus(`Running ${payload.backend} script...`, "info");
    renderScriptOutput("Running...");
    try {
      const result = await sendRuntimeMessage({
        type: "RUN_AUTOMATION_SCRIPT",
        params: payload,
      });
      renderScriptOutput(result);
      if (result?.ok || result?.success) {
        setScriptStatus(
          `Completed in ${result.elapsedMs || 0}ms · ${payload.backend}`,
          "success",
        );
        addLog(`Automation completed (${payload.backend})`, "success");
      } else {
        const err = result?.error || "Automation failed";
        setScriptStatus(err.substring(0, 160), "error");
        addLog(`Automation failed: ${err}`, "error");
      }
    } catch (err) {
      setScriptStatus(err.message || String(err), "error");
      renderScriptOutput({ ok: false, error: err.message || String(err) });
    } finally {
      DOM.runScriptBtn.disabled = false;
      DOM.validateScriptBtn.disabled = false;
    }
  });

  DOM.clearScriptOutputBtn?.addEventListener("click", () => {
    renderScriptOutput("No script run yet.");
    setScriptStatus(
      "Browser extension scripts run in the active tab. Playwright/Node scripts run locally through MCP.",
      "info",
    );
  });
}

// Listen for status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") {
    isRunning = !!message.running;
    isConnected = !!message.connected;
    updateUI();
    if (message.log) {
      addLog(message.log, message.logLevel || "info");
    }
  }
  if (message.type === "TOOL_CALLED") {
    addLog(`Tool: ${message.tool}`, "success");
  }
  if (message.type === "AI_PROVIDER_STATUS") {
    if (message.provider) {
      providerSettings = {
        ...providerSettings,
        source: message.provider.source || providerSettings.source || "ide",
        apiKey: message.provider.apiKey || providerSettings.apiKey || "",
        model: message.provider.model || providerSettings.model || "",
      };
      if (DOM.providerSelect)
        DOM.providerSelect.value = providerSettings.source;
      if (DOM.providerModel)
        DOM.providerModel.value = providerSettings.model || "";
    }
    // Ignore service-worker statusText — popup recomputes it locally
    // using the active preset (e.g. "DeepSeek" instead of "GPT").
    updateProviderUI();
  }
});

// ─── UI Helpers ──────────────────────────────────────────────
function updateUI() {
  if (isRunning) {
    DOM.connectBtn.style.color = "#ef4444";
    $("#connectBtnText").textContent = "Stop MCP";
    DOM.statusCard.className = isConnected
      ? "status-card connected"
      : "status-card";
    DOM.statusLabel.textContent = isConnected ? "Connected" : "Connecting";
    DOM.statusDetail.textContent = isConnected
      ? `Bridge server on ws://127.0.0.1:${DOM.portInput.value}`
      : `Trying ws://127.0.0.1:${DOM.portInput.value}`;
    DOM.portInput.disabled = true;
  } else {
    DOM.connectBtn.style.color = "";
    $("#connectBtnText").textContent = "Connect";
    DOM.statusCard.className = "status-card";
    DOM.statusLabel.textContent = "Waiting";
    DOM.statusDetail.textContent =
      "Click Connect or enable auto-connect to start the bridge";
    DOM.portInput.disabled = false;
  }

  updateProviderUI();
}

function formatProviderLabel(source) {
  // Prefer the human-readable preset label when one is active — e.g.
  // a DeepSeek preset (source=openai) should display as "DeepSeek",
  // not "GPT".
  const presetKey = providerSettings.preset || "custom";
  if (presetKey && presetKey !== "custom") {
    const presetLabels = {
      "openai-official": "OpenAI",
      "anthropic-official": "Anthropic Claude",
      "ollama-local": "Ollama",
      deepseek: "DeepSeek",
      zhipu: "Zhipu GLM",
      moonshot: "Kimi (Moonshot)",
      qianfan: "Baidu Qianfan",
      dashscope: "Alibaba DashScope",
    };
    if (presetLabels[presetKey]) return presetLabels[presetKey];
  }
  switch (source) {
    case "openai":
      return "OpenAI-compatible";
    case "anthropic":
      return "Anthropic";
    case "ollama":
      return "Ollama";
    case "cli":
      return "Local CLI";
    default:
      return "IDE Agent";
  }
}

// Helper: show/hide a field row. If the element sits inside a
// `.field-group` wrapper (label + input together), toggle the wrapper so
// the orphan label doesn't linger when its input is hidden.
function _setFieldVisible(el, visible) {
  if (!el) return;
  const target = el.closest(".field-group") || el;
  target.style.display = visible ? "" : "none";
}

// Renders the inline CLI install/help prompt under the Local CLI inputs.
// Visible only when source === "cli". Surfaces the default binary name
// for the chosen kind, the install command, and a docs link so a new
// user can get to a working state without leaving the popup.
function renderCliPrompt() {
  if (!DOM.cliPromptBox) return;
  const source = providerSettings.source || "ide";
  if (source !== "cli") {
    DOM.cliPromptBox.style.display = "none";
    return;
  }
  const kind = DOM.providerCliKind?.value || providerSettings.cliKind || "claude";
  const info = getCliKindInfo(kind);
  const currentBinary = (DOM.providerCliBinary?.value || "").trim();
  const isDefaultBinary = !!info.binary && currentBinary === info.binary;

  // If the user supplied a custom binary/path, the default npm package prompt
  // may be misleading. Keep it visible for empty/default binaries so missing
  // npm-installed CLIs are still discoverable from the settings UI.
  if (currentBinary && !isDefaultBinary) {
    DOM.cliPromptBox.style.display = "none";
    return;
  }

  DOM.cliPromptBox.style.display = "";
  if (DOM.cliPromptText) {
    const base = info.binary
      ? currentBinary
        ? `${info.label} is set to default binary '${info.binary}'. If it is missing on PATH, install its npm package:`
        : `${info.label} not configured. Default binary: '${info.binary}'. Install it with npm or use the default binary:`
      : `${info.label} selected — enter the binary name or absolute path above.`;
    DOM.cliPromptText.textContent = info.authHint
      ? `${base}\nAuth: ${info.authHint}`
      : base;
  }
  if (DOM.cliPromptInstall) {
    DOM.cliPromptInstall.textContent = info.install;
    DOM.cliPromptInstall.style.display = info.install ? "" : "none";
  }
  if (DOM.cliPromptUseDefault) {
    DOM.cliPromptUseDefault.style.display =
      info.binary && currentBinary !== info.binary ? "" : "none";
  }
  if (DOM.cliPromptInstallBtn) {
    DOM.cliPromptInstallBtn.style.display =
      info.npmPackage && info.binary ? "" : "none";
  }
  if (DOM.cliPromptDocsBtn) {
    DOM.cliPromptDocsBtn.style.display = info.docsUrl ? "" : "none";
  }
}

function _normalizedProviderBaseUrl(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

function _isBareOllamaBaseUrl(url) {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):11434$/.test(
    _normalizedProviderBaseUrl(url),
  );
}

function _modelLooksCompatibleWithProvider(model, source, baseUrl, cliKind = "") {
  const id = String(model || "").trim();
  if (!id) return false;
  const d = id.toLowerCase();
  const s = (source || "").toLowerCase();
  const base = _normalizedProviderBaseUrl(baseUrl);
  const cli = (cliKind || "").toLowerCase();

  if (s === "anthropic") return d.startsWith("claude");
  if (s === "openai") {
    if (!base || /api\.openai\.com/.test(base) || _isBareOllamaBaseUrl(base)) {
      return /^(gpt|o\d|text-|chatgpt)/.test(d);
    }
    if (/deepseek/.test(base)) return d.startsWith("deepseek");
    if (/bigmodel|zhipu/.test(base)) return d.startsWith("glm");
    if (/moonshot|kimi/.test(base)) return /^(moonshot|kimi)/.test(d);
    if (/qianfan|baidubce/.test(base)) return /^(ernie|qianfan)/.test(d);
    if (/dashscope|aliyuncs/.test(base)) return /^(qwen|qwq)/.test(d);
    return true;
  }
  if (s === "ollama") {
    return !d.startsWith("claude") && !/^(gpt-(?:3|4|5)|o\d|chatgpt|text-)/.test(d);
  }
  if (s === "cli") {
    if (cli === "claude") return d.startsWith("claude");
    if (cli === "codex") return /^(gpt|o\d)/.test(d) || d === "codex-mini-latest";
    if (cli === "copilot") return /^(gpt|claude)/.test(d);
    return false;
  }
  if (s === "ide") return false;
  return true;
}

function _defaultModelForProvider(source, baseUrl, cliKind = "") {
  const s = (source || "").toLowerCase();
  const base = _normalizedProviderBaseUrl(baseUrl);
  const cli = (cliKind || "").toLowerCase();
  if (s === "anthropic") return "claude-3-7-sonnet-latest";
  if (s === "ollama") return "llama3.2";
  if (s === "cli" || s === "ide") {
    // Don't hardcode a model for CLI providers — let the locally-installed
    // CLI use whatever it's configured with (its own default / login).
    return "";
  }
  if (s !== "openai") return "";
  if (/deepseek/.test(base)) return "deepseek-chat";
  if (/bigmodel|zhipu/.test(base)) return "glm-4-plus";
  if (/moonshot|kimi/.test(base)) return "moonshot-v1-8k";
  if (/qianfan|baidubce/.test(base)) return "ernie-4.0-8k";
  if (/dashscope|aliyuncs/.test(base)) return "qwen-turbo";
  return "gpt-4.1";
}

function updateProviderUI(statusOverride) {
  if (!DOM.providerStatus) return;

  const source = providerSettings.source || "ide";
  const label = formatProviderLabel(source);
  const isCli = source === "cli";

  // Surface the active provider as a compact badge in the panel header
  // so the user can tell at a glance which path is wired up.
  const badge = document.getElementById("providerBadge");
  if (badge) badge.textContent = label;

  // ─── Field visibility per provider ─────────────────────
  // CLI mode hides model/apiKey/baseUrl (irrelevant) and shows CLI inputs.
  _setFieldVisible(DOM.providerModel, !isCli);
  _setFieldVisible(DOM.providerApiKey, !isCli);
  _setFieldVisible(DOM.providerBaseUrl, !isCli);
  _setFieldVisible(DOM.providerCliKind, isCli);
  _setFieldVisible(DOM.providerCliBinary, isCli);
  _setFieldVisible(DOM.providerCliExtraArgs, isCli);
  // The protocol/source dropdown is redundant when a non-custom preset
  // is active — the preset already determines the underlying API
  // protocol. Hide it to avoid confusing labels (e.g. "OpenAI-compatible
  // API" showing for a DeepSeek preset).
  const presetKey = providerSettings.preset || "custom";
  _setFieldVisible(DOM.providerSelect, presetKey === "custom");
  // The "Enable direct provider" checkbox is meaningless for IDE/CLI
  if (DOM.providerEnabledToggle?.parentElement) {
    DOM.providerEnabledToggle.parentElement.style.display =
      source === "ide" || isCli ? "none" : "";
  }

  if (DOM.providerApiKey) {
    DOM.providerApiKey.disabled = source === "ide" || source === "ollama";
    const friendly = formatProviderLabel(source);
    DOM.providerApiKey.placeholder =
      source === "openai"
        ? `${friendly} API key`
        : source === "anthropic"
          ? `${friendly} API key`
          : source === "ollama"
            ? "Not required for local Ollama"
            : "Not required for IDE Agent mode";
  }

  if (DOM.providerModel) {
    DOM.providerModel.disabled = source === "ide";
    const baseUrl = DOM.providerBaseUrl?.value || providerSettings.baseUrl || "";
    const cliKind = DOM.providerCliKind?.value || providerSettings.cliKind || "";
    const currentModel = (DOM.providerModel.value || providerSettings.model || "").trim();
    const fallbackModel = _defaultModelForProvider(source, baseUrl, cliKind);
    const isCliLike = source === "cli" || source === "ide";
    // For CLI providers we never auto-fill a model — the locally-installed
    // CLI owns that choice. The field is only respected when the user
    // explicitly types something to override.
    const nextModel = isCliLike
      ? currentModel
      : !currentModel
        ? fallbackModel
        : _modelLooksCompatibleWithProvider(currentModel, source, baseUrl, cliKind)
          ? currentModel
          : fallbackModel;
    if (DOM.providerModel.value !== nextModel) {
      DOM.providerModel.value = nextModel;
    }
    if (isCliLike) {
      DOM.providerModel.placeholder = "Leave blank to use the CLI's configured default";
    }
    providerSettings.model = nextModel;
  }

  if (DOM.providerBaseUrl) {
    DOM.providerBaseUrl.disabled = source === "ide";
    if (!DOM.providerBaseUrl.value && source === "ollama") {
      DOM.providerBaseUrl.value = "http://localhost:11434";
    }
  }

  // Sensible defaults for CLI inputs the first time the user picks "cli"
  if (isCli && DOM.providerCliBinary && !DOM.providerCliBinary.value) {
    const kindKey = DOM.providerCliKind?.value || providerSettings.cliKind || "claude";
    const info = getCliKindInfo(kindKey);
    DOM.providerCliBinary.value =
      providerSettings.cliBinary || info.binary || "";
  }

  // "Check CLI" button is only useful in CLI mode
  _setFieldVisible(DOM.checkCliBtn, isCli);

  // Render the inline CLI install/help prompt (no-op for non-CLI sources)
  renderCliPrompt();

  if (statusOverride) {
    DOM.providerStatus.textContent = statusOverride;
    return;
  }

  if (source === "ide") {
    DOM.providerStatus.textContent = isConnected
      ? "Using IDE Agent over MCP"
      : "IDE Agent selected — connect MCP to enable full AI";
    return;
  }

  if (isCli) {
    const bin = (providerSettings.cliBinary || "").trim();
    const kind = providerSettings.cliKind || "claude";
    DOM.providerStatus.textContent = bin
      ? `Local ${kind} CLI · ${bin} (click "Check CLI" to verify)`
      : `Local CLI selected — set the binary (e.g. claude or codex)`;
    return;
  }

  const hasApiKey = !!(providerSettings.apiKey || "").trim();
  const model = (providerSettings.model || "").trim();
  if (source === "ollama") {
    DOM.providerStatus.textContent = model
      ? `Ollama ready · ${model}`
      : "Ollama selected · default model: llama3.2";
  } else {
    DOM.providerStatus.textContent = hasApiKey
      ? `${label} ready${model ? ` · ${model}` : ""}`
      : `${label} selected — add API key to enable direct AI`;
  }
}

const tabSelect = $("#tabSelect");
const refreshTabsBtn = $("#refreshTabsBtn");

async function refreshTabInfo() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const activeTab = tabs.find((t) => t.active);

    // Update URL display
    if (activeTab) {
      DOM.tabUrl.textContent = activeTab.url || "—";
    } else {
      DOM.tabUrl.textContent = "—";
    }

    // Populate dropdown
    tabSelect.innerHTML = "";
    tabs.forEach((tab) => {
      const option = document.createElement("option");
      option.value = tab.id;
      option.textContent = `${tab.title || "(Untitled)"}`;
      if (tab.active) {
        option.selected = true;
      }
      tabSelect.appendChild(option);
    });
  } catch (e) {
    DOM.tabUrl.textContent = "—";
    tabSelect.innerHTML = '<option value="">Error loading tabs</option>';
  }
}

// Listen for dropdown changes to switch the active tab
tabSelect.addEventListener("change", async (e) => {
  const tabId = parseInt(e.target.value, 10);
  if (!isNaN(tabId)) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      addLog(`Switched focus to tab ${tabId}`, "info");
      refreshTabInfo();
    } catch (err) {
      addLog(`Failed to switch tab: ${err.message}`, "error");
    }
  }
});

// Refresh button reloads the tab list
refreshTabsBtn.addEventListener("click", () => {
  refreshTabInfo();
  addLog("Refreshed tab list", "info");
});

function addLog(text, level = "info") {
  appendActivityLog(level, text, "popup");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function appendActivityLog(level, text, source = "popup") {
  const entry = {
    ts: Date.now(),
    level: level || "info",
    source,
    text: String(text || ""),
  };
  activityStorage.get([ACTIVITY_LOG_KEY], (result) => {
    const logs = Array.isArray(result?.[ACTIVITY_LOG_KEY])
      ? result[ACTIVITY_LOG_KEY]
      : [];
    logs.push(entry);
    if (logs.length > 250) {
      logs.splice(0, logs.length - 250);
    }
    activityStorage.set({ [ACTIVITY_LOG_KEY]: logs }).catch(() => {});
  });
}

function renderActivityLogs(entries) {
  if (!DOM.logContainer) return;
  const logs = filterActivityLogs(
    Array.isArray(entries) ? entries : [],
    activityFilter,
  );
  DOM.logContainer.innerHTML = "";
  if (logs.length === 0) {
    const emptyMessage =
      activityFilter === "all"
        ? "No activity yet."
        : "No matching activity yet.";
    DOM.logContainer.innerHTML = `<div class="log-entry log-info">${emptyMessage}</div>`;
    return;
  }
  for (const item of logs) {
    const entry = document.createElement("div");
    entry.className = `log-entry log-${item.level || "info"}`;
    const now = new Date(item.ts || Date.now());
    const time = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const source =
      item.source && item.source !== "popup" ? `[${item.source}] ` : "";
    entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(source + (item.text || ""))}`;
    DOM.logContainer.appendChild(entry);
  }
  DOM.logContainer.scrollTop = DOM.logContainer.scrollHeight;
}

function filterActivityLogs(entries, filter) {
  if (!Array.isArray(entries) || filter === "all") {
    return Array.isArray(entries) ? entries : [];
  }

  return entries.filter((item) => (item?.level || "info") === filter);
}

// ─── Tool Error Logs Tab ─────────────────────────────────────

let _toolLogs = { extensionLogs: [], serverLogs: [], logFile: null };

function renderToolLogs() {
  const container = $("#toolLogContainer");
  if (!container) return;

  const sourceFilter = $("#logSourceFilter")?.value || "all";
  let entries = [];

  if (sourceFilter !== "server") {
    (_toolLogs.extensionLogs || []).forEach((e) =>
      entries.push({ ...e, source: "extension" }),
    );
  }
  if (sourceFilter !== "extension") {
    (_toolLogs.serverLogs || []).forEach((e) =>
      entries.push({ ...e, source: "server" }),
    );
  }

  entries.sort((a, b) => (a.ts > b.ts ? 1 : -1));

  if (entries.length === 0) {
    container.innerHTML =
      '<div class="log-entry log-info">No tool errors recorded.</div>';
    return;
  }

  container.innerHTML = entries
    .map((e) => {
      const time = e.ts ? e.ts.slice(11, 19) : "";
      const badge = e.source === "server" ? "[server]" : "[ext]";
      return `<div class="log-entry log-error"><span class="log-time">${escapeHtml(time)}</span> <span class="log-badge">${badge}</span> <strong>${escapeHtml(e.tool || "?")}</strong>: ${escapeHtml(e.error || "")}${e.extra ? " · " + escapeHtml(String(e.extra)) : ""}</div>`;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

async function fetchToolLogs() {
  const btn = $("#fetchLogsBtn");
  if (btn) btn.textContent = "Loading…";

  try {
    const response = await sendRuntimeMessage({ type: "GET_TOOL_LOGS" });
    if (response) {
      _toolLogs = {
        extensionLogs: response.extensionLogs || [],
        serverLogs: response.serverLogs || [],
        logFile: response.logFile || null,
      };
    }
  } catch (e) {
    _toolLogs = { extensionLogs: [], serverLogs: [], logFile: null };
  }

  const hint = $("#logFilePath");
  if (hint) {
    hint.textContent = _toolLogs.logFile
      ? `Server log file: ${_toolLogs.logFile}`
      : "";
  }

  renderToolLogs();
  if (btn) btn.textContent = "Refresh";
}

function initToolLogsTab() {
  const fetchBtn = $("#fetchLogsBtn");
  if (fetchBtn) fetchBtn.addEventListener("click", fetchToolLogs);

  const clearBtn = $("#clearToolLogsBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      // Optimistic local clear so the UI feels instant.
      _toolLogs = { extensionLogs: [], serverLogs: [], logFile: _toolLogs.logFile };
      renderToolLogs();
      try {
        await sendRuntimeMessage({ type: "CLEAR_TOOL_LOGS" });
      } catch (_) {}
      // Re-render in case the server ack updated logFile, and to mask
      // any in-flight response that arrived between optimistic clear and
      // server ack.
      _toolLogs = { extensionLogs: [], serverLogs: [], logFile: _toolLogs.logFile };
      renderToolLogs();
    });
  }

  const sourceFilter = $("#logSourceFilter");
  if (sourceFilter) sourceFilter.addEventListener("change", renderToolLogs);

  // Auto-load when tab becomes active
  document.addEventListener(TAB_ACTIVATED_EVENT, (event) => {
    if (event.detail?.tab === "logs") fetchToolLogs();
  });
}

initToolLogsTab();

// ─── Security tab (Ask Before Act) ───────────────────────────
function initSecurityTab() {
  const enabled = $("#gateEnabledToggle");
  const silent = $("#gateSilentReadsToggle");
  const permTable = $("#permTable");
  const auditContainer = $("#auditContainer");
  const refreshPerms = $("#refreshPermsBtn");
  const clearPerms = $("#clearPermsBtn");
  const refreshAudit = $("#refreshAuditBtn");
  const clearAudit = $("#clearAuditBtn");
  if (!enabled || !silent || !permTable || !auditContainer) return;

  async function loadState() {
    const resp = await sendRuntimeMessage({ type: "ACTION_GATE_GET_STATE" });
    if (!resp?.ok) {
      permTable.innerHTML = `<div class="log-entry log-error">Failed to load: ${resp?.error || "unknown"}</div>`;
      return;
    }
    enabled.checked = !!resp.settings?.enabled;
    silent.checked = !!resp.settings?.silentReads;
    renderPermissions(resp.permissions || {});
    renderAudit(resp.audit || []);
  }

  function renderPermissions(perms) {
    const origins = Object.keys(perms);
    if (!origins.length) {
      permTable.innerHTML =
        '<div class="log-entry log-info">No per-site permissions saved yet.</div>';
      return;
    }
    permTable.innerHTML = "";
    origins.sort().forEach((origin) => {
      const row = document.createElement("div");
      row.className = "perm-row";
      const left = document.createElement("div");
      const o = document.createElement("div");
      o.className = "perm-origin";
      o.textContent = origin;
      const cats = document.createElement("div");
      cats.className = "perm-cats";
      const pairs = Object.entries(perms[origin]?.categories || {})
        .map(([k, v]) => `${k}:${v}`)
        .join("  ");
      cats.textContent = pairs || "no rules";
      left.appendChild(o);
      left.appendChild(cats);
      const btn = document.createElement("button");
      btn.className = "perm-revoke";
      btn.textContent = "Revoke";
      btn.addEventListener("click", async () => {
        await sendRuntimeMessage({ type: "ACTION_GATE_REVOKE_ORIGIN", origin });
        loadState();
      });
      row.appendChild(left);
      row.appendChild(btn);
      permTable.appendChild(row);
    });
  }

  function renderAudit(entries) {
    if (!entries.length) {
      auditContainer.innerHTML =
        '<div class="log-entry log-info">No audited actions yet.</div>';
      return;
    }
    auditContainer.innerHTML = "";
    // Newest first
    entries
      .slice()
      .reverse()
      .forEach((e) => {
        const row = document.createElement("div");
        row.className = "audit-row";
        const ts = new Date(e.t || Date.now()).toLocaleTimeString();
        const cls = e.decision?.startsWith("allow")
          ? "audit-decision-allow"
          : "audit-decision-deny";
        row.innerHTML =
          `<span>${ts}</span>` +
          `<span class="${cls}">${escapeHtml(e.decision || "?")}</span>` +
          `<span>${escapeHtml(e.category || "?")}</span>` +
          `<span>${escapeHtml(e.toolName || "?")}</span>` +
          `<span style="flex:1;color:var(--text-muted)">${escapeHtml(e.origin || "")}</span>`;
        auditContainer.appendChild(row);
      });
  }

  enabled.addEventListener("change", () =>
    sendRuntimeMessage({
      type: "ACTION_GATE_UPDATE_SETTINGS",
      patch: { enabled: enabled.checked },
    }),
  );
  silent.addEventListener("change", () =>
    sendRuntimeMessage({
      type: "ACTION_GATE_UPDATE_SETTINGS",
      patch: { silentReads: silent.checked },
    }),
  );
  refreshPerms?.addEventListener("click", loadState);
  refreshAudit?.addEventListener("click", loadState);
  clearPerms?.addEventListener("click", async () => {
    await sendRuntimeMessage({ type: "ACTION_GATE_CLEAR_PERMISSIONS" });
    loadState();
  });
  clearAudit?.addEventListener("click", async () => {
    await sendRuntimeMessage({ type: "ACTION_GATE_CLEAR_AUDIT" });
    loadState();
  });

  // Refresh whenever the user actually opens the tab.
  document.addEventListener(TAB_ACTIVATED_EVENT, (event) => {
    if (event.detail?.tab === "security") loadState();
  });

  loadState();
}
