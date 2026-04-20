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
  tabTitle: $("#tabTitle"),
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
  providerEnabledToggle: $("#providerEnabledToggle"),
  saveProviderBtn: $("#saveProviderBtn"),
  providerStatus: $("#providerStatus"),
  rateLimitToggle: $("#rateLimitToggle"),
  rateLimitMax: $("#rateLimitMax"),
  rateLimitWindow: $("#rateLimitWindow"),
  rateLimitSettings: $("#rateLimitSettings"),
  confirmSubmitToggle: $("#confirmSubmitToggle"),
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
  if (DOM.appVersion) {
    DOM.appVersion.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  // Load saved port, server path, auto-connect preference, and provider settings
  const stored = await chrome.storage.local.get([
    "mcpPort",
    "serverPath",
    "autoConnect",
    "aiProviderSource",
    "aiProviderApiKey",
    "aiProviderModel",
    "aiProviderBaseUrl",
  ]);
  const port = stored.mcpPort || 9876;
  const serverPath = stored.serverPath || null;
  const autoConnect = stored.autoConnect === true;

  providerSettings = {
    source: stored.aiProviderSource || "ide",
    apiKey: stored.aiProviderApiKey || "",
    model: stored.aiProviderModel || "",
    baseUrl: stored.aiProviderBaseUrl || "",
  };

  DOM.portInput.value = port;
  DOM.autoConnectToggle.checked = autoConnect;
  if (DOM.providerSelect) DOM.providerSelect.value = providerSettings.source;
  if (DOM.providerApiKey) DOM.providerApiKey.value = providerSettings.apiKey;
  if (DOM.providerModel) DOM.providerModel.value = providerSettings.model;
  if (DOM.providerBaseUrl) DOM.providerBaseUrl.value = providerSettings.baseUrl;
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

  // Listen for path/provider updates
  chrome.storage.onChanged.addListener((changes) => {
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

    if (
      changes.aiProviderSource ||
      changes.aiProviderApiKey ||
      changes.aiProviderModel ||
      changes.aiProviderBaseUrl
    ) {
      providerSettings = {
        source: changes.aiProviderSource
          ? changes.aiProviderSource.newValue
          : providerSettings.source,
        apiKey: changes.aiProviderApiKey
          ? changes.aiProviderApiKey.newValue
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
      providerSettings.source = DOM.providerSelect.value || "ide";
      updateProviderUI();
      // Auto-save when provider changes so settings persist immediately
      saveProviderSettings();
    });
  }

  if (DOM.saveProviderBtn) {
    DOM.saveProviderBtn.addEventListener("click", saveProviderSettings);
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
});

// ─── Tab Switching ───────────────────────────────────────────
function initTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      // Deactivate all tabs
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-content").forEach((tc) => tc.classList.remove("active"));
      // Activate clicked tab
      tab.classList.add("active");
      const target = tab.dataset.tab;
      $(`#tab-${target}`).classList.add("active");
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

// ─── Config Generation ───────────────────────────────────────
function generateConfigs(port, detectedPath) {
  const isDetected = !!detectedPath;
  const serverPath = detectedPath || "autodom-extension/server/index.js";

  const portArgs = port !== 9876 ? `, "--port", "${port}"` : "";
  const tomlPortArgs = port !== 9876 ? `, "--port", "${port}"` : "";

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
  // Switch to Config tab
  $$(".tab").forEach((t) => t.classList.remove("active"));
  $$(".tab-content").forEach((tc) => tc.classList.remove("active"));

  $('[data-tab="config"]').classList.add("active");
  $("#tab-config").classList.add("active");
});

