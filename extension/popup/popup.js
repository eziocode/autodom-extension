/**
 * AutoDOM — Popup Controller
 * Manages the popup UI — Status tab + Config tab.
 * Lets the user connect to the MCP server and opt into auto-connect.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
  appVersion: $("#appVersion"),
  actionBtn: $("#actionBtn"),
  actionBtnText: $("#actionBtnText"),
  portInput: $("#portInput"),
  statusCard: $("#statusCard"),
  statusLabel: $("#statusLabel"),
  statusDetail: $("#statusDetail"),
  tabUrl: $("#tabUrl"),
  logContainer: $("#logContainer"),
  logFilter: $("#logFilter"),
  logClear: $("#logClear"),
  connectBtn: $("#connectBtn"),
  autoConnectToggle: $("#autoConnectToggle"),
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
    install: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
  },
  codex: {
    label: "Codex CLI",
    binary: "codex",
    install: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex",
  },
  copilot: {
    label: "GitHub Copilot CLI",
    binary: "copilot",
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

// API keys live in chrome.storage.session (RAM-only). Falls back to local
// on browsers that don't yet expose `session` storage.
const _secretArea = (chrome.storage && chrome.storage.session) || chrome.storage.local;
const _secretAreaName =
  chrome.storage && chrome.storage.session && _secretArea === chrome.storage.session
    ? "session"
    : "local";

  // Load saved port, server path, auto-connect preference, and provider settings
  const stored = await chrome.storage.local.get([
    "mcpPort",
    "serverPath",
    "autoConnect",
    "aiProviderSource",
    "aiProviderApiKey",
    "aiProviderModel",
    "aiProviderBaseUrl",
    "aiProviderCliBinary",
    "aiProviderCliKind",
    "aiProviderCliExtraArgs",
    "aiProviderEnabled",
    "aiProviderPreset",
  ]);
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

  DOM.portInput.value = port;
  DOM.autoConnectToggle.checked = autoConnect;
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

  const storedUiState = await chrome.storage.local.get([ACTIVITY_FILTER_KEY]);
  activityFilter = storedUiState[ACTIVITY_FILTER_KEY] || "all";
  if (DOM.logFilter) DOM.logFilter.value = activityFilter;
  renderActivityLogs(activityLogs);

  // Load guardrails settings
  const guardrails = await chrome.storage.local.get([
    "rateLimitConfig",
    "confirmBeforeSubmitConfig",
  ]);
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
    const s = await chrome.storage.local.get(["serverPath"]);
    generateConfigs(
      parseInt(DOM.portInput.value, 10) || 9876,
      s.serverPath || null,
    );
  });

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

  // Listen for path/provider updates (both local and session areas)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (changes.serverPath) {
      generateConfigs(
        parseInt(DOM.portInput.value, 10) || 9876,
        changes.serverPath.newValue,
      );
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
      const info = CLI_KIND_INFO[kind] || CLI_KIND_INFO.claude;
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
      const info = CLI_KIND_INFO[kind] || CLI_KIND_INFO.claude;
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

  if (DOM.cliPromptDocsBtn) {
    DOM.cliPromptDocsBtn.addEventListener("click", () => {
      const kind = DOM.providerCliKind?.value || "claude";
      const info = CLI_KIND_INFO[kind] || CLI_KIND_INFO.claude;
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
});

// ─── Chat panel settings (mirrors __autodom_chat_settings used by chat-panel.js) ───
// chat-panel.js owns the storage shape; we only touch the two boolean
// fields that map to UI toggles here. A storage.onChanged listener
// keeps the popup in sync if the user flips the same toggle from
// another window/tab.
function initChatSettingsTab() {
  const STORAGE_KEY = "__autodom_chat_settings";
  const verboseToggle = document.getElementById("chatVerboseToggle");
  const persistToggle = document.getElementById("chatPersistToggle");
  if (!verboseToggle || !persistToggle) return;

  function applyToUI(s) {
    if (!s || typeof s !== "object") return;
    if (typeof s.verboseLogs === "boolean")
      verboseToggle.checked = s.verboseLogs;
    if (typeof s.persistAcrossSessions === "boolean")
      persistToggle.checked = s.persistAcrossSessions;
  }

  // Initial load — defaults match chat-panel.js (verboseLogs:true,
  // persistAcrossSessions:false) so first-time users see the same
  // state regardless of which surface they look at first.
  chrome.storage?.local?.get?.([STORAGE_KEY], (items) => {
    const s = (items && items[STORAGE_KEY]) || {
      verboseLogs: true,
      persistAcrossSessions: false,
    };
    applyToUI({
      verboseLogs:
        typeof s.verboseLogs === "boolean" ? s.verboseLogs : true,
      persistAcrossSessions:
        typeof s.persistAcrossSessions === "boolean"
          ? s.persistAcrossSessions
          : false,
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
const AI_CHAT_NEW_VERSION = "1.3.0";
(function _initAiChatNewBadge() {
  const badge = document.getElementById("aiChatNewBadge");
  if (!badge) return;
  try {
    chrome.storage.local.get(["aiChatNewSeenVersion"], (items) => {
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
async function checkCliBinary() {
  if (!DOM.checkCliBtn) return;
  const binary = (DOM.providerCliBinary?.value || "").trim();
  const kind = DOM.providerCliKind?.value || "claude";
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
      DOM.providerStatus.textContent = `✕ ${err.substring(0, 100)}`;
      addLog(`CLI check failed: ${err}`, "error");
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
  const stored = await chrome.storage.local.get(["serverPath"]);
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
    browser: "chromium",
    headless: true,
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
  const info = CLI_KIND_INFO[kind] || CLI_KIND_INFO.claude;
  const currentBinary = (DOM.providerCliBinary?.value || "").trim();

  // If the user already supplied a binary, the prompt becomes redundant —
  // hide it to keep the popup compact.
  if (currentBinary) {
    DOM.cliPromptBox.style.display = "none";
    return;
  }

  DOM.cliPromptBox.style.display = "";
  if (DOM.cliPromptText) {
    const base = info.binary
      ? `${info.label} not configured. Default binary: '${info.binary}'. If it isn't on your $PATH yet, install it:`
      : `${info.label} selected — enter the binary name or absolute path above.`;
    DOM.cliPromptText.textContent = info.authHint
      ? `${base}\nAuth: ${info.authHint}`
      : base;
  }
  if (DOM.cliPromptInstall) {
    DOM.cliPromptInstall.textContent = info.install;
  }
  if (DOM.cliPromptUseDefault) {
    DOM.cliPromptUseDefault.style.display = info.binary ? "" : "none";
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
    if (cli === "codex") return /^(gpt|o\d)/.test(d);
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
  if (s === "cli") {
    if (cli === "claude") return "claude-sonnet-4-6";
    if (cli === "codex") return "gpt-5";
    if (cli === "copilot") return "gpt-5";
    return "";
  }
  if (s === "ide") return "";
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
    const nextModel =
      !currentModel
          ? fallbackModel
          : _modelLooksCompatibleWithProvider(currentModel, source, baseUrl, cliKind)
            ? currentModel
            : fallbackModel;
    if (DOM.providerModel.value !== nextModel) {
      DOM.providerModel.value = nextModel;
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
    const info = CLI_KIND_INFO[kindKey] || CLI_KIND_INFO.claude;
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
    clearBtn.addEventListener("click", () => {
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