// ─── AI Chat Button ──────────────────────────────────────────
// Opens the AI chat panel on the active tab. Only works when MCP is connected.
DOM.aiChatBtn.addEventListener("click", async () => {
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

async function saveProviderSettings() {
  providerSettings = {
    source: DOM.providerSelect?.value || "ide",
    apiKey: DOM.providerApiKey?.value?.trim() || "",
    model: DOM.providerModel?.value?.trim() || "",
    baseUrl: DOM.providerBaseUrl?.value?.trim() || "",
  };

  await chrome.storage.local.set({
    aiProviderSource: providerSettings.source,
    aiProviderApiKey: providerSettings.apiKey,
    aiProviderModel: providerSettings.model,
    aiProviderBaseUrl: providerSettings.baseUrl,
  });

  const response = await sendRuntimeMessage({
    type: "SET_AI_PROVIDER",
    provider: {
      source: providerSettings.source,
      apiKey: providerSettings.apiKey,
      model: providerSettings.model,
      baseUrl: providerSettings.baseUrl,
    },
  });

  updateProviderUI();

  if (response?.success) {
    addLog(
      `AI provider saved: ${formatProviderLabel(providerSettings.source)}`,
      "success",
    );
  } else {
    addLog(response?.error || "Failed to save AI provider settings", "error");
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
if (DOM.rateLimitToggle) {
  DOM.rateLimitToggle.addEventListener("change", () => {
    const enabled = DOM.rateLimitToggle.checked;
    if (DOM.rateLimitSettings)
      DOM.rateLimitSettings.style.display = enabled ? "block" : "none";
    sendRuntimeMessage({
      type: "UPDATE_GUARDRAILS",
      rateLimitConfig: {
        enabled,
        maxCallsPerDomain: parseInt(DOM.rateLimitMax?.value || "100", 10),
        windowMs: parseInt(DOM.rateLimitWindow?.value || "60000", 10),
      },
    });
  });
}

if (DOM.rateLimitMax) {
  DOM.rateLimitMax.addEventListener("change", () => {
    if (DOM.rateLimitToggle?.checked) {
      sendRuntimeMessage({
        type: "UPDATE_GUARDRAILS",
        rateLimitConfig: {
          enabled: true,
          maxCallsPerDomain: parseInt(DOM.rateLimitMax.value || "100", 10),
          windowMs: parseInt(DOM.rateLimitWindow?.value || "60000", 10),
        },
      });
    }
  });
}

if (DOM.rateLimitWindow) {
  DOM.rateLimitWindow.addEventListener("change", () => {
    if (DOM.rateLimitToggle?.checked) {
      sendRuntimeMessage({
        type: "UPDATE_GUARDRAILS",
        rateLimitConfig: {
          enabled: true,
          maxCallsPerDomain: parseInt(DOM.rateLimitMax?.value || "100", 10),
          windowMs: parseInt(DOM.rateLimitWindow.value || "60000", 10),
        },
      });
    }
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
        source: message.provider.source || providerSettings.source || "ide",
        apiKey: message.provider.apiKey || providerSettings.apiKey || "",
        model: message.provider.model || providerSettings.model || "",
      };
      if (DOM.providerSelect)
        DOM.providerSelect.value = providerSettings.source;
      if (DOM.providerModel)
        DOM.providerModel.value = providerSettings.model || "";
    }
    updateProviderUI(message.statusText);
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
  switch (source) {
    case "openai":
      return "GPT";
    case "anthropic":
      return "Claude";
    case "ollama":
      return "Ollama";
    default:
      return "IDE Agent";
  }
}

function updateProviderUI(statusOverride) {
  if (!DOM.providerStatus) return;

  const source = providerSettings.source || "ide";
  const label = formatProviderLabel(source);

  if (DOM.providerApiKey) {
    DOM.providerApiKey.disabled = source === "ide" || source === "ollama";
    DOM.providerApiKey.placeholder =
      source === "openai"
        ? "OpenAI API key"
        : source === "anthropic"
          ? "Anthropic API key"
          : source === "ollama"
            ? "Not required for local Ollama"
            : "Not required for IDE Agent mode";
  }

  if (DOM.providerModel) {
    DOM.providerModel.disabled = source === "ide";
    if (!DOM.providerModel.value && source === "openai") {
      DOM.providerModel.value = "gpt-4.1";
    }
    if (!DOM.providerModel.value && source === "anthropic") {
      DOM.providerModel.value = "claude-3-7-sonnet-latest";
    }
    if (!DOM.providerModel.value && source === "ollama") {
      DOM.providerModel.value = "llama3.2";
    }
  }

  if (DOM.providerBaseUrl) {
    DOM.providerBaseUrl.disabled = source === "ide";
    if (!DOM.providerBaseUrl.value && source === "ollama") {
      DOM.providerBaseUrl.value = "http://localhost:11434";
    }
  }

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
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "logs") fetchToolLogs();
    });
  });
}

initToolLogsTab();
