/**
 * AutoDOM — Service Worker (Background Script)
 *
 * Manages the WebSocket connection to the MCP bridge server.
 * Routes tool calls from the server → content script → results back.
 * Uses chrome.scripting, chrome.tabs, and chrome.debugger APIs.
 */

let ws = null;
let wsPort = 9876;
let _requestedPort = 9876; // Port the user/startup explicitly asked for — never mutated by fallback logic
let isConnected = false;
let keepAliveInterval = null;
let shouldRunMcp = false;
let autoConnectEnabled = false;
let lastConnectedPort = 9876;
let autoConnectFallbackTried = false;
let _sessionTimedOut = false; // Set when server or extension inactivity timeout fires
const ACTIVITY_LOG_KEY = "autodomActivityLogs";
const ACTIVITY_LOG_LIMIT = 250;
const activityStorage = (() => {
  try {
    return chrome.storage.session || chrome.storage.local;
  } catch (_) {
    return chrome.storage.local;
  }
})();

// Detect Firefox by checking for Gecko-specific manifest entry.
// chrome.debugger (CDP) is not available in Firefox; tools that depend on it
// will throw a clear "not supported" error rather than crashing silently.
const IS_FIREFOX = (() => {
  try {
    const manifest = chrome.runtime.getManifest();
    return !!(
      manifest.browser_specific_settings &&
      manifest.browser_specific_settings.gecko
    );
  } catch (_) {
    return false;
  }
})();

let _pendingToolLogResolve = null; // Resolve callback for GET_TOOL_LOGS roundtrip to server

// ─── Tool Error Log ───────────────────────────────────────────
// Ring buffer for tool errors visible in the extension Logs tab.
const TOOL_ERROR_LOG_MAX = 200;
const _swToolErrorLog = [];

function _swLogToolError(tool, error, extra) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    error: typeof error === "string" ? error : (error?.message || String(error)),
    extra: extra || undefined,
  };
  if (_swToolErrorLog.length >= TOOL_ERROR_LOG_MAX) _swToolErrorLog.shift();
  _swToolErrorLog.push(entry);
}

let aiProviderSettings = {
  source: "ide",
  apiKey: "",
  model: "",
  baseUrl: "",
};

function _formatLogText(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg && typeof arg.message === "string") return arg.message;
      try {
        return String(arg);
      } catch (_) {
        return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}

function appendActivityLog(level, source, ...args) {
  const text = _formatLogText(args);
  if (!text) return;
  const entry = {
    ts: Date.now(),
    level: level || "info",
    source: source || "background",
    text,
  };

  activityStorage.get([ACTIVITY_LOG_KEY], (result) => {
    const logs = Array.isArray(result?.[ACTIVITY_LOG_KEY])
      ? result[ACTIVITY_LOG_KEY]
      : [];
    logs.push(entry);
    if (logs.length > ACTIVITY_LOG_LIMIT) {
      logs.splice(0, logs.length - ACTIVITY_LOG_LIMIT);
    }
    activityStorage.set({ [ACTIVITY_LOG_KEY]: logs }).catch(() => {});
  });
}

function _debugLog(...args) {
  appendActivityLog("info", "background", ...args);
}

function _debugWarn(...args) {
  appendActivityLog("warn", "background", ...args);
}

function _debugError(...args) {
  appendActivityLog("error", "background", ...args);
}

// ─── Direct AI Provider Calls ────────────────────────────────
// These functions let the service worker call OpenAI, Anthropic, or
// Ollama APIs directly — no bridge server needed.  The service worker
// has host_permissions: ["<all_urls>"] so cross-origin fetch works.

function _buildSystemPrompt(context) {
  let p =
    "You are AutoDOM, a helpful browser AI assistant. " +
    "You help users understand and interact with the current web page.\n\n";
  if (context) {
    if (context.title) p += `Page title: ${context.title}\n`;
    if (context.url) p += `Page URL: ${context.url}\n`;
    if (context.interactiveElements) {
      const ie = context.interactiveElements;
      p += `Interactive elements: ${ie.links || 0} links, ${ie.buttons || 0} buttons, ${ie.inputs || 0} inputs, ${ie.forms || 0} forms\n`;
    }
  }
  p +=
    "\nRespond clearly and concisely. If the user asks about page content, " +
    "use the page context provided. For browser actions, suggest using " +
    "slash commands like /dom, /click, /screenshot, /nav.";
  return p;
}

function _buildMessages(text, context, conversationHistory) {
  const msgs = [{ role: "system", content: _buildSystemPrompt(context) }];
  // Add recent conversation history
  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    conversationHistory.slice(-12).forEach((m) => {
      if (m && m.role && m.content) {
        msgs.push({
          role: m.role === "assistant" || m.role === "system" ? m.role : "user",
          content: String(m.content),
        });
      }
    });
  }
  msgs.push({ role: "user", content: text });
  return msgs;
}

async function _callDirectProvider(
  providerType,
  text,
  context,
  conversationHistory,
) {
  const normalized =
    providerType === "gpt" || providerType === "chatgpt"
      ? "openai"
      : providerType === "claude"
        ? "anthropic"
        : providerType;

  if (normalized === "openai") {
    return _callOpenAI(text, context, conversationHistory);
  }
  if (normalized === "anthropic") {
    return _callAnthropic(text, context, conversationHistory);
  }
  if (normalized === "ollama") {
    return _callOllama(text, context, conversationHistory);
  }
  throw new Error(`Unknown direct provider: ${providerType}`);
}

async function _callOpenAI(text, context, conversationHistory) {
  const apiKey = (aiProviderSettings.apiKey || "").trim();
  if (!apiKey) throw new Error("No OpenAI API key configured");

  const baseUrl = (
    aiProviderSettings.baseUrl || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = aiProviderSettings.model || "gpt-4.1-mini";
  const messages = _buildMessages(text, context, conversationHistory);

  _debugLog(
    "[AutoDOM SW] Calling OpenAI:",
    baseUrl + "/chat/completions",
    "model:",
    model,
  );

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${errText.substring(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return {
    response: content || "OpenAI returned an empty response.",
    toolCalls: [{ tool: "_direct_provider", via: "openai", model }],
  };
}

async function _callAnthropic(text, context, conversationHistory) {
  const apiKey = (aiProviderSettings.apiKey || "").trim();
  if (!apiKey) throw new Error("No Anthropic API key configured");

  const model = aiProviderSettings.model || "claude-3-5-sonnet-latest";
  const systemPrompt = _buildSystemPrompt(context);
  const msgs = [];
  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    conversationHistory.slice(-12).forEach((m) => {
      if (m && m.role && m.content) {
        msgs.push({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content),
        });
      }
    });
  }
  msgs.push({ role: "user", content: text });

  _debugLog("[AutoDOM SW] Calling Anthropic, model:", model);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: msgs,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic ${resp.status}: ${errText.substring(0, 300)}`);
  }

  const data = await resp.json();
  const content = Array.isArray(data?.content)
    ? data.content
        .filter((p) => p?.type === "text" && p?.text)
        .map((p) => p.text)
        .join("\n")
        .trim()
    : "";
  return {
    response: content || "Anthropic returned an empty response.",
    toolCalls: [{ tool: "_direct_provider", via: "anthropic", model }],
  };
}

async function _callOllama(text, context, conversationHistory) {
  const baseUrl = (
    aiProviderSettings.baseUrl || "http://localhost:11434"
  ).replace(/\/+$/, "");
  const model = aiProviderSettings.model || "llama3.2";
  const messages = _buildMessages(text, context, conversationHistory);

  _debugLog(
    "[AutoDOM SW] Calling Ollama:",
    baseUrl + "/api/chat",
    "model:",
    model,
  );

  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${errText.substring(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.message?.content || "";
  return {
    response: content || "Ollama returned an empty response.",
    toolCalls: [{ tool: "_direct_provider", via: "ollama", model }],
  };
}

// ─── Inactivity Timeout ─────────────────────────────────────
// Auto-disconnect after 10 minutes of no tool calls.
// Any tool call resets the timer. Keepalives do NOT reset it —
// only real user/agent activity counts.
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
let lastToolActivityTime = Date.now();
let inactivityCheckInterval = null;

function touchToolActivity() {
  lastToolActivityTime = Date.now();
}

function startInactivityTimer() {
  stopInactivityTimer();
  lastToolActivityTime = Date.now();
  inactivityCheckInterval = setInterval(() => {
    const idleMs = Date.now() - lastToolActivityTime;
    const idleMins = (idleMs / 60000).toFixed(1);

    if (idleMs >= INACTIVITY_TIMEOUT_MS) {
      if (autoConnectEnabled) {
        _debugLog(
          `[AutoDOM] Session idle for ${idleMins} minutes — auto-connect is enabled, keeping the bridge connected`,
        );
        lastToolActivityTime = Date.now();
        return;
      }
      _debugWarn(
        `[AutoDOM] Session idle for ${idleMins} minutes — auto-disconnecting`,
      );
      // Mark as timed out BEFORE disconnect so onclose treats this as a final stop
      _sessionTimedOut = true;
      shouldRunMcp = false;
      stopAutoConnect();
      stopInactivityTimer();
      disconnectWebSocket();
      chrome.storage.local.set({ mcpRunning: false });
      // Explicitly hide border and chat on ALL tabs (including non-active)
      broadcastToAllTabs([
        { type: "HIDE_SESSION_BORDER" },
        { type: "HIDE_CHAT_PANEL" },
      ]);
      // Broadcast after disconnect so popup and content scripts know
      broadcastStatus(
        false,
        `Session auto-closed after ${idleMins} min of inactivity. Click Connect to start again.`,
        "warn",
      );
      // Also send explicit MCP stop to all tabs so chat-panel tears down
      broadcastMcpStopToAllTabs();
      return;
    }

    // Warn at 80% of timeout (8 minutes)
    if (idleMs >= INACTIVITY_TIMEOUT_MS * 0.8) {
      const remainingSecs = Math.round((INACTIVITY_TIMEOUT_MS - idleMs) / 1000);
      _debugLog(
        `[AutoDOM] Inactivity warning: idle ${idleMins}m, auto-disconnect in ${remainingSecs}s`,
      );
      broadcastStatus(
        true,
        `Idle ${idleMins}m — session will close in ${remainingSecs}s. Use any tool to keep alive.`,
        "warn",
      );
    }
  }, 60000); // Check every 60s — sufficient for 10min timeout
}

function stopInactivityTimer() {
  if (inactivityCheckInterval) {
    clearInterval(inactivityCheckInterval);
    inactivityCheckInterval = null;
  }
}

// ─── Indexed Element Cache ───────────────────────────────────
// Stores the last get_dom_state result so click_by_index / type_by_index
// can resolve indices to real DOM elements without re-scanning.
let _indexedElements = []; // Array of serialised element descriptors
let _indexedTabId = null; // Tab the index map belongs to

function getCurrentPort() {
  return typeof wsPort === "number" && Number.isFinite(wsPort) ? wsPort : 9876;
}

// Network & console capture stores
const networkRequests = [];
const consoleLogs = [];
const MAX_CAPTURE_SIZE = 200;

// ─── Session Recording ──────────────────────────────────────
let sessionRecording = {
  active: false,
  startTime: null,
  actions: [], // {timestamp, type, description, url, tabId, details}
  maxActions: 1000,
};

// ─── Per-Domain Rate Limiter ─────────────────────────────────
// Tracks tool calls per domain within a sliding time window.
// Prevents infinite click loops and runaway automation.
// Configuration is loaded from chrome.storage.local.
let rateLimitConfig = {
  enabled: false,
  maxCallsPerDomain: 100, // max tool calls per domain per window
  windowMs: 60000, // 1-minute sliding window
  budgets: {}, // per-domain overrides: { "example.com": 50 }
};

// domainCallLog: Map<domain, Array<timestamp>>
const domainCallLog = new Map();

// Load rate limit config from storage on startup
chrome.storage.local.get(["rateLimitConfig"], (stored) => {
  if (stored.rateLimitConfig) {
    rateLimitConfig = { ...rateLimitConfig, ...stored.rateLimitConfig };
  }
});

// Listen for config changes from popup
chrome.storage.onChanged.addListener((changes) => {
  if (changes.rateLimitConfig) {
    rateLimitConfig = {
      ...rateLimitConfig,
      ...changes.rateLimitConfig.newValue,
    };
    _debugLog("[AutoDOM] Rate limit config updated:", rateLimitConfig);
  }
});

function getDomainFromTab(tab) {
  try {
    if (!tab || !tab.url) return null;
    const url = new URL(tab.url);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function checkRateLimit(domain) {
  if (!rateLimitConfig.enabled || !domain) return { allowed: true };

  const now = Date.now();
  const windowStart = now - rateLimitConfig.windowMs;

  // Get or create call log for this domain
  let calls = domainCallLog.get(domain);
  if (!calls) {
    calls = [];
    domainCallLog.set(domain, calls);
  }

  // Prune old entries outside the window
  while (calls.length > 0 && calls[0] < windowStart) {
    calls.shift();
  }

  // Determine budget for this domain
  const budget =
    rateLimitConfig.budgets[domain] || rateLimitConfig.maxCallsPerDomain;

  if (calls.length >= budget) {
    const oldestCall = calls[0];
    const resetInMs = oldestCall + rateLimitConfig.windowMs - now;
    return {
      allowed: false,
      domain,
      callsInWindow: calls.length,
      budget,
      resetInMs,
      error: `Rate limit exceeded for ${domain}: ${calls.length}/${budget} calls in ${rateLimitConfig.windowMs / 1000}s window. Resets in ${Math.ceil(resetInMs / 1000)}s.`,
    };
  }

  // Record this call
  calls.push(now);

  return {
    allowed: true,
    domain,
    callsInWindow: calls.length,
    budget,
    remaining: budget - calls.length,
  };
}

// Periodic cleanup of stale domain entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [domain, calls] of domainCallLog) {
    // Remove entries older than the window
    while (calls.length > 0 && calls[0] < now - rateLimitConfig.windowMs) {
      calls.shift();
    }
    // Remove empty domains
    if (calls.length === 0) {
      domainCallLog.delete(domain);
    }
  }
}, 300000);

// ─── Confirm-Before-Submit Mode ──────────────────────────────
// When enabled, catches sensitive actions (form submissions, clicks on
// purchase/checkout buttons, navigation to payment URLs) and requires
// confirmation before executing. Works through the chat panel.
let confirmBeforeSubmitConfig = {
  enabled: false,
  // URL patterns that trigger confirmation on navigate
  sensitiveUrlPatterns: [
    /checkout/i,
    /payment/i,
    /purchase/i,
    /order/i,
    /billing/i,
    /subscribe/i,
    /pay\b/i,
    /cart/i,
    /donate/i,
    /transfer/i,
  ],
  // Button text patterns that trigger confirmation on click
  sensitiveButtonPatterns: [
    /submit/i,
    /purchase/i,
    /buy\s*now/i,
    /place\s*order/i,
    /confirm\s*order/i,
    /pay\s*now/i,
    /checkout/i,
    /complete/i,
    /subscribe/i,
    /donate/i,
    /send\s*payment/i,
    /authorize/i,
    /sign\s*up/i,
    /register/i,
    /delete\s*account/i,
  ],
};

// Load confirm-before-submit config from storage
chrome.storage.local.get(["confirmBeforeSubmitConfig"], (stored) => {
  if (stored.confirmBeforeSubmitConfig) {
    // Only merge the `enabled` flag — patterns stay hardcoded for safety
    confirmBeforeSubmitConfig.enabled =
      !!stored.confirmBeforeSubmitConfig.enabled;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.confirmBeforeSubmitConfig) {
    confirmBeforeSubmitConfig.enabled =
      !!changes.confirmBeforeSubmitConfig.newValue?.enabled;
    _debugLog(
      "[AutoDOM] Confirm-before-submit:",
      confirmBeforeSubmitConfig.enabled ? "ON" : "OFF",
    );
  }
});

// Pending confirmations for the confirm-before-submit flow
const pendingSubmitConfirmations = new Map();
let submitConfirmIdCounter = 0;

function isSensitiveAction(tool, params) {
  if (!confirmBeforeSubmitConfig.enabled) return null;

  // Check navigate to sensitive URLs
  if (tool === "navigate" && params.url) {
    const url = params.url.toLowerCase();
    for (const pattern of confirmBeforeSubmitConfig.sensitiveUrlPatterns) {
      if (pattern.test(url)) {
        return {
          reason: `Navigation to potentially sensitive URL matching "${pattern}"`,
          url: params.url,
        };
      }
    }
  }

  // Check fill_form — always sensitive
  if (tool === "fill_form") {
    return {
      reason: "Form fill operation — may trigger submission of sensitive data",
    };
  }

  // Check click on submit/purchase buttons
  if ((tool === "click" || tool === "click_by_index") && params) {
    // For CSS selector clicks, check if selector hints at submit
    if (params.selector) {
      const sel = params.selector.toLowerCase();
      if (
        sel.includes("submit") ||
        sel.includes("checkout") ||
        sel.includes("purchase") ||
        sel.includes("payment")
      ) {
        return {
          reason: `Click on element matching sensitive selector: "${params.selector}"`,
        };
      }
    }
    // For text-based clicks
    if (params.text) {
      for (const pattern of confirmBeforeSubmitConfig.sensitiveButtonPatterns) {
        if (pattern.test(params.text)) {
          return {
            reason: `Click on button with sensitive text: "${params.text}"`,
          };
        }
      }
    }
  }

  return null;
}

// Sensitive data patterns to mask
const SENSITIVE_PATTERNS = [
  { name: "credit_card", regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: "email_password",
    regex:
      /(?:password|passwd|pwd|secret|token|api_key|apikey|auth|bearer|credential|ssn|cvv|cvc|pin)\s*[:=]\s*['"]?[^\s'"]{2,}/gi,
  },
  { name: "bearer_token", regex: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi },
  {
    name: "jwt",
    regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
  },
];

// Input types that should never have their values recorded
const SENSITIVE_INPUT_TYPES = new Set([
  "password",
  "credit-card",
  "cc-number",
  "cc-exp",
  "cc-csc",
  "ssn",
]);

// Shared set of sensitive field names — used by both isSensitiveInput()
// and the injected interaction tracker to avoid duplication.
const SENSITIVE_FIELD_NAMES = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "ssn",
  "cvv",
  "cvc",
  "pin",
  "credit_card",
  "cc_number",
  "card_number",
  "creditcard",
  "cardnumber",
  "securitycode",
];

function maskSensitiveData(text) {
  if (!text || typeof text !== "string") return text;
  let masked = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex in case regex is reused (global flag)
    pattern.regex.lastIndex = 0;
    masked = masked.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  return masked;
}

function isSensitiveInput(details) {
  if (!details) return false;
  const type = (details.type || "").toLowerCase();
  const name = (details.name || "").toLowerCase();
  const autocomplete = (details.autocomplete || "").toLowerCase();
  if (SENSITIVE_INPUT_TYPES.has(type) || type === "password") return true;
  if (SENSITIVE_FIELD_NAMES.some((s) => name.includes(s))) return true;
  if (
    [...SENSITIVE_INPUT_TYPES].some((s) => autocomplete.includes(s)) ||
    autocomplete.includes("password")
  )
    return true;
  return false;
}

function recordAction(
  type,
  description,
  details = {},
  tabId = null,
  url = null,
) {
  if (!sessionRecording.active) return;
  // Mask sensitive data in description and details
  const safeDescription = maskSensitiveData(description);
  const safeDetails = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === "string") {
      safeDetails[k] = maskSensitiveData(v);
    } else {
      safeDetails[k] = v;
    }
  }
  sessionRecording.actions.push({
    timestamp: Date.now(),
    elapsed: Date.now() - sessionRecording.startTime,
    type,
    description: safeDescription,
    details: safeDetails,
    tabId,
    url,
  });
  if (sessionRecording.actions.length > sessionRecording.maxActions) {
    sessionRecording.actions.shift();
  }
}

// ─── Tab Activity Listeners (for session recording) ─────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    recordAction(
      "navigation",
      `Navigated to: ${tab.title || tab.url}`,
      {
        title: tab.title,
        url: tab.url,
      },
      tabId,
      tab.url,
    );
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    recordAction(
      "tab_switch",
      `Switched to tab: ${tab.title || "untitled"}`,
      {
        title: tab.title,
        url: tab.url,
      },
      activeInfo.tabId,
      tab.url,
    );
  } catch {}
});

chrome.tabs.onCreated.addListener((tab) => {
  recordAction(
    "tab_created",
    `New tab opened`,
    { url: tab.pendingUrl || tab.url },
    tab.id,
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recordAction("tab_closed", `Tab closed`, {}, tabId);
});

// ─── WebSocket Management ────────────────────────────────────

function connectWebSocket(port) {
  wsPort = port || getCurrentPort();
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${getCurrentPort()}`);

    ws.onopen = () => {
      isConnected = true;
      _startupRestoreOnly = false;
      autoConnectFallbackTried = false;
      lastConnectedPort = getCurrentPort();
      chrome.storage.local.set({
        serverPort: lastConnectedPort,
        mcpLastConnectedPort: lastConnectedPort,
      });
      stopAutoConnect();
      // Send KEEPALIVE immediately so the bridge recognises us as the
      // Chrome extension right away, instead of waiting 20 s for the
      // first setInterval tick.
      ws.send(JSON.stringify({ type: "KEEPALIVE" }));
      startKeepAlive();
      if (!autoConnectEnabled) {
        startInactivityTimer();
      } else {
        stopInactivityTimer();
      }
      broadcastStatus(true, "Connected to MCP bridge server", "success");
      _debugLog("[AutoDOM] WebSocket connected");
      // Show session border and chat panel on all tabs
      broadcastToAllTabs([
        { type: "SHOW_SESSION_BORDER" },
        { type: "SHOW_CHAT_PANEL" },
      ]);
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        // Track server liveness from any inbound message
        _lastPongTime = Date.now();

        // Handle AI chat responses from the bridge server
        if (message.type === "AI_CHAT_RESPONSE") {
          _debugLog(
            "[AutoDOM SW] AI_CHAT_RESPONSE received, id:",
            message.id,
            "hasResponse:",
            !!message.response,
            "hasError:",
            !!message.error,
          );
          const pending = pendingAiRequests.get(message.id);
          if (pending) {
            pendingAiRequests.delete(message.id);
            pending.resolve({
              type: "AI_CHAT_RESPONSE",
              response: message.response,
              toolCalls: message.toolCalls || [],
              error: message.error || null,
            });
          } else {
            _debugWarn(
              "[AutoDOM SW] No pending AI request for id:",
              message.id,
              "pendingCount:",
              pendingAiRequests.size,
            );
          }
          return;
        }

        // Handle tool log responses from server
        if (message.type === "TOOL_LOGS_RESPONSE") {
          if (_pendingToolLogResolve) {
            const resolve = _pendingToolLogResolve;
            _pendingToolLogResolve = null;
            resolve({ serverLogs: message.logs || [], logFile: message.logFile });
          }
          return;
        }

        // Handle inactivity warnings / session timeout from server
        if (message.type === "INACTIVITY_WARNING") {
          broadcastStatus(
            true,
            `Idle ${message.idleMinutes}m — server will auto-close in ${message.remainingSeconds}s. Use any tool to keep alive.`,
            "warn",
          );
          return;
        }
        if (message.type === "SESSION_TIMEOUT") {
          _debugWarn("[AutoDOM] Server closed session:", message.message);
          const keepRetrying = autoConnectEnabled;
          if (!keepRetrying) {
            // Mark as timed out BEFORE disconnect so onclose treats this as a final stop
            _sessionTimedOut = true;
            shouldRunMcp = false;
            stopAutoConnect();
          }
          stopInactivityTimer();
          disconnectWebSocket();
          chrome.storage.local.set({ mcpRunning: keepRetrying });
          // Explicitly hide border and chat on ALL tabs (including non-active)
          broadcastToAllTabs([
            { type: "HIDE_SESSION_BORDER" },
            { type: "HIDE_CHAT_PANEL" },
          ]);
          if (keepRetrying) {
            broadcastStatus(
              false,
              `${message.message} Auto-connect is retrying.`,
              "warn",
            );
            startAutoConnect(getCurrentPort());
          } else {
            broadcastStatus(false, message.message, "warn");
          }
          // Also send explicit MCP stop to all tabs so chat-panel tears down
          broadcastMcpStopToAllTabs();
          return;
        }

        if (message.type === "TOOL_CALL") {
          _debugLog(
            "[AutoDOM SW] TOOL_CALL from bridge:",
            message.tool,
            "id:",
            message.id,
          );
          const result = await handleToolCallWithRecording(
            message.tool,
            message.params,
            message.id,
          );
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          ws.send(
            JSON.stringify({
              type: "TOOL_RESULT",
              id: message.id,
              result,
            }),
          );
          // Notify popup
          chrome.runtime
            .sendMessage({
              type: "TOOL_CALLED",
              tool: message.tool,
            })
            .catch(() => {});
        }
        if (message.type === "SERVER_INFO") {
          // Store the server's actual filesystem path for the Config tab
          if (message.port) {
            lastConnectedPort = Number(message.port) || lastConnectedPort;
            chrome.storage.local.set({
              serverPort: lastConnectedPort,
              mcpLastConnectedPort: lastConnectedPort,
            });
          }
          chrome.storage.local.set({
            serverPath: message.serverPath,
          });
          _debugLog("[AutoDOM] Server path:", message.serverPath);
        }
        if (message.type === "PING") {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "PONG" }));
          }
        }
      } catch (err) {
        _debugError("[AutoDOM] Message handling error:", err);
      }
    };

    ws.onclose = (event) => {
      ws = null;
      isConnected = false;
      stopKeepAlive();
      stopInactivityTimer();
      resolvePendingAiRequests("MCP disconnected before the AI agent replied.");
      _debugLog(
        `[AutoDOM] WebSocket disconnected: code=${event.code}, reason=${event.reason}, wasClean=${event.wasClean}`,
      );

      // Any close transitions the extension into a fully stopped state.
      if (_sessionTimedOut) {
        _debugLog(
          "[AutoDOM] WebSocket closed after session timeout — not reconnecting",
        );
        _sessionTimedOut = false;
        shouldRunMcp = false;
        stopAutoConnect();
        broadcastStatus(false, "Session timed out due to inactivity", "warn");
        broadcastToAllTabs([
          { type: "HIDE_SESSION_BORDER" },
          { type: "HIDE_CHAT_PANEL" },
        ]);
        broadcastMcpStopToAllTabs();
        chrome.storage.local.set({ mcpRunning: false });
      } else {
        const currentPort = getCurrentPort();
        const fallbackPort =
          Number.isFinite(lastConnectedPort) && lastConnectedPort > 0
            ? lastConnectedPort
            : null;

        if (
          autoConnectEnabled &&
          !isConnected &&
          fallbackPort &&
          fallbackPort !== currentPort &&
          !autoConnectFallbackTried
        ) {
          autoConnectFallbackTried = true;
          wsPort = fallbackPort;
          chrome.storage.local.set({
            mcpRunning: true,
          });
          broadcastStatus(
            false,
            `Disconnected from ws://127.0.0.1:${currentPort}. Falling back to last working port ${fallbackPort}.`,
            "warn",
          );
          startAutoConnect(fallbackPort);
        } else if (shouldRunMcp) {
          // After the fallback cycle is exhausted, always retry the user-requested
          // port so the extension doesn't permanently drift to lastConnectedPort.
          wsPort = _requestedPort;
          chrome.storage.local.set({ mcpRunning: true });
          broadcastStatus(
            false,
            "Disconnected from MCP bridge server. Auto-reconnect is retrying.",
            "warn",
          );
          startAutoConnect(_requestedPort);
        } else {
          stopAutoConnect();
          chrome.storage.local.set({ mcpRunning: false });
          broadcastStatus(
            false,
            "Disconnected from MCP bridge server. Click Connect to retry.",
            "warn",
          );
        }
        broadcastToAllTabs([
          { type: "HIDE_SESSION_BORDER" },
          { type: "HIDE_CHAT_PANEL" },
        ]);
        broadcastMcpStopToAllTabs();
      }
    };

    ws.onerror = (err) => {
      _debugWarn(
        "[AutoDOM] WebSocket error:",
        err?.message || err?.type || "connection refused",
      );
      if (_startupRestoreOnly) {
        _startupRestoreOnly = false;
        broadcastStatus(
          false,
          "Bridge not reachable yet. Auto-connect will keep retrying.",
          "info",
        );
      } else if (autoConnectEnabled && !isConnected) {
        const currentPort = getCurrentPort();
        if (
          Number.isFinite(lastConnectedPort) &&
          lastConnectedPort > 0 &&
          lastConnectedPort !== currentPort &&
          !autoConnectFallbackTried
        ) {
          autoConnectFallbackTried = true;
          wsPort = lastConnectedPort;
          chrome.storage.local.set({
            mcpRunning: true,
          });
          broadcastStatus(
            false,
            `Connection refused on port ${currentPort}. Trying last working port ${lastConnectedPort}.`,
            "warn",
          );
          startAutoConnect(lastConnectedPort);
        }
      }
    };
  } catch (err) {
    _debugWarn("[AutoDOM] Failed to connect:", err.message || err);
  }
}

function disconnectWebSocket() {
  stopKeepAlive();
  stopInactivityTimer();
  resolvePendingAiRequests("MCP stopped before the AI agent replied.");
  if (ws) {
    ws.onclose = null; // prevent duplicate stop handling
    ws.close();
    ws = null;
  }
  isConnected = false;
  chrome.storage.local.set({ mcpRunning: false });
  broadcastStatus(false, "Disconnected", "info");
  // Hide session border and chat panel on all tabs
  broadcastToAllTabs([
    { type: "HIDE_SESSION_BORDER" },
    { type: "HIDE_CHAT_PANEL" },
  ]);
}

// MV3 keep-alive: send a small message to keep the service worker alive
// and detect dead connections via response timeout.
let _lastPongTime = 0;
const KEEPALIVE_INTERVAL_MS = 20000;
const KEEPALIVE_TIMEOUT_MS = 10000; // If no pong within this time, disconnect

const _KEEPALIVE_MSG = JSON.stringify({ type: "KEEPALIVE" });

function startKeepAlive() {
  stopKeepAlive();
  _lastPongTime = Date.now();
  keepAliveInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Check if the last keepalive was acknowledged in time
      if (
        _lastPongTime > 0 &&
        Date.now() - _lastPongTime >
          KEEPALIVE_INTERVAL_MS + KEEPALIVE_TIMEOUT_MS
      ) {
        _debugWarn("[AutoDOM] Server unresponsive, disconnecting...");
        ws.close();
        return;
      }
      ws.send(_KEEPALIVE_MSG);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  _lastPongTime = 0;
}

// ─── Message Handler from Popup ──────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "USER_ACTION") {
    _debugLog(
      "[AutoDOM SW] onMessage:",
      message.type,
      "from:",
      sender?.tab ? "tab:" + sender.tab.id : "popup/extension",
    );
  }
  if (message.type === "START_MCP") {
    const port = message.port || getCurrentPort();
    wsPort = port;
    _requestedPort = port;
    shouldRunMcp = true;
    _startupRestoreOnly = false;
    _sessionTimedOut = false; // Clear timeout flag on fresh start
    chrome.storage.local.set({ mcpPort: port, mcpRunning: true });

    // Connect to the WebSocket server (started by IDE or manually)
    connectWebSocket(port);
    sendResponse({ success: true, connected: isConnected });
    broadcastStatus(
      isConnected,
      isConnected
        ? "Connected to MCP bridge server"
        : `Starting MCP on ws://127.0.0.1:${port}...`,
      isConnected ? "success" : "info",
    );
    return false;
  }

  if (message.type === "ACTIVITY_LOG_APPEND") {
    appendActivityLog(
      message.level || "info",
      message.source ||
        (sender?.tab?.id ? `tab:${sender.tab.id}` : "extension"),
      message.text || "",
    );
    return false;
  }

  if (message.type === "STOP_MCP") {
    shouldRunMcp = false;
    autoConnectEnabled = false;
    autoConnectFallbackTried = false;
    stopAutoConnect();
    chrome.storage.local.set({ autoConnect: false, mcpRunning: false });
    disconnectWebSocket();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "SET_AUTO_CONNECT") {
    const autoConnect = !!message.value;
    autoConnectEnabled = autoConnect;
    autoConnectFallbackTried = false;
    chrome.storage.local.set({ autoConnect });
    if (autoConnect) {
      shouldRunMcp = true;
      _startupRestoreOnly = false;
      chrome.storage.local.set({ mcpRunning: true });
      if (isConnected) {
        stopInactivityTimer();
      } else {
        startAutoConnect(getCurrentPort());
      }
    } else {
      _startupRestoreOnly = false;
      if (isConnected) {
        startInactivityTimer();
      } else {
        shouldRunMcp = false;
        stopAutoConnect();
        chrome.storage.local.set({ mcpRunning: false });
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "CONNECTIVITY_CHECK") {
    // Quick check if direct provider is configured and reachable
    const src = aiProviderSettings.source || "ide";
    const isDirect =
      (src === "openai" && !!(aiProviderSettings.apiKey || "").trim()) ||
      (src === "anthropic" && !!(aiProviderSettings.apiKey || "").trim()) ||
      src === "ollama";
    sendResponse({
      directProvider: isDirect,
      provider: src,
      bridgeConnected: isConnected,
      hasApiKey: !!(aiProviderSettings.apiKey || "").trim(),
    });
    return false;
  }

  if (message.type === "GET_STATUS") {
    sendResponse({
      connected: isConnected,
      running: shouldRunMcp,
      port: getCurrentPort(),
      recording: sessionRecording.active,
      provider: {
        source: aiProviderSettings.source,
        apiKey: aiProviderSettings.apiKey,
        model: aiProviderSettings.model,
        baseUrl: aiProviderSettings.baseUrl,
      },
    });
    return false;
  }

  if (message.type === "SET_AI_PROVIDER") {
    const incomingProvider = message.provider || {};
    _debugLog(
      "[AutoDOM SW] SET_AI_PROVIDER received:",
      JSON.stringify({
        source: incomingProvider.source,
        hasApiKey: !!(incomingProvider.apiKey || "").trim(),
        apiKeyLen: (incomingProvider.apiKey || "").length,
        model: incomingProvider.model,
        baseUrl: incomingProvider.baseUrl,
      }),
    );
    aiProviderSettings = {
      source: incomingProvider.source || "ide",
      apiKey: incomingProvider.apiKey || "",
      model: incomingProvider.model || "",
      baseUrl: incomingProvider.baseUrl || "",
    };
    _debugLog(
      "[AutoDOM SW] aiProviderSettings updated:",
      JSON.stringify({
        source: aiProviderSettings.source,
        hasApiKey: !!aiProviderSettings.apiKey,
        apiKeyLen: aiProviderSettings.apiKey.length,
        model: aiProviderSettings.model,
        baseUrl: aiProviderSettings.baseUrl,
      }),
    );

    chrome.storage.local.set(
      {
        aiProviderSource: aiProviderSettings.source,
        aiProviderApiKey: aiProviderSettings.apiKey,
        aiProviderModel: aiProviderSettings.model,
        aiProviderBaseUrl: aiProviderSettings.baseUrl,
      },
      () => {
        _debugLog(
          "[AutoDOM SW] Provider settings persisted to chrome.storage.local",
        );
      },
    );

    sendResponse({
      success: true,
      provider: {
        source: aiProviderSettings.source,
        apiKey: aiProviderSettings.apiKey,
        model: aiProviderSettings.model,
        baseUrl: aiProviderSettings.baseUrl,
      },
      statusText:
        aiProviderSettings.source === "ide"
          ? isConnected
            ? "Using IDE Agent over MCP"
            : "IDE Agent selected — connect MCP to enable full AI"
          : aiProviderSettings.apiKey
            ? `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} ready${aiProviderSettings.model ? ` · ${aiProviderSettings.model}` : ""}`
            : `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} selected — add API key to enable direct AI`,
    });

    chrome.runtime.sendMessage({
      type: "AI_PROVIDER_STATUS",
      provider: {
        source: aiProviderSettings.source,
        apiKey: aiProviderSettings.apiKey,
        model: aiProviderSettings.model,
        baseUrl: aiProviderSettings.baseUrl,
      },
      statusText:
        aiProviderSettings.source === "ide"
          ? isConnected
            ? "Using IDE Agent over MCP"
            : "IDE Agent selected — connect MCP to enable full AI"
          : aiProviderSettings.apiKey
            ? `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} ready${aiProviderSettings.model ? ` · ${aiProviderSettings.model}` : ""}`
            : `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} selected — add API key to enable direct AI`,
    });

    return false;
  }
  // ─── Chat Panel Tool Calls ─────────────────────────────────
  // The in-browser chat panel (content script) sends tool calls here.
  // We execute them through the same TOOL_HANDLERS dispatch map and
  // return the result directly. This resets the inactivity timer too,
  // keeping the session alive while the user interacts via chat.
  // NOTE: Tool handlers execute locally via chrome.scripting/tabs APIs,
  // they do NOT require the MCP bridge server to be connected.
  // ─── Confirm/Cancel Submit Actions ─────────────────────────
  if (message.type === "CONFIRM_SUBMIT_ACTION") {
    const pending = pendingSubmitConfirmations.get(message.confirmId);
    if (!pending) {
      sendResponse({
        error: `No pending confirmation with id ${message.confirmId}`,
      });
      return false;
    }
    pendingSubmitConfirmations.delete(message.confirmId);
    (async () => {
      try {
        const handler = TOOL_HANDLERS.get(pending.tool);
        if (!handler) {
          sendResponse({ error: `Unknown tool: ${pending.tool}` });
          return;
        }
        const result = await handler(pending.params);
        sendResponse({ confirmed: true, tool: pending.tool, result });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "CANCEL_SUBMIT_ACTION") {
    const pending = pendingSubmitConfirmations.get(message.confirmId);
    if (!pending) {
      sendResponse({
        error: `No pending confirmation with id ${message.confirmId}`,
      });
      return false;
    }
    pendingSubmitConfirmations.delete(message.confirmId);
    sendResponse({ cancelled: true, tool: pending.tool });
    return false;
  }

  if (message.type === "GET_GUARDRAILS_STATUS") {
    sendResponse({
      rateLimiting: {
        enabled: rateLimitConfig.enabled,
        maxCallsPerDomain: rateLimitConfig.maxCallsPerDomain,
        windowMs: rateLimitConfig.windowMs,
        activeDomains: domainCallLog.size,
      },
      confirmBeforeSubmit: {
        enabled: confirmBeforeSubmitConfig.enabled,
        pendingConfirmations: pendingSubmitConfirmations.size,
      },
    });
    return false;
  }

  if (message.type === "UPDATE_GUARDRAILS") {
    if (message.rateLimitConfig !== undefined) {
      rateLimitConfig = { ...rateLimitConfig, ...message.rateLimitConfig };
      chrome.storage.local.set({ rateLimitConfig });
    }
    if (message.confirmBeforeSubmit !== undefined) {
      confirmBeforeSubmitConfig.enabled = !!message.confirmBeforeSubmit;
      chrome.storage.local.set({
        confirmBeforeSubmitConfig: { enabled: !!message.confirmBeforeSubmit },
      });
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "GET_TOOL_LOGS") {
    (async () => {
      const extensionLogs = _swToolErrorLog.slice();
      let serverLogs = [];
      let logFile = null;

      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        try {
          const serverData = await new Promise((resolve) => {
            _pendingToolLogResolve = resolve;
            ws.send(JSON.stringify({ type: "GET_TOOL_LOGS" }));
            setTimeout(() => {
              if (_pendingToolLogResolve === resolve) {
                _pendingToolLogResolve = null;
                resolve({ serverLogs: [], logFile: null });
              }
            }, 3000);
          });
          serverLogs = serverData.serverLogs || [];
          logFile = serverData.logFile || null;
        } catch (_) {}
      }

      sendResponse({ extensionLogs, serverLogs, logFile });
    })();
    return true;
  }

  if (message.type === "CHAT_TOOL_CALL") {
    const { tool, params, requestId } = message;
    _debugLog(
      "[AutoDOM SW] CHAT_TOOL_CALL received:",
      tool,
      "reqId:",
      requestId,
    );
    touchToolActivity(); // Reset inactivity timer

    const handler = TOOL_HANDLERS.get(tool);
    if (!handler) {
      _debugWarn("[AutoDOM SW] Unknown tool:", tool);
      sendResponse({ error: `Unknown tool: ${tool}`, requestId });
      return false;
    }

    // Execute the tool asynchronously and send result back
    (async () => {
      try {
        _debugLog("[AutoDOM SW] Executing tool:", tool);
        const result = await handler(params || {});
        _debugLog(
          "[AutoDOM SW] Tool result for",
          tool,
          ":",
          result ? (result.error ? "ERROR" : "OK") : "null",
        );
        if (result && result.error) _swLogToolError(tool, result.error);
        sendResponse(result);
      } catch (err) {
        _debugError("[AutoDOM SW] Tool exception:", tool, err.message);
        _swLogToolError(tool, err);
        sendResponse({ error: err.message || String(err), requestId });
      }
    })();
    return true; // Keep the message channel open for async sendResponse
  }

  // ─── AI Chat Message Handler ─────────────────────────────
  // Routes natural language messages from the in-browser chat panel.
  //
  // For direct providers (OpenAI, Anthropic, Ollama) the service worker
  // calls the provider API itself — NO bridge server needed.
  //
  // For IDE/MCP mode the request is forwarded through the WebSocket
  // bridge so the IDE agent can handle it.
  if (message.type === "CHAT_AI_MESSAGE") {
    const { text, context, conversationHistory, provider } = message;
    _debugLog(
      "[AutoDOM SW] CHAT_AI_MESSAGE received, text:",
      (text || "").substring(0, 80),
    );
    touchToolActivity(); // Reset inactivity timer

    // Resolve provider from incoming message OR saved settings.
    const providerType =
      (typeof provider === "string"
        ? provider
        : provider?.type || provider?.provider || provider?.source || null) ||
      aiProviderSettings.source ||
      "ide";

    const hasDirectKey =
      (providerType === "openai" || providerType === "gpt") &&
      !!(aiProviderSettings.apiKey || "").trim();
    const hasDirectAnthropic =
      (providerType === "anthropic" || providerType === "claude") &&
      !!(aiProviderSettings.apiKey || "").trim();
    const isOllama = providerType === "ollama";
    const isDirectProvider = hasDirectKey || hasDirectAnthropic || isOllama;

    _debugLog(
      "[AutoDOM SW] CHAT_AI_MESSAGE: providerType =",
      providerType,
      "| isDirectProvider =",
      isDirectProvider,
      "| aiProviderSettings =",
      JSON.stringify({
        source: aiProviderSettings.source,
        hasKey: !!(aiProviderSettings.apiKey || "").trim(),
        keyLen: (aiProviderSettings.apiKey || "").length,
        model: aiProviderSettings.model,
        baseUrl: aiProviderSettings.baseUrl,
      }),
    );

    // ─── Direct Provider Path (no bridge server needed) ──────
    // Service worker calls OpenAI / Anthropic / Ollama API directly.
    if (isDirectProvider) {
      _debugLog("[AutoDOM SW] Using DIRECT provider path for:", providerType);

      (async () => {
        try {
          const result = await _callDirectProvider(
            providerType,
            text,
            context || {},
            conversationHistory || [],
          );
          _debugLog(
            "[AutoDOM SW] Direct provider responded, length:",
            (result.response || "").length,
          );
          sendResponse({
            type: "AI_CHAT_RESPONSE",
            response: result.response,
            toolCalls: result.toolCalls || [],
            error: null,
          });
        } catch (err) {
          _debugError("[AutoDOM SW] Direct provider error:", err.message);
          sendResponse({
            type: "AI_CHAT_RESPONSE",
            error: `${providerType} error: ${err.message}`,
          });
        }
      })();

      return true; // Keep message channel open for async sendResponse
    }

    // ─── IDE / MCP Path (requires bridge server) ─────────────
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      _debugWarn(
        "[AutoDOM SW] CHAT_AI_MESSAGE: bridge unavailable for IDE mode",
      );
      sendResponse({
        fallback: true,
        error:
          "Not connected to MCP AI. Local tool commands still work.\n\n" +
          "Tip: Select a direct AI provider (GPT, Claude, or Ollama) in the extension settings to use AI chat without the bridge server.",
        type: "AI_CHAT_RESPONSE",
      });
      return false;
    }

    const aiRequestId = ++aiCallIdCounter;

    const aiMessage = {
      type: "AI_CHAT_REQUEST",
      id: aiRequestId,
      text: text,
      context: context || {},
      conversationHistory: conversationHistory || [],
      provider: providerType,
      providerConfig: {
        provider: aiProviderSettings.source || "ide",
      },
    };

    // Set up a pending response handler with timeout
    const aiTimeout = setTimeout(() => {
      if (pendingAiRequests.has(aiRequestId)) {
        const pending = pendingAiRequests.get(aiRequestId);
        pendingAiRequests.delete(aiRequestId);
        pending.resolve({
          type: "AI_CHAT_RESPONSE",
          error: "AI request timed out. The agent may be busy.",
        });
      }
    }, 60000); // 60s timeout for AI responses

    pendingAiRequests.set(aiRequestId, {
      resolve: (result) => {
        _debugLog(
          "[AutoDOM SW] AI response resolved for id:",
          aiRequestId,
          "hasError:",
          !!(result && result.error),
        );
        clearTimeout(aiTimeout);
        sendResponse(result);
      },
    });

    try {
      _debugLog(
        "[AutoDOM SW] Sending AI_CHAT_REQUEST to bridge, id:",
        aiRequestId,
      );
      ws.send(JSON.stringify(aiMessage));
    } catch (err) {
      clearTimeout(aiTimeout);
      pendingAiRequests.delete(aiRequestId);
      sendResponse({
        type: "AI_CHAT_RESPONSE",
        error: `Failed to send to AI: ${err.message}`,
      });
      return false;
    }

    return true; // Keep message channel open for async response
  }

  // ─── Toggle Chat Panel ────────────────────────────────────
  // Allow the popup or keyboard command to toggle the chat panel.
  // If MCP is connected, send the toggle to the content script.
  // If the content script is not injected yet, inject it first.
  if (message.type === "TOGGLE_CHAT_PANEL") {
    _debugLog(
      "[AutoDOM SW] TOGGLE_CHAT_PANEL received, isConnected:",
      isConnected,
    );
    (async () => {
      try {
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const tab = tabs[0];
        _debugLog(
          "[AutoDOM SW] Active tab:",
          tab ? tab.id + " - " + (tab.url || "").substring(0, 60) : "none",
        );
        if (tab && isInjectableTab(tab)) {
          // Try sending the toggle message to the content script
          try {
            _debugLog(
              "[AutoDOM SW] Sending TOGGLE_CHAT_PANEL to tab",
              tab.id,
              "mcpActive:",
              isConnected,
            );
            await chrome.tabs.sendMessage(tab.id, {
              type: "TOGGLE_CHAT_PANEL",
              mcpActive: isConnected,
            });
            _debugLog(
              "[AutoDOM SW] TOGGLE_CHAT_PANEL sent successfully to tab",
              tab.id,
            );
          } catch (_msgErr) {
            // Content script not injected yet — inject it, then retry
            _debugLog(
              "[AutoDOM SW] Content script not found (error:",
              _msgErr?.message,
              "), injecting into tab",
              tab.id,
            );
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content/session-border.js"],
              });
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content/chat-panel.js"],
              });
              // Small delay to let the content script initialize
              await new Promise((r) => setTimeout(r, 200));
              // Retry the toggle
              await chrome.tabs
                .sendMessage(tab.id, {
                  type: "TOGGLE_CHAT_PANEL",
                  mcpActive: isConnected,
                })
                .catch(() => {});
            } catch (injectErr) {
              _debugError(
                "[AutoDOM] Failed to inject content scripts:",
                injectErr,
              );
            }
          }
          // Also send MCP status so the chat panel knows the current state
          if (isConnected) {
            chrome.tabs
              .sendMessage(tab.id, {
                type: "MCP_STATUS_CHANGED",
                mcpActive: true,
              })
              .catch(() => {});
          }
        }
        sendResponse({ success: true, mcpActive: isConnected });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ─── User Action Recording ─────────────────────────────────
  // Record user interactions reported by content scripts into the session.
  if (message.type === "USER_ACTION") {
    if (sessionRecording.active) {
      const action = message.action;
      recordAction(
        action.type,
        action.type === "user_click"
          ? `Clicked ${action.tag}: "${action.text || ""}"`
          : action.type === "user_input"
            ? `Typed in ${action.tag} (${action.name || action.inputType})`
            : action.type === "user_submit"
              ? `Submitted form`
              : action.type,
        action,
        sender?.tab?.id,
        message.url,
      );
    }
    return false;
  }

  // Catch-all: return false for unhandled message types to prevent
  // "message port closed before a response was received" warnings.
  return false;
});

// ─── Pending AI Chat Requests ────────────────────────────────
// Stores pending AI chat requests waiting for responses from the bridge
const pendingAiRequests = new Map();
let aiCallIdCounter = 0;

function resolvePendingAiRequests(error) {
  for (const [id, pending] of pendingAiRequests.entries()) {
    pendingAiRequests.delete(id);
    try {
      pending.resolve({
        type: "AI_CHAT_RESPONSE",
        error,
      });
    } catch (_) {}
  }
}

function broadcastStatus(connected, log, logLevel) {
  chrome.runtime
    .sendMessage({
      type: "STATUS_UPDATE",
      connected,
      running: shouldRunMcp,
      log,
      logLevel,
    })
    .catch(() => {}); // popup may not be open

  // Also broadcast MCP status to all content scripts so chat panel
  // can show/hide itself based on MCP connection state
  broadcastMcpStatusToTabs(connected);
}

async function broadcastMcpStatusToTabs(connected) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, {
            type: "MCP_STATUS_CHANGED",
            mcpActive: connected,
          })
          .catch(() => {});
      }
    }
  } catch {}
}

// Send an explicit "MCP has fully stopped" message to all tabs.
// Unlike MCP_STATUS_CHANGED (which only demotes connection status),
// this forces chat-panel to call setMcpActive(false) and session-border
// to hide, even on non-active/background tabs.
async function broadcastMcpStopToAllTabs() {
  await broadcastToAllTabs([
    { type: "HIDE_SESSION_BORDER" },
    { type: "HIDE_CHAT_PANEL" },
    { type: "MCP_STATUS_CHANGED", mcpActive: false, mcpStopped: true },
  ]);
}

// ─── Tool Call Router ────────────────────────────────────────

// Tool dispatch map — O(1) lookup instead of a long switch statement.
// New tools only need one line added here instead of a case block.
const TOOL_HANDLERS = new Map([
  ["navigate", toolNavigate],
  ["click", toolClick],
  ["type_text", toolTypeText],
  ["take_screenshot", toolScreenshot],
  ["take_snapshot", toolSnapshot],
  ["evaluate_script", toolEvaluateScript],
  ["fill_form", toolFillForm],
  ["hover", toolHover],
  ["press_key", toolPressKey],
  ["get_page_info", toolGetPageInfo],
  ["wait_for_text", toolWaitForText],
  ["query_elements", toolQueryElements],
  ["extract_text", toolExtractText],
  ["get_network_requests", toolGetNetworkRequests],
  ["get_console_logs", toolGetConsoleLogs],
  ["list_tabs", toolListTabs],
  ["switch_tab", toolSwitchTab],
  ["wait_for_new_tab", toolWaitForNewTab],
  ["close_tab", toolCloseTab],
  ["scroll", toolScroll],
  ["select_option", toolSelectOption],
  ["wait_for_element", toolWaitForElement],
  ["wait_for_navigation", toolWaitForNavigation],
  ["handle_dialog", toolHandleDialog],
  ["get_cookies", toolGetCookies],
  ["set_cookie", toolSetCookie],
  ["get_storage", toolGetStorage],
  ["set_storage", toolSetStorage],
  ["get_html", toolGetHtml],
  ["set_attribute", toolSetAttribute],
  ["check_element_state", toolCheckElementState],
  ["drag_and_drop", toolDragAndDrop],
  ["right_click", toolRightClick],
  ["execute_async_script", toolExecuteAsyncScript],
  ["set_viewport", toolSetViewport],
  ["open_new_tab", toolOpenNewTab],
  ["wait_for_network_idle", toolWaitForNetworkIdle],
  ["start_recording", toolStartRecording],
  ["stop_recording", toolStopRecording],
  ["get_recording", toolGetRecording],
  ["get_session_summary", toolGetSessionSummary],
  ["emulate", toolEmulate],
  ["upload_file", toolUploadFile],
  ["performance_start_trace", toolPerformanceStartTrace],
  ["performance_stop_trace", toolPerformanceStopTrace],
  ["performance_analyze_insight", toolPerformanceAnalyzeInsight],
  // ─── Token-Efficient Tools ─────────────────────────────────
  ["execute_code", toolExecuteCode],
  ["get_dom_state", toolGetDomState],
  ["click_by_index", toolClickByIndex],
  ["type_by_index", toolTypeByIndex],
  ["extract_data", toolExtractData],
  // ─── Popup / Window Tools ──────────────────────────────────
  ["list_popups", toolListPopups],
  ["switch_to_popup", toolSwitchToPopup],
  ["close_popup", toolClosePopup],
  ["wait_for_popup", toolWaitForPopup],
  // ─── iframe Tools ──────────────────────────────────────────
  ["list_iframes", toolListIframes],
  ["iframe_interact", toolIframeInteract],
  // ─── Shadow DOM Tools ──────────────────────────────────────
  ["list_shadow_roots", toolListShadowRoots],
  ["shadow_interact", toolShadowInteract],
  ["deep_query", toolDeepQuery],
]);

async function handleToolCall(tool, params, id) {
  // Reset inactivity timer on every real tool call
  touchToolActivity();

  // ─── Per-Domain Rate Limiting ────────────────────────────
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const domain = getDomainFromTab(tab);
    const rateCheck = checkRateLimit(domain);
    if (!rateCheck.allowed) {
      _debugWarn(`[AutoDOM] Rate limit blocked: ${tool} on ${domain}`);
      return {
        error: rateCheck.error,
        rateLimited: true,
        domain: rateCheck.domain,
        callsInWindow: rateCheck.callsInWindow,
        budget: rateCheck.budget,
        resetInMs: rateCheck.resetInMs,
      };
    }
  } catch (rlErr) {
    // Don't block tool execution if rate limiting itself fails
    _debugWarn("[AutoDOM] Rate limit check failed:", rlErr.message);
  }

  // ─── Confirm-Before-Submit Check ─────────────────────────
  const sensitiveCheck = isSensitiveAction(tool, params);
  if (sensitiveCheck) {
    const confirmId = ++submitConfirmIdCounter;
    pendingSubmitConfirmations.set(confirmId, {
      tool,
      params,
      id,
      reason: sensitiveCheck.reason,
      timestamp: Date.now(),
    });
    // Auto-expire after 5 minutes
    setTimeout(() => pendingSubmitConfirmations.delete(confirmId), 300000);

    _debugWarn(
      `[AutoDOM] Sensitive action held: ${tool} (confirmId=${confirmId})`,
    );
    return {
      confirmRequired: true,
      confirmId,
      tool,
      reason: sensitiveCheck.reason,
      message: `⚠️ Sensitive action detected: ${sensitiveCheck.reason}. This action requires confirmation. Call with confirmId=${confirmId} to proceed.`,
      params,
    };
  }

  try {
    const handler = TOOL_HANDLERS.get(tool);
    if (!handler) return { error: `Unknown tool: ${tool}` };
    return await handler(params);
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Helper: Get active tab ──────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab;
}

// Inject and execute a function in the active tab's content script context
async function executeInTab(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
      world: "MAIN", // access page's JS context
    });
    if (results && results[0]) {
      if (results[0].error) {
        throw new Error(results[0].error.message || "Script execution error");
      }
      return results[0].result;
    }
    return null;
  } catch (err) {
    // Provide a clearer error for common injection failures
    if (err.message && err.message.includes("Cannot access")) {
      throw new Error(
        `Cannot inject script into this page (chrome:// or extension pages are restricted): ${err.message}`,
      );
    }
    throw err;
  }
}

// ─── Tool Implementations ────────────────────────────────────

// 1. Navigate
async function toolNavigate(params) {
  const tab = await getActiveTab();
  const { url, action } = params;

  if (action === "back") {
    await chrome.tabs.goBack(tab.id);
    return { success: true, action: "back" };
  }
  if (action === "forward") {
    await chrome.tabs.goForward(tab.id);
    return { success: true, action: "forward" };
  }
  if (action === "reload") {
    await chrome.tabs.reload(tab.id);
    return { success: true, action: "reload" };
  }
  if (url) {
    await chrome.tabs.update(tab.id, { url });
    // Wait a bit for navigation to start
    await new Promise((r) => setTimeout(r, 1500));
    const updatedTab = await chrome.tabs.get(tab.id);
    return { success: true, url: updatedTab.url, title: updatedTab.title };
  }
  return { error: "Provide url or action (back/forward/reload)" };
}

// 2. Click
async function toolClick(params) {
  const tab = await getActiveTab();
  const { selector, text, dblClick } = params;
  return await executeInTab(
    tab.id,
    (selector, text, dblClick) => {
      let el;
      if (selector) {
        el = document.querySelector(selector);
      } else if (text) {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim().includes(text)) {
            el = walker.currentNode.parentElement;
            break;
          }
        }
      }
      if (!el) return { error: `Element not found: ${selector || text}` };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const eventType = dblClick ? "dblclick" : "click";
      el.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      el.click();
      return {
        success: true,
        tag: el.tagName,
        text: el.textContent?.substring(0, 100),
      };
    },
    [selector ?? null, text ?? null, dblClick ?? false],
  );
}

// 3. Type text
async function toolTypeText(params) {
  const tab = await getActiveTab();
  const { selector, text, clearFirst } = params;
  return await executeInTab(
    tab.id,
    (selector, text, clearFirst) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `Element not found: ${selector}` };
      el.focus();
      if (clearFirst) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      // Set value and fire events
      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set ||
        Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, (clearFirst ? "" : el.value) + text);
      } else {
        el.value = (clearFirst ? "" : el.value) + text;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, value: el.value };
    },
    [selector, text, clearFirst || false],
  );
}

// 4. Screenshot
async function toolScreenshot(params) {
  const tab = await getActiveTab();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params?.format || "png",
      quality: params?.quality || 80,
    });
    return { success: true, screenshot: dataUrl };
  } catch (err) {
    return { error: `Screenshot failed: ${err.message}` };
  }
}

// 5. Take snapshot (DOM/a11y tree)
async function toolSnapshot(params) {
  const tab = await getActiveTab();
  return await executeInTab(
    tab.id,
    (maxDepth) => {
      function buildTree(node, depth = 0) {
        if (depth > maxDepth) return null;
        const result = {
          tag: node.tagName?.toLowerCase() || "#text",
          text:
            node.nodeType === Node.TEXT_NODE
              ? node.textContent?.trim().substring(0, 200)
              : undefined,
        };

        // Attributes for elements
        if (node.nodeType === Node.ELEMENT_NODE) {
          const attrs = {};
          if (node.id) attrs.id = node.id;
          if (node.className && typeof node.className === "string")
            attrs.class = node.className.substring(0, 100);
          if (node.getAttribute("role")) attrs.role = node.getAttribute("role");
          if (node.getAttribute("aria-label"))
            attrs["aria-label"] = node.getAttribute("aria-label");
          if (node.getAttribute("href")) attrs.href = node.getAttribute("href");
          if (node.getAttribute("src")) attrs.src = node.getAttribute("src");
          if (node.getAttribute("type")) attrs.type = node.getAttribute("type");
          if (node.getAttribute("name")) attrs.name = node.getAttribute("name");
          if (node.getAttribute("value"))
            attrs.value = node.getAttribute("value");
          if (node.getAttribute("placeholder"))
            attrs.placeholder = node.getAttribute("placeholder");
          if (Object.keys(attrs).length) result.attrs = attrs;

          // Visible text for leaf elements
          if (node.children.length === 0 && node.textContent?.trim()) {
            result.text = node.textContent.trim().substring(0, 200);
          }

          // Children
          const children = [];
          for (const child of node.children) {
            const skip = ["SCRIPT", "STYLE", "NOSCRIPT", "SVG"];
            if (skip.includes(child.tagName)) continue;
            const childTree = buildTree(child, depth + 1);
            if (childTree) children.push(childTree);
          }
          if (children.length) result.children = children;
        }

        return result;
      }

      return {
        title: document.title,
        url: location.href,
        tree: buildTree(document.body, 0),
      };
    },
    [params?.maxDepth || 6],
  );
}

// 6. Evaluate Script
async function toolEvaluateScript(params) {
  const tab = await getActiveTab();
  const { script } = params;
  return await executeInTab(
    tab.id,
    (script) => {
      try {
        const fn = new Function(script);
        const result = fn();
        return { success: true, result: JSON.parse(JSON.stringify(result)) };
      } catch (err) {
        return { error: err.message };
      }
    },
    [script],
  );
}

// 7. Fill form
async function toolFillForm(params) {
  const tab = await getActiveTab();
  const { fields } = params; // [{selector, value}]
  return await executeInTab(
    tab.id,
    (fields) => {
      const results = [];
      for (const field of fields) {
        const el = document.querySelector(field.selector);
        if (!el) {
          results.push({ selector: field.selector, error: "Not found" });
          continue;
        }
        el.focus();
        if (el.tagName === "SELECT") {
          el.value = field.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.value = field.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        results.push({ selector: field.selector, success: true });
      }
      return { success: true, results };
    },
    [fields],
  );
}

// 8. Hover
async function toolHover(params) {
  const tab = await getActiveTab();
  const { selector } = params;
  return await executeInTab(
    tab.id,
    (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `Element not found: ${selector}` };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
      );
      return { success: true, tag: el.tagName };
    },
    [selector],
  );
}

// 9. Press key
async function toolPressKey(params) {
  const tab = await getActiveTab();
  const { key, selector } = params;
  return await executeInTab(
    tab.id,
    (key, selector) => {
      const target = selector
        ? document.querySelector(selector)
        : document.activeElement || document.body;
      if (!target) return { error: "No target element" };

      // Parse key combo (e.g. "Control+A")
      const parts = key.split("+");
      const mainKey = parts.pop();
      const modifiers = {
        ctrlKey: parts.includes("Control") || parts.includes("Ctrl"),
        shiftKey: parts.includes("Shift"),
        altKey: parts.includes("Alt"),
        metaKey: parts.includes("Meta") || parts.includes("Cmd"),
      };

      const keyEventProps = {
        key: mainKey,
        code: `Key${mainKey.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      };

      target.dispatchEvent(new KeyboardEvent("keydown", keyEventProps));
      target.dispatchEvent(new KeyboardEvent("keypress", keyEventProps));
      target.dispatchEvent(new KeyboardEvent("keyup", keyEventProps));

      return { success: true, key };
    },
    [key, selector || null],
  );
}

// 10. Get page info
async function toolGetPageInfo(params) {
  const tab = await getActiveTab();
  const moreInfo = await executeInTab(
    tab.id,
    () => {
      const metas = {};
      document.querySelectorAll("meta").forEach((m) => {
        const name = m.getAttribute("name") || m.getAttribute("property");
        if (name) metas[name] = m.getAttribute("content");
      });
      return {
        title: document.title,
        url: location.href,
        metas,
        lang: document.documentElement.lang,
        readyState: document.readyState,
        forms: document.forms.length,
        links: document.links.length,
        images: document.images.length,
      };
    },
    [],
  );
  return { ...moreInfo, tabId: tab.id, windowId: tab.windowId };
}

// 11. Wait for text
async function toolWaitForText(params) {
  const tab = await getActiveTab();
  const { text, timeout } = params;
  const maxWait = timeout || 10000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const found = await executeInTab(
      tab.id,
      (text) => {
        return document.body.innerText.includes(text);
      },
      [text],
    );
    if (found)
      return { success: true, found: true, elapsed: Date.now() - startTime };
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    success: false,
    found: false,
    error: `Text "${text}" not found within ${maxWait}ms`,
  };
}

// 12. Query elements
async function toolQueryElements(params) {
  const tab = await getActiveTab();
  const { selector, limit } = params;
  return await executeInTab(
    tab.id,
    (selector, limit) => {
      const els = document.querySelectorAll(selector);
      const maxItems = Math.min(limit || 20, els.length);
      const items = [];
      for (let i = 0; i < maxItems; i++) {
        const el = els[i];
        items.push({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 200),
          id: el.id || undefined,
          className: el.className || undefined,
          href: el.getAttribute("href") || undefined,
          src: el.getAttribute("src") || undefined,
          value: el.value || undefined,
          visible: el.offsetParent !== null,
        });
      }
      return { count: els.length, items };
    },
    [selector, limit || 20],
  );
}

// 13. Extract text
async function toolExtractText(params) {
  const tab = await getActiveTab();
  const { selector } = params;
  return await executeInTab(
    tab.id,
    (selector) => {
      if (selector) {
        const el = document.querySelector(selector);
        if (!el) return { error: `Element not found: ${selector}` };
        return { text: el.innerText };
      }
      return { text: document.body.innerText };
    },
    [selector || null],
  );
}

// 14. Get network requests (basic — from captured data)
async function toolGetNetworkRequests(params) {
  // Note: We capture via performance API, not debugger for simplicity
  const tab = await getActiveTab();
  return await executeInTab(
    tab.id,
    (limit) => {
      const entries = performance.getEntriesByType("resource").slice(-limit);
      return {
        requests: entries.map((e) => ({
          name: e.name,
          type: e.initiatorType,
          duration: Math.round(e.duration),
          size: e.transferSize || 0,
          startTime: Math.round(e.startTime),
        })),
      };
    },
    [params?.limit || 50],
  );
}

// 15. Get console logs (injected capture)
async function toolGetConsoleLogs(params) {
  const tab = await getActiveTab();
  // Inject a console capture if not already done
  return await executeInTab(
    tab.id,
    () => {
      // If we haven't already patched console, do it now
      if (!window.__bmcp_console_logs) {
        window.__bmcp_console_logs = [];
        const orig = {};
        ["log", "warn", "error", "info", "debug"].forEach((level) => {
          orig[level] = console[level];
          console[level] = function (...args) {
            window.__bmcp_console_logs.push({
              level,
              message: args
                .map((a) => {
                  try {
                    return typeof a === "string" ? a : JSON.stringify(a);
                  } catch {
                    return String(a);
                  }
                })
                .join(" "),
              timestamp: Date.now(),
            });
            if (window.__bmcp_console_logs.length > 200) {
              window.__bmcp_console_logs.shift();
            }
            orig[level].apply(console, args);
          };
        });
        return {
          logs: [],
          note: "Console capture installed. Logs will be available on next call.",
        };
      }
      return { logs: window.__bmcp_console_logs.slice(-50) };
    },
    [],
  );
}

// ─── Tab Management Tools ────────────────────────────────────

// 16. List all tabs
async function toolListTabs(params) {
  const queryOpts = {};
  if (params?.currentWindow !== false) queryOpts.currentWindow = true;
  const tabs = await chrome.tabs.query(queryOpts);
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      index: t.index,
      title: t.title,
      url: t.url,
      active: t.active,
      status: t.status,
      windowId: t.windowId,
    })),
    count: tabs.length,
  };
}

// 17. Switch to a tab by ID or index
async function toolSwitchTab(params) {
  const { tabId, index } = params;
  let targetTab;
  if (tabId) {
    targetTab = await chrome.tabs.get(tabId);
  } else if (typeof index === "number") {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    targetTab = tabs[index];
  }
  if (!targetTab) return { error: "Tab not found" };
  await chrome.tabs.update(targetTab.id, { active: true });
  await chrome.windows.update(targetTab.windowId, { focused: true });
  return {
    success: true,
    tabId: targetTab.id,
    title: targetTab.title,
    url: targetTab.url,
  };
}

// 18. Wait for a new tab to open (e.g. after clicking a link with target=_blank)
async function toolWaitForNewTab(params) {
  const timeout = params?.timeout || 10000;
  const existingTabs = await chrome.tabs.query({});
  const existingIds = new Set(existingTabs.map((t) => t.id));

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onCreated.removeListener(listener);
        resolve({
          success: false,
          error: `No new tab opened within ${timeout}ms`,
        });
      }
    }, timeout);

    const listener = async (tab) => {
      if (!existingIds.has(tab.id) && !resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.tabs.onCreated.removeListener(listener);
        // Wait a moment for the tab to load
        await new Promise((r) => setTimeout(r, 1500));
        const updatedTab = await chrome.tabs.get(tab.id);
        // Optionally switch to the new tab
        if (params?.switchTo !== false) {
          await chrome.tabs.update(tab.id, { active: true });
        }
        resolve({
          success: true,
          newTab: {
            id: updatedTab.id,
            title: updatedTab.title,
            url: updatedTab.url,
            status: updatedTab.status,
          },
        });
      }
    };
    chrome.tabs.onCreated.addListener(listener);
  });
}

// 19. Close a tab
async function toolCloseTab(params) {
  const { tabId } = params;
  if (!tabId) return { error: "tabId is required" };
  try {
    await chrome.tabs.remove(tabId);
    return { success: true, closedTabId: tabId };
  } catch (err) {
    return { error: `Failed to close tab: ${err.message}` };
  }
}

// ─── Additional Tools (20–35) ───────────────────────────────

// 20. Scroll
async function toolScroll(params) {
  const tab = await getActiveTab();
  const { direction, amount, selector, behavior } = params;
  return await executeInTab(
    tab.id,
    (direction, amount, selector, behavior) => {
      const target = selector ? document.querySelector(selector) : window;
      if (selector && !target)
        return { error: `Element not found: ${selector}` };
      const scrollBehavior = behavior || "smooth";

      if (selector && direction === "into_view") {
        target.scrollIntoView({ behavior: scrollBehavior, block: "center" });
        return { success: true, action: "scrollIntoView" };
      }

      const px = amount || 500;
      const opts = { behavior: scrollBehavior };
      if (direction === "up") opts.top = -px;
      else if (direction === "down") opts.top = px;
      else if (direction === "left") opts.left = -px;
      else if (direction === "right") opts.left = px;
      else if (direction === "top") {
        (selector ? target : window).scrollTo({
          top: 0,
          behavior: scrollBehavior,
        });
        return { success: true };
      } else if (direction === "bottom") {
        const el = selector ? target : document.documentElement;
        (selector ? target : window).scrollTo({
          top: el.scrollHeight,
          behavior: scrollBehavior,
        });
        return { success: true };
      }

      (selector ? target : window).scrollBy(opts);
      return {
        success: true,
        scrollY: window.scrollY,
        scrollX: window.scrollX,
      };
    },
    [direction ?? "down", amount ?? 500, selector ?? null, behavior ?? "smooth"],
  );
}

// 21. Select option from <select>
async function toolSelectOption(params) {
  const tab = await getActiveTab();
  const { selector, value, text, index } = params;
  return await executeInTab(
    tab.id,
    (selector, value, text, index) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `Element not found: ${selector}` };
      if (el.tagName !== "SELECT")
        return { error: "Element is not a <select>" };

      let found = false;
      for (const opt of el.options) {
        if (
          (value !== undefined && opt.value === value) ||
          (text !== undefined && opt.text === text) ||
          (index !== undefined && opt.index === index)
        ) {
          el.value = opt.value;
          found = true;
          break;
        }
      }
      if (!found) return { error: "Option not found" };
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        success: true,
        selectedValue: el.value,
        selectedText: el.options[el.selectedIndex].text,
      };
    },
    [selector, value ?? null, text ?? null, index ?? null],
  );
}

// 22. Wait for element (CSS selector)
async function toolWaitForElement(params) {
  const tab = await getActiveTab();
  const { selector, state, timeout } = params;
  const maxWait = timeout || 10000;
  const startTime = Date.now();
  const desiredState = state || "visible"; // visible | hidden | attached | detached

  while (Date.now() - startTime < maxWait) {
    const check = await executeInTab(
      tab.id,
      (selector, desiredState) => {
        const el = document.querySelector(selector);
        if (desiredState === "attached") return !!el;
        if (desiredState === "detached") return !el;
        if (desiredState === "visible") return el && el.offsetParent !== null;
        if (desiredState === "hidden") return !el || el.offsetParent === null;
        return !!el;
      },
      [selector, desiredState],
    );
    if (check)
      return {
        success: true,
        elapsed: Date.now() - startTime,
        state: desiredState,
      };
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    success: false,
    error: `Element "${selector}" did not reach state "${desiredState}" within ${maxWait}ms`,
  };
}

// 23. Wait for navigation / page load
async function toolWaitForNavigation(params) {
  const tab = await getActiveTab();
  const timeout = params?.timeout || 15000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const updatedTab = await chrome.tabs.get(tab.id);
    if (updatedTab.status === "complete") {
      return {
        success: true,
        url: updatedTab.url,
        title: updatedTab.title,
        elapsed: Date.now() - startTime,
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    success: false,
    error: `Page did not finish loading within ${timeout}ms`,
  };
}

// 24. Handle browser dialog (alert/confirm/prompt)
// Note: Dialogs in Chrome extensions are tricky. We use chrome.debugger for this.
async function toolHandleDialog(params) {
  const tab = await getActiveTab();
  const { action, promptText } = params; // action: accept | dismiss
  try {
    await ensureDebugger(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");

    // Try to handle any existing dialog
    const handleParams = { accept: action !== "dismiss" };
    if (promptText) handleParams.promptText = promptText;
    await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "Page.handleJavaScriptDialog",
      handleParams,
    );
    return { success: true, action };
  } catch (err) {
    return { error: `Dialog handling failed: ${err.message}` };
  }
}

// 25. Get cookies
async function toolGetCookies(params) {
  const tab = await getActiveTab();
  const url = params?.url || tab.url;
  const cookies = await chrome.cookies.getAll({ url });
  return {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
    })),
    count: cookies.length,
  };
}

// 26. Set cookie
async function toolSetCookie(params) {
  const tab = await getActiveTab();
  const { name, value, domain, path, secure, httpOnly, expirationDate } =
    params;
  const url = params.url || tab.url;
  try {
    const cookie = await chrome.cookies.set({
      url,
      name,
      value,
      domain,
      path: path || "/",
      secure: secure || false,
      httpOnly: httpOnly || false,
      expirationDate: expirationDate || Date.now() / 1000 + 86400 * 365,
    });
    return { success: true, cookie };
  } catch (err) {
    return { error: `Set cookie failed: ${err.message}` };
  }
}

// 27. Get localStorage/sessionStorage
async function toolGetStorage(params) {
  const tab = await getActiveTab();
  const { type, key } = params; // type: local | session
  return await executeInTab(
    tab.id,
    (type, key) => {
      const store = type === "session" ? sessionStorage : localStorage;
      if (key) {
        return { key, value: store.getItem(key) };
      }
      const all = {};
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        all[k] = store.getItem(k);
      }
      return { entries: all, count: store.length };
    },
    [type || "local", key || null],
  );
}

// 28. Set localStorage/sessionStorage
async function toolSetStorage(params) {
  const tab = await getActiveTab();
  const { type, key, value, clear } = params;
  return await executeInTab(
    tab.id,
    (type, key, value, clear) => {
      const store = type === "session" ? sessionStorage : localStorage;
      if (clear) {
        store.clear();
        return { success: true, action: "cleared" };
      }
      if (key !== undefined) {
        if (value === null) {
          store.removeItem(key);
          return { success: true, action: "removed", key };
        }
        store.setItem(key, value);
        return { success: true, action: "set", key, value };
      }
      return { error: "Provide key/value or set clear=true" };
    },
    [type || "local", key, value, clear || false],
  );
}

// 29. Get HTML (innerHTML/outerHTML)
async function toolGetHtml(params) {
  const tab = await getActiveTab();
  const { selector, outer } = params;
  return await executeInTab(
    tab.id,
    (selector, outer) => {
      const el = selector
        ? document.querySelector(selector)
        : document.documentElement;
      if (!el) return { error: `Element not found: ${selector}` };
      return { html: outer ? el.outerHTML : el.innerHTML };
    },
    [selector || null, outer || false],
  );
}

// 30. Set attribute on element
async function toolSetAttribute(params) {
  const tab = await getActiveTab();
  const { selector, attribute, value } = params;
  return await executeInTab(
    tab.id,
    (selector, attribute, value) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `Element not found: ${selector}` };
      if (value === null || value === undefined) {
        el.removeAttribute(attribute);
        return { success: true, action: "removed", attribute };
      }
      el.setAttribute(attribute, value);
      return { success: true, attribute, value };
    },
    [selector, attribute, value],
  );
}

// 31. Check element state (visible, enabled, checked, etc.)
async function toolCheckElementState(params) {
  const tab = await getActiveTab();
  const { selector } = params;
  return await executeInTab(
    tab.id,
    (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { exists: false };
      const rect = el.getBoundingClientRect();
      return {
        exists: true,
        tag: el.tagName.toLowerCase(),
        visible: el.offsetParent !== null,
        enabled: !el.disabled,
        checked: el.checked ?? null,
        selected: el.selected ?? null,
        focused: document.activeElement === el,
        readonly: el.readOnly ?? null,
        required: el.required ?? null,
        value: el.value || null,
        text: el.textContent?.trim().substring(0, 200),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedDisplay: getComputedStyle(el).display,
        computedVisibility: getComputedStyle(el).visibility,
      };
    },
    [selector],
  );
}

// 32. Drag and drop
async function toolDragAndDrop(params) {
  const tab = await getActiveTab();
  const { sourceSelector, targetSelector } = params;
  return await executeInTab(
    tab.id,
    (sourceSelector, targetSelector) => {
      const source = document.querySelector(sourceSelector);
      const target = document.querySelector(targetSelector);
      if (!source) return { error: `Source not found: ${sourceSelector}` };
      if (!target) return { error: `Target not found: ${targetSelector}` };

      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();

      const dataTransfer = new DataTransfer();

      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: sourceRect.x + sourceRect.width / 2,
          clientY: sourceRect.y + sourceRect.height / 2,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: targetRect.x + targetRect.width / 2,
          clientY: targetRect.y + targetRect.height / 2,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: targetRect.x + targetRect.width / 2,
          clientY: targetRect.y + targetRect.height / 2,
        }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: targetRect.x + targetRect.width / 2,
          clientY: targetRect.y + targetRect.height / 2,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );

      return { success: true };
    },
    [sourceSelector, targetSelector],
  );
}

// 33. Right-click (context menu)
async function toolRightClick(params) {
  const tab = await getActiveTab();
  const { selector } = params;
  return await executeInTab(
    tab.id,
    (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { error: `Element not found: ${selector}` };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
        }),
      );
      return { success: true, tag: el.tagName };
    },
    [selector],
  );
}

// 34. Execute async script (with await support)
async function toolExecuteAsyncScript(params) {
  const tab = await getActiveTab();
  const { script } = params;
  return await executeInTab(
    tab.id,
    async (script) => {
      try {
        const fn = new Function("return (async () => { " + script + " })()");
        const result = await fn();
        return {
          success: true,
          result: JSON.parse(JSON.stringify(result ?? null)),
        };
      } catch (err) {
        return { error: err.message };
      }
    },
    [script],
  );
}

// 35. Set viewport / window size
async function toolSetViewport(params) {
  const tab = await getActiveTab();
  const { width, height } = params;
  try {
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, {
      width:
        width +
        (win.width - (await executeInTab(tab.id, () => window.innerWidth, []))),
      height:
        height +
        (win.height -
          (await executeInTab(tab.id, () => window.innerHeight, []))),
    });
    return { success: true, width, height };
  } catch (err) {
    return { error: `Set viewport failed: ${err.message}` };
  }
}

// 36. Open a new tab
async function toolOpenNewTab(params) {
  const { url, active } = params;
  try {
    const tab = await chrome.tabs.create({ url, active: active !== false });
    await new Promise((r) => setTimeout(r, 1000));
    const updatedTab = await chrome.tabs.get(tab.id);
    return {
      success: true,
      tabId: updatedTab.id,
      url: updatedTab.url,
      title: updatedTab.title,
    };
  } catch (err) {
    return { error: `Open tab failed: ${err.message}` };
  }
}

// 37. Wait for network idle
async function toolWaitForNetworkIdle(params) {
  const tab = await getActiveTab();
  const timeout = params?.timeout || 10000;
  const idleTime = params?.idleTime || 500;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check via Performance API — if no new resources loaded in idleTime ms
    const pending = await executeInTab(
      tab.id,
      (idleTime) => {
        const entries = performance.getEntriesByType("resource");
        if (entries.length === 0) return false;
        const lastEntry = entries[entries.length - 1];
        const timeSinceLast =
          performance.now() - (lastEntry.startTime + lastEntry.duration);
        return timeSinceLast < idleTime;
      },
      [idleTime],
    );

    if (!pending) {
      return { success: true, elapsed: Date.now() - startTime };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    success: false,
    error: `Network did not become idle within ${timeout}ms`,
  };
}

// ─── Session Recording Tools ─────────────────────────────────

// 38. Start recording
async function toolStartRecording(params) {
  sessionRecording = {
    active: true,
    startTime: Date.now(),
    actions: [],
    maxActions: params?.maxActions || 1000,
  };
  // Inject user-interaction tracker into active tab
  const tab = await getActiveTab();
  try {
    await injectInteractionTracker(tab.id);
  } catch {}
  recordAction("recording_started", "Session recording started");
  return { success: true, startTime: sessionRecording.startTime };
}

// 39. Stop recording
async function toolStopRecording(params) {
  if (!sessionRecording.active)
    return { success: false, error: "No active recording" };
  recordAction("recording_stopped", "Session recording stopped");
  sessionRecording.active = false;
  const duration = Date.now() - sessionRecording.startTime;
  return {
    success: true,
    duration,
    actionCount: sessionRecording.actions.length,
  };
}

// 40. Get recording (full action log)
async function toolGetRecording(params) {
  const { last } = params || {};
  const actions = last
    ? sessionRecording.actions.slice(-last)
    : sessionRecording.actions;
  return {
    active: sessionRecording.active,
    startTime: sessionRecording.startTime,
    actionCount: sessionRecording.actions.length,
    actions,
  };
}

// 41. Get session summary (human-readable case summary)
async function toolGetSessionSummary(params) {
  if (sessionRecording.actions.length === 0) {
    return { summary: "No actions recorded yet.", steps: [] };
  }

  const duration =
    (sessionRecording.active
      ? Date.now()
      : sessionRecording.actions[sessionRecording.actions.length - 1]
          .timestamp) - sessionRecording.startTime;
  const uniqueUrls = [
    ...new Set(sessionRecording.actions.filter((a) => a.url).map((a) => a.url)),
  ];

  // Build human-readable steps
  const steps = [];
  let stepNum = 1;
  for (const action of sessionRecording.actions) {
    // Skip internal events for summary
    if (["recording_started", "recording_stopped"].includes(action.type))
      continue;
    const time = new Date(action.timestamp).toLocaleTimeString("en-US", {
      hour12: false,
    });
    let step = "";
    switch (action.type) {
      case "navigation":
        step = `Navigated to "${action.details?.title || action.details?.url || "page"}"`;
        break;
      case "tab_switch":
        step = `Switched to tab: "${action.details?.title || "untitled"}"`;
        break;
      case "tab_created":
        step = `Opened new tab`;
        break;
      case "tab_closed":
        step = `Closed tab`;
        break;
      case "tool_call":
        step = `[Agent] ${action.description}`;
        break;
      case "user_click":
        step = `Clicked on ${action.details?.tag || "element"}: "${action.details?.text || ""}"`;
        break;
      case "user_input":
        if (action.details?.sensitive) {
          step = `Typed in ${action.details?.tag || "input"} (credentials — redacted)`;
        } else {
          step = `Typed "${action.details?.value || "..."}" in ${action.details?.tag || "input"}`;
        }
        break;
      case "user_submit":
        step = `Submitted form`;
        break;
      default:
        step = action.description;
    }
    steps.push({ step: stepNum++, time, action: step, url: action.url });
  }

  const summary = [
    `Session Summary`,
    `Duration: ${Math.round(duration / 1000)}s`,
    `Total actions: ${sessionRecording.actions.length}`,
    `Pages visited: ${uniqueUrls.length}`,
    ``,
    `Steps:`,
    ...steps.map((s) => `  ${s.step}. [${s.time}] ${s.action}`),
  ].join("\n");

  return { summary, steps, duration, pageCount: uniqueUrls.length };
}

// ─── Inject User Interaction Tracker ─────────────────────────
// This injects a tracker into the page that reports user clicks and inputs
// back to the service worker (with sensitive data filtering)

async function injectInteractionTracker(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (window.__bmcp_tracker_installed) return;
      window.__bmcp_tracker_installed = true;

      const SENSITIVE_TYPES = [
        "password",
        "credit-card",
        "cc-number",
        "cc-exp",
        "cc-csc",
      ];
      const SENSITIVE_NAMES = [
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "ssn",
        "cvv",
        "cvc",
        "pin",
        "credit_card",
        "cc_number",
        "card_number",
        "creditcard",
        "cardnumber",
      ];

      function isSensitive(el) {
        const type = (el.type || "").toLowerCase();
        const name = (el.name || "").toLowerCase();
        const autocomplete = (el.autocomplete || "").toLowerCase();
        if (SENSITIVE_TYPES.includes(type) || type === "password") return true;
        if (SENSITIVE_NAMES.some((s) => name.includes(s))) return true;
        if (autocomplete.includes("password") || autocomplete.includes("cc-"))
          return true;
        return false;
      }

      // Track clicks
      document.addEventListener(
        "click",
        (e) => {
          const el = e.target;
          window.postMessage(
            {
              __bmcp: true,
              type: "user_click",
              tag: el.tagName?.toLowerCase(),
              text: el.textContent?.trim().substring(0, 100),
              id: el.id,
              className: (el.className || "").toString().substring(0, 50),
            },
            "*",
          );
        },
        true,
      );

      // Track form inputs (debounced)
      let inputTimer = null;
      document.addEventListener(
        "input",
        (e) => {
          clearTimeout(inputTimer);
          inputTimer = setTimeout(() => {
            const el = e.target;
            const sensitive = isSensitive(el);
            window.postMessage(
              {
                __bmcp: true,
                type: "user_input",
                tag: el.tagName?.toLowerCase(),
                inputType: el.type,
                name: el.name,
                value: sensitive ? "[REDACTED]" : el.value?.substring(0, 100),
                sensitive,
              },
              "*",
            );
          }, 500);
        },
        true,
      );

      // Track form submissions
      document.addEventListener(
        "submit",
        (e) => {
          window.postMessage(
            {
              __bmcp: true,
              type: "user_submit",
              formAction: e.target.action,
              formMethod: e.target.method,
            },
            "*",
          );
        },
        true,
      );
    },
  });

  // Listen for messages from the injected tracker
  chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      window.addEventListener("message", (e) => {
        if (e.data?.__bmcp) {
          chrome.runtime.sendMessage({
            type: "USER_ACTION",
            action: e.data,
            url: location.href,
          });
        }
      });
    },
  });
}

// (USER_ACTION listener merged into the main onMessage handler above)

// ─── Record tool calls into session ──────────────────────────
// Wrap handleToolCall to also record agent actions
const _originalHandleToolCall = handleToolCall;
// We patch it inline via the existing handleToolCall since it's referenced by name

// Hook: record every tool call into session
async function handleToolCallWithRecording(tool, params, id) {
  // Record the tool call (filter sensitive params)
  const safeParams = { ...params };
  if (safeParams.text && tool === "type_text") {
    // Check if typing into a sensitive field
    if (
      safeParams.selector &&
      /password|passwd|pwd|secret|token|pin|cvv|cvc|ssn|credit/i.test(
        safeParams.selector,
      )
    ) {
      safeParams.text = "[REDACTED]";
    }
  }
  recordAction(
    "tool_call",
    `${tool}(${JSON.stringify(safeParams).substring(0, 150)})`,
    safeParams,
    null,
    null,
  );
  return handleToolCall(tool, params, id);
}

// ─── Session Border Helpers ──────────────────────────────────

// Helper: check if a tab URL is injectable (not a restricted browser page)
function isInjectableTab(tab) {
  return (
    tab.url &&
    !tab.url.startsWith("chrome://") &&
    !tab.url.startsWith("chrome-extension://") &&
    !tab.url.startsWith("about:") &&
    !tab.url.startsWith("edge://") &&
    !tab.url.startsWith("brave://") &&
    !tab.url.startsWith("devtools://")
  );
}

async function showBorderOnAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, { type: "SHOW_SESSION_BORDER" })
          .catch(() => {});
      }
    }
  } catch {}
}

async function hideBorderOnAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, { type: "HIDE_SESSION_BORDER" })
          .catch(() => {});
      }
    }
  } catch {}
}

async function showChatPanelOnAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, { type: "SHOW_CHAT_PANEL" })
          .catch(() => {});
      }
    }
  } catch {}
}

async function hideChatPanelOnAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, { type: "HIDE_CHAT_PANEL" })
          .catch(() => {});
      }
    }
  } catch {}
}

// Combined broadcast to avoid multiple chrome.tabs.query calls
async function broadcastToAllTabs(messages) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        for (const msg of messages) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
    }
  } catch {}
}

// Show border and chat panel on new tabs when MCP is connected
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isConnected && isInjectableTab(tab)) {
    chrome.tabs
      .sendMessage(tabId, { type: "SHOW_SESSION_BORDER" })
      .catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "SHOW_CHAT_PANEL" }).catch(() => {});
  }
});

// ─── Keyboard Command Handlers ───────────────────────────────
// Handle manifest-registered keyboard shortcuts (Ctrl+Shift+K, Ctrl+Shift+L)
// These fire even when no popup/page is focused, unlike content-script listeners.
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !isInjectableTab(tab)) return;

    if (command === "toggle-chat-panel") {
      chrome.tabs
        .sendMessage(tab.id, {
          type: "TOGGLE_CHAT_PANEL",
          mcpActive: isConnected,
        })
        .catch(() => {});
    }

    if (command === "toggle-inline-ai") {
      chrome.tabs
        .sendMessage(tab.id, {
          type: "TOGGLE_INLINE_AI",
          mcpActive: isConnected,
        })
        .catch(() => {});
    }
  } catch (err) {
    _debugError("[AutoDOM] Command handler error:", err);
  }
});

// ─── Auto-connect on service worker startup ──────────────────
// The extension auto-connects on startup only when the user explicitly
// enables auto-connect in the popup.

let autoConnectInterval = null;
let autoConnectPort = null;
let _autoConnectAttempt = 0;
let _startupRestoreOnly = false;

function startAutoConnect(port) {
  const nextPort = port || getCurrentPort();
  wsPort = nextPort;
  if (autoConnectInterval && autoConnectPort === nextPort) return;
  stopAutoConnect();
  autoConnectPort = nextPort;
  _autoConnectAttempt = 0;
  const tryConnect = () => {
    if (!shouldRunMcp || isConnected || _sessionTimedOut) return;
    _autoConnectAttempt++;
    // Only log every 6th attempt to reduce console spam
    if (_autoConnectAttempt === 1 || _autoConnectAttempt % 6 === 0) {
      _debugLog(
        `[AutoDOM] Auto-connect: trying ws://127.0.0.1:${nextPort}... (attempt ${_autoConnectAttempt})`,
      );
    }
    connectWebSocket(nextPort);
    // Exponential backoff: 3s, 6s, 12s, max 30s
    const nextDelay = Math.min(
      3000 * Math.pow(2, _autoConnectAttempt - 1),
      30000,
    );
    autoConnectInterval = setTimeout(tryConnect, nextDelay);
  };
  tryConnect();
}

function stopAutoConnect() {
  if (autoConnectInterval) {
    clearTimeout(autoConnectInterval);
    autoConnectInterval = null;
  }
  autoConnectPort = null;
}

// Restore desired state on service worker load.
// Only the explicit auto-connect preference survives worker restarts.
chrome.storage.local.get(
  [
    "mcpPort",
    "autoConnect",
    "mcpRunning",
    "aiProviderSource",
    "aiProviderApiKey",
    "aiProviderModel",
    "aiProviderBaseUrl",
  ],
  (result) => {
    const port = result.mcpPort || 9876;
    const autoConnect = result.autoConnect === true;
    autoConnectEnabled = autoConnect;
    autoConnectFallbackTried = false;
    wsPort = port;
    _requestedPort = port;
    lastConnectedPort =
      Number(result.mcpLastConnectedPort || result.serverPort || port) || port;
    shouldRunMcp = autoConnect;
    _startupRestoreOnly = autoConnect;

    aiProviderSettings = {
      source: result.aiProviderSource || "ide",
      apiKey: result.aiProviderApiKey || "",
      model: result.aiProviderModel || "",
      baseUrl: result.aiProviderBaseUrl || "",
    };

    _debugLog(
      "[AutoDOM SW] Startup: loaded provider settings from storage:",
      JSON.stringify({
        source: aiProviderSettings.source,
        hasApiKey: !!aiProviderSettings.apiKey,
        apiKeyLen: aiProviderSettings.apiKey.length,
        model: aiProviderSettings.model,
        baseUrl: aiProviderSettings.baseUrl,
      }),
    );

    // If a direct provider is configured, log that bridge isn't needed for chat
    if (
      aiProviderSettings.source !== "ide" &&
      aiProviderSettings.source !== "mcp"
    ) {
      _debugLog(
        "[AutoDOM SW] Direct AI provider configured:",
        aiProviderSettings.source,
        "— chat will call provider API directly (no bridge needed)",
      );
    }

    chrome.storage.local.set({ mcpRunning: shouldRunMcp });
    if (shouldRunMcp) {
      startAutoConnect(port);
    } else {
      stopAutoConnect();
    }
  },
);

// Also auto-connect on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    ["mcpPort", "autoConnect", "mcpRunning"],
    (result) => {
      const port = result.mcpPort || 9876;
      const autoConnect =
        typeof result.autoConnect === "boolean" ? result.autoConnect : false;
      const initialRunning = autoConnect;

      shouldRunMcp = initialRunning;
      autoConnectFallbackTried = false;
      _startupRestoreOnly = false;
      wsPort = port;
      _requestedPort = port;
      lastConnectedPort =
        Number(result.mcpLastConnectedPort || result.serverPort || port) ||
        port;
      chrome.storage.local.set({
        mcpPort: port,
        autoConnect,
        mcpRunning: initialRunning,
      });
      if (initialRunning) {
        startAutoConnect(port);
      } else {
        stopAutoConnect();
      }
    },
  );
});
// ─── Emulation & Performance Tools (Advanced) ────────────────

// Track which tabs have an active debugger session to avoid double-attach
const _debuggerAttached = new Set();

async function ensureDebugger(tabId) {
  if (IS_FIREFOX) {
    throw new Error(
      "This tool uses Chrome DevTools Protocol (CDP) which is not supported in Firefox. " +
        "Please use Chrome or Edge for this feature.",
    );
  }
  if (_debuggerAttached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    _debuggerAttached.add(tabId);
    // Clean up when debugger is detached (manually or by Chrome)
    const onDetach = (source) => {
      if (source.tabId === tabId) {
        _debuggerAttached.delete(tabId);
        chrome.debugger.onDetach.removeListener(onDetach);
      }
    };
    chrome.debugger.onDetach.addListener(onDetach);
  } catch (err) {
    // If already attached, just track it
    if (err.message && err.message.includes("Already attached")) {
      _debuggerAttached.add(tabId);
    } else {
      throw new Error(
        `Failed to attach debugger to tab ${tabId}: ${err.message}`,
      );
    }
  }
}

// 42. Emulate device / features
async function toolEmulate({ userAgent, viewport, colorScheme }) {
  const tab = await getActiveTab();
  const tabId = tab.id;
  await ensureDebugger(tabId);
  if (userAgent) {
    await chrome.debugger.sendCommand(
      { tabId },
      "Emulation.setUserAgentOverride",
      { userAgent },
    );
  }
  if (viewport) {
    await chrome.debugger.sendCommand(
      { tabId },
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor || 1,
        mobile: viewport.isMobile || false,
      },
    );
  }
  if (colorScheme) {
    const preferred = colorScheme === "auto" ? "no-preference" : colorScheme;
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: preferred }],
    });
  }
  return { success: true, note: "Emulation settings applied." };
}

// 43. Upload File
async function toolUploadFile({ uid, filePath }) {
  const tab = await getActiveTab();
  const tabId = tab.id;
  await ensureDebugger(tabId);
  const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `document.querySelector('${uid.replace(/'/g, "\\'")}') || document.querySelector('[__bmcp_uid="${uid.replace(/"/g, '\\"')}"]');`,
  });

  if (
    !res.result ||
    res.result.type === "undefined" ||
    res.result.subtype === "null"
  ) {
    throw new Error(`File input element not found for selector/uid: ${uid}`);
  }

  const nodeRes = await chrome.debugger.sendCommand(
    { tabId },
    "DOM.requestNode",
    { objectId: res.result.objectId },
  );
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    files: [filePath],
    backendNodeId: nodeRes.nodeId,
  });
  return { success: true, note: `File uploaded to element ${uid}` };
}

// 44. Start Trace
async function toolPerformanceStartTrace({ reload }) {
  const tab = await getActiveTab();
  const tabId = tab.id;
  await ensureDebugger(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Tracing.start", {
    categories:
      "-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline",
    transferMode: "ReturnAsStream",
  });
  if (reload) {
    await chrome.tabs.reload(tabId);
  }
  return { success: true, note: "Performance trace started." };
}

// 45. Stop Trace
async function toolPerformanceStopTrace({ filePath }) {
  const tab = await getActiveTab();
  const tabId = tab.id;
  await ensureDebugger(tabId);
  return new Promise((resolve, reject) => {
    let eventCount = 0;
    const tracingListener = (source, method, params) => {
      if (source.tabId === tabId && method === "Tracing.dataCollected") {
        eventCount += params.value.length;
      }
      if (source.tabId === tabId && method === "Tracing.tracingComplete") {
        chrome.debugger.onEvent.removeListener(tracingListener);
        resolve({
          success: true,
          traceEventsCaptured: eventCount,
          note: "Trace stopped. Data stream completed.",
        });
      }
    };
    chrome.debugger.onEvent.addListener(tracingListener);
    chrome.debugger.sendCommand({ tabId }, "Tracing.end").catch(reject);
  });
}

// 46. Analyze Performance Insight
async function toolPerformanceAnalyzeInsight({ insightName, insightSetId }) {
  return {
    insightName,
    insightSetId,
    status:
      "Performance insight analysis requires deep DevTools Lighthouse integration. Returning placeholder metadata.",
    note: "For full analysis, load the generated trace file directly into the Chrome DevTools Performance panel.",
  };
}

// ─── Token-Efficient Tool Implementations ────────────────────
// Inspired by OpenBrowser-AI's single execute_code tool and compact
// DOM state approach. These reduce token usage by 3-6x by returning
// only what the LLM actually needs instead of full page dumps.

// execute_code: Run arbitrary JS in page context, return only extracted data
async function toolExecuteCode(params) {
  const tab = await getActiveTab();
  const { code, timeout } = params;
  const timeoutMs = timeout || 15000;

  return await executeInTab(
    tab.id,
    (code, timeoutMs) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ error: `Code execution timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        try {
          // Wrap in async IIFE so the code can use await
          const wrapped = `(async () => { ${code} })()`;
          const result = eval(wrapped);

          // Handle promise results (async code)
          if (result && typeof result.then === "function") {
            result
              .then((val) => {
                clearTimeout(timer);
                try {
                  resolve({
                    success: true,
                    result: JSON.parse(JSON.stringify(val)),
                  });
                } catch (e) {
                  resolve({ success: true, result: String(val) });
                }
              })
              .catch((err) => {
                clearTimeout(timer);
                resolve({ error: err.message || String(err) });
              });
          } else {
            clearTimeout(timer);
            try {
              resolve({
                success: true,
                result: JSON.parse(JSON.stringify(result)),
              });
            } catch (e) {
              resolve({ success: true, result: String(result) });
            }
          }
        } catch (err) {
          clearTimeout(timer);
          resolve({ error: err.message || String(err) });
        }
      });
    },
    [code, timeoutMs],
  );
}

// get_dom_state: Compact map of interactive elements with numeric indices.
// Returns ~2-5K chars instead of 500K+ for full snapshots.
async function toolGetDomState(params) {
  const tab = await getActiveTab();
  const includeHidden = params?.includeHidden || false;
  const maxElements = params?.maxElements || 200;

  const result = await executeInTab(
    tab.id,
    (includeHidden, maxElements) => {
      const INTERACTIVE_SELECTORS = [
        "a[href]",
        "button",
        'input:not([type="hidden"])',
        "textarea",
        "select",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[role="slider"]',
        '[role="textbox"]',
        "[onclick]",
        "[tabindex]",
        "[contenteditable]",
        "details > summary",
      ];

      const seen = new Set();
      const elements = [];
      const allEls = document.querySelectorAll(INTERACTIVE_SELECTORS.join(","));

      for (const el of allEls) {
        if (seen.has(el)) continue;
        seen.add(el);

        // Skip hidden elements unless requested
        if (!includeHidden) {
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          )
            continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
        }

        // Skip elements inside <script>, <style>, <noscript>
        if (el.closest("script, style, noscript")) continue;

        const tag = el.tagName.toLowerCase();
        const entry = { tag };

        // Text content (compact)
        const text = (el.textContent || "").trim().substring(0, 80);
        if (text) entry.text = text;

        // Key attributes — only include if present
        const type = el.getAttribute("type");
        if (type) entry.type = type;

        const name = el.getAttribute("name");
        if (name) entry.name = name;

        const placeholder = el.getAttribute("placeholder");
        if (placeholder) entry.placeholder = placeholder;

        const href = el.getAttribute("href");
        if (href) entry.href = href.substring(0, 120);

        const role = el.getAttribute("role");
        if (role) entry.role = role;

        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) entry.ariaLabel = ariaLabel;

        const value = el.value;
        if (value && tag !== "a") entry.value = String(value).substring(0, 80);

        const id = el.id;
        if (id) entry.id = id;

        // Unique CSS selector for fallback
        if (id) {
          entry.selector = `#${CSS.escape(id)}`;
        } else if (name) {
          entry.selector = `${tag}[name="${CSS.escape(name)}"]`;
        }

        elements.push(entry);
        if (elements.length >= maxElements) break;
      }

      // Build compact indexed map
      const indexed = {};
      for (let i = 0; i < elements.length; i++) {
        indexed[i] = elements[i];
      }

      return {
        title: document.title,
        url: location.href,
        elementCount: elements.length,
        elements: indexed,
      };
    },
    [includeHidden, maxElements],
  );

  // Cache the index map for click_by_index / type_by_index
  if (result && result.elements) {
    _indexedElements = result.elements;
    _indexedTabId = tab.id;
  }

  return result;
}

// click_by_index: Click element by numeric index from get_dom_state
async function toolClickByIndex(params) {
  const tab = await getActiveTab();
  const { index, dblClick } = params;

  return await executeInTab(
    tab.id,
    (index, dblClick, includeHidden) => {
      // Re-discover interactive elements in the same order as get_dom_state
      const INTERACTIVE_SELECTORS = [
        "a[href]",
        "button",
        'input:not([type="hidden"])',
        "textarea",
        "select",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[role="slider"]',
        '[role="textbox"]',
        "[onclick]",
        "[tabindex]",
        "[contenteditable]",
        "details > summary",
      ];

      const seen = new Set();
      const allEls = document.querySelectorAll(INTERACTIVE_SELECTORS.join(","));
      let currentIndex = 0;

      for (const el of allEls) {
        if (seen.has(el)) continue;
        seen.add(el);

        if (!includeHidden) {
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          )
            continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
        }
        if (el.closest("script, style, noscript")) continue;

        if (currentIndex === index) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const eventType = dblClick ? "dblclick" : "click";
          el.dispatchEvent(
            new MouseEvent(eventType, {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );
          el.click();
          return {
            success: true,
            index,
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().substring(0, 80),
          };
        }
        currentIndex++;
      }

      return {
        error: `No element found at index ${index}. Run get_dom_state to refresh indices.`,
      };
    },
    [index, dblClick || false, false],
  );
}

// type_by_index: Type text into element by numeric index from get_dom_state
async function toolTypeByIndex(params) {
  const tab = await getActiveTab();
  const { index, text, clearFirst } = params;

  return await executeInTab(
    tab.id,
    (index, text, clearFirst) => {
      const INTERACTIVE_SELECTORS = [
        "a[href]",
        "button",
        'input:not([type="hidden"])',
        "textarea",
        "select",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[role="slider"]',
        '[role="textbox"]',
        "[onclick]",
        "[tabindex]",
        "[contenteditable]",
        "details > summary",
      ];

      const seen = new Set();
      const allEls = document.querySelectorAll(INTERACTIVE_SELECTORS.join(","));
      let currentIndex = 0;

      for (const el of allEls) {
        if (seen.has(el)) continue;
        seen.add(el);

        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        )
          continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (el.closest("script, style, noscript")) continue;

        if (currentIndex === index) {
          el.focus();
          if (clearFirst) {
            el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const nativeInputValueSetter =
            Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value",
            )?.set ||
            Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              "value",
            )?.set;
          const newValue = (clearFirst ? "" : el.value || "") + text;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, newValue);
          } else {
            el.value = newValue;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            success: true,
            index,
            tag: el.tagName.toLowerCase(),
            value: el.value,
          };
        }
        currentIndex++;
      }

      return {
        error: `No element found at index ${index}. Run get_dom_state to refresh indices.`,
      };
    },
    [index, text, clearFirst || false],
  );
}

// extract_data: Extract structured data using CSS selector + field mapping
async function toolExtractData(params) {
  const tab = await getActiveTab();
  const { selector, fields, limit } = params;
  const maxItems = limit || 50;

  return await executeInTab(
    tab.id,
    (selector, fields, maxItems) => {
      const containers = document.querySelectorAll(selector);
      const data = [];

      for (let i = 0; i < Math.min(containers.length, maxItems); i++) {
        const container = containers[i];
        const item = {};
        for (const [fieldName, subSelector] of Object.entries(fields)) {
          if (subSelector === ".") {
            // Use container's own text
            item[fieldName] = (container.textContent || "").trim();
          } else {
            const el = container.querySelector(subSelector);
            if (el) {
              // Prefer href/src/value over text for links/images/inputs
              if (el.tagName === "A" && el.href) {
                item[fieldName] = el.href;
              } else if (el.tagName === "IMG" && el.src) {
                item[fieldName] = el.src;
              } else if (el.value !== undefined && el.value !== "") {
                item[fieldName] = el.value;
              } else {
                item[fieldName] = (el.textContent || "").trim();
              }
            } else {
              item[fieldName] = null;
            }
          }
        }
        data.push(item);
      }

      return {
        success: true,
        count: data.length,
        totalMatches: containers.length,
        data,
      };
    },
    [selector, fields, maxItems],
  );
}

// ─── Popup / Window Tools ────────────────────────────────────

// List all browser windows including popups opened via window.open
async function toolListPopups(params) {
  const allWindows = await chrome.windows.getAll({ populate: true });
  const windows = [];
  for (const win of allWindows) {
    const tabs = (win.tabs || []).map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
    }));
    windows.push({
      windowId: win.id,
      type: win.type, // "normal", "popup", "panel", "app", "devtools"
      state: win.state,
      focused: win.focused,
      width: win.width,
      height: win.height,
      top: win.top,
      left: win.left,
      tabCount: tabs.length,
      tabs,
    });
  }
  const popups = windows.filter((w) => w.type === "popup");
  return {
    totalWindows: windows.length,
    popupCount: popups.length,
    windows: params?.popupsOnly ? popups : windows,
  };
}

// Switch focus to a popup/window by windowId, optionally activate a specific tab
async function toolSwitchToPopup(params) {
  const { windowId, tabId } = params;
  if (!windowId) return { error: "windowId is required" };
  try {
    await chrome.windows.update(windowId, { focused: true });
    if (tabId) {
      await chrome.tabs.update(tabId, { active: true });
    } else {
      // Activate the first tab in the window
      const tabs = await chrome.tabs.query({ windowId });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
      }
    }
    const win = await chrome.windows.get(windowId, { populate: true });
    const activeTab = (win.tabs || []).find((t) => t.active);
    return {
      success: true,
      windowId,
      type: win.type,
      activeTab: activeTab
        ? { id: activeTab.id, title: activeTab.title, url: activeTab.url }
        : null,
    };
  } catch (err) {
    return { error: `Failed to switch to window: ${err.message}` };
  }
}

// Close a popup/window by windowId
async function toolClosePopup(params) {
  const { windowId } = params;
  if (!windowId) return { error: "windowId is required" };
  try {
    await chrome.windows.remove(windowId);
    return { success: true, closedWindowId: windowId };
  } catch (err) {
    return { error: `Failed to close window: ${err.message}` };
  }
}

// Wait for a new popup/window to appear
async function toolWaitForPopup(params) {
  const timeout = params?.timeout || 10000;
  const existingWindows = await chrome.windows.getAll();
  const existingIds = new Set(existingWindows.map((w) => w.id));

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.windows.onCreated.removeListener(listener);
        resolve({
          success: false,
          error: `No new popup/window opened within ${timeout}ms`,
        });
      }
    }, timeout);

    const listener = async (win) => {
      if (!existingIds.has(win.id) && !resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.windows.onCreated.removeListener(listener);
        // Wait for the window to fully load
        await new Promise((r) => setTimeout(r, 1500));
        const updatedWin = await chrome.windows.get(win.id, {
          populate: true,
        });
        // Optionally switch focus to the new popup
        if (params?.switchTo !== false) {
          await chrome.windows.update(win.id, { focused: true });
        }
        const activeTab = (updatedWin.tabs || []).find((t) => t.active);
        resolve({
          success: true,
          window: {
            windowId: updatedWin.id,
            type: updatedWin.type,
            state: updatedWin.state,
            width: updatedWin.width,
            height: updatedWin.height,
          },
          activeTab: activeTab
            ? { id: activeTab.id, title: activeTab.title, url: activeTab.url }
            : null,
        });
      }
    };
    chrome.windows.onCreated.addListener(listener);
  });
}

// ─── iframe Tools ────────────────────────────────────────────

// List all iframes on the current page with their frame IDs
async function toolListIframes(params) {
  const tab = await getActiveTab();
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  if (!frames) return { error: "Could not retrieve frames for this tab" };

  // Frame 0 is the main frame; the rest are sub-frames (iframes)
  const iframes = frames.filter((f) => f.frameId !== 0);

  // Also get DOM-level info about each iframe
  const domInfo = await executeInTab(
    tab.id,
    () => {
      const iframes = document.querySelectorAll("iframe");
      return Array.from(iframes).map((iframe, index) => ({
        index,
        src: iframe.src || "",
        id: iframe.id || undefined,
        name: iframe.name || undefined,
        title: iframe.title || undefined,
        width: iframe.offsetWidth,
        height: iframe.offsetHeight,
        visible: iframe.offsetParent !== null,
        sandbox: iframe.getAttribute("sandbox") || undefined,
      }));
    },
    [],
  );

  return {
    mainFrameUrl: tab.url,
    iframeCount: iframes.length,
    iframes: iframes.map((f, i) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url,
      ...(domInfo && domInfo[i] ? domInfo[i] : {}),
    })),
  };
}

// Execute an action inside a specific iframe
async function toolIframeInteract(params) {
  const tab = await getActiveTab();
  const { frameId, action, selector, text, value, fields, clearFirst } = params;

  if (frameId === undefined && !params.iframeSelector) {
    return { error: "Provide frameId (from list_iframes) or iframeSelector" };
  }

  let targetFrameId = frameId;

  // If iframeSelector is provided instead of frameId, resolve it
  if (targetFrameId === undefined && params.iframeSelector) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const iframeSrc = await executeInTab(
      tab.id,
      (sel) => {
        const iframe = document.querySelector(sel);
        return iframe ? iframe.src : null;
      },
      [params.iframeSelector],
    );
    if (!iframeSrc)
      return {
        error: `iframe not found with selector: ${params.iframeSelector}`,
      };
    const match = frames.find((f) => f.url === iframeSrc && f.frameId !== 0);
    if (!match)
      return { error: `Could not resolve frameId for iframe: ${iframeSrc}` };
    targetFrameId = match.frameId;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [targetFrameId] },
      world: "MAIN",
      func: (action, selector, text, value, fields, clearFirst) => {
        // click
        if (action === "click") {
          let el;
          if (selector) {
            el = document.querySelector(selector);
          } else if (text) {
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
            );
            while (walker.nextNode()) {
              if (walker.currentNode.textContent.trim().includes(text)) {
                el = walker.currentNode.parentElement;
                break;
              }
            }
          }
          if (!el)
            return { error: `Element not found in iframe: ${selector || text}` };
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );
          el.click();
          return {
            success: true,
            tag: el.tagName,
            text: el.textContent?.substring(0, 100),
          };
        }

        // type
        if (action === "type") {
          const el = document.querySelector(selector);
          if (!el)
            return { error: `Element not found in iframe: ${selector}` };
          el.focus();
          if (clearFirst) {
            el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const nativeSetter =
            Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value",
            )?.set ||
            Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              "value",
            )?.set;
          const newVal = (clearFirst ? "" : el.value || "") + value;
          if (nativeSetter) {
            nativeSetter.call(el, newVal);
          } else {
            el.value = newVal;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, value: el.value };
        }

        // query — find elements
        if (action === "query") {
          const els = document.querySelectorAll(selector);
          const limit = 20;
          const items = [];
          for (let i = 0; i < Math.min(limit, els.length); i++) {
            const el = els[i];
            items.push({
              tag: el.tagName.toLowerCase(),
              text: el.textContent?.trim().substring(0, 200),
              id: el.id || undefined,
              className: el.className || undefined,
              href: el.getAttribute("href") || undefined,
              value: el.value || undefined,
              visible: el.offsetParent !== null,
            });
          }
          return { count: els.length, items };
        }

        // extract_text
        if (action === "extract_text") {
          if (selector) {
            const el = document.querySelector(selector);
            if (!el)
              return { error: `Element not found in iframe: ${selector}` };
            return { text: el.innerText };
          }
          return { text: document.body.innerText };
        }

        // fill_form
        if (action === "fill_form" && fields) {
          const results = [];
          for (const field of fields) {
            const el = document.querySelector(field.selector);
            if (!el) {
              results.push({ selector: field.selector, error: "Not found" });
              continue;
            }
            el.focus();
            if (el.tagName === "SELECT") {
              el.value = field.value;
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              el.value = field.value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
            results.push({ selector: field.selector, success: true });
          }
          return { success: true, results };
        }

        // get_dom_state inside iframe
        if (action === "get_dom_state") {
          const INTERACTIVE = [
            "a[href]",
            "button",
            'input:not([type="hidden"])',
            "textarea",
            "select",
            '[role="button"]',
            '[role="link"]',
            '[role="tab"]',
            '[role="menuitem"]',
            "[onclick]",
            "[tabindex]",
            "[contenteditable]",
          ];
          const seen = new Set();
          const elements = [];
          const allEls = document.querySelectorAll(INTERACTIVE.join(","));
          for (const el of allEls) {
            if (seen.has(el)) continue;
            seen.add(el);
            const style = window.getComputedStyle(el);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.opacity === "0"
            )
              continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (el.closest("script, style, noscript")) continue;
            const tag = el.tagName.toLowerCase();
            const entry = { tag };
            const t = (el.textContent || "").trim().substring(0, 80);
            if (t) entry.text = t;
            if (el.getAttribute("type")) entry.type = el.getAttribute("type");
            if (el.getAttribute("name")) entry.name = el.getAttribute("name");
            if (el.getAttribute("placeholder"))
              entry.placeholder = el.getAttribute("placeholder");
            if (el.getAttribute("href"))
              entry.href = el.getAttribute("href").substring(0, 120);
            if (el.id) entry.id = el.id;
            if (el.value && tag !== "a")
              entry.value = String(el.value).substring(0, 80);
            elements.push(entry);
            if (elements.length >= 200) break;
          }
          const indexed = {};
          for (let i = 0; i < elements.length; i++) indexed[i] = elements[i];
          return {
            title: document.title,
            url: location.href,
            elementCount: elements.length,
            elements: indexed,
          };
        }

        return { error: `Unknown iframe action: ${action}` };
      },
      args: [action, selector, text, value, fields, clearFirst || false],
    });

    if (results && results[0]) {
      if (results[0].error) {
        throw new Error(
          results[0].error.message || "Script execution error in iframe",
        );
      }
      return { ...results[0].result, frameId: targetFrameId };
    }
    return { error: "No result from iframe script execution" };
  } catch (err) {
    return { error: `iframe interaction failed: ${err.message}` };
  }
}

// ─── Shadow DOM Tools ────────────────────────────────────────

// List all elements that host an open shadow root
async function toolListShadowRoots(params) {
  const tab = await getActiveTab();
  return await executeInTab(
    tab.id,
    (maxDepth) => {
      const results = [];
      function findShadowHosts(root, path = "", depth = 0) {
        if (depth > maxDepth) return;
        const all = root.querySelectorAll("*");
        for (const el of all) {
          if (el.shadowRoot) {
            const hostInfo = {
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              className:
                typeof el.className === "string"
                  ? el.className.substring(0, 100)
                  : undefined,
              path: path || "document",
              childElementCount: el.shadowRoot.children.length,
              innerElementCount: el.shadowRoot.querySelectorAll("*").length,
              // Build a selector to reach this host
              selector: el.id
                ? `#${CSS.escape(el.id)}`
                : el.tagName.toLowerCase() +
                  (el.className
                    ? "." +
                      el.className
                        .toString()
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .join(".")
                    : ""),
            };
            results.push(hostInfo);
            // Recurse into nested shadow roots
            findShadowHosts(
              el.shadowRoot,
              (path ? path + " >>> " : "") + hostInfo.selector,
              depth + 1,
            );
          }
        }
      }
      findShadowHosts(document, "", 0);
      return { shadowRootCount: results.length, hosts: results };
    },
    [params?.maxDepth || 5],
  );
}

// Interact with elements inside shadow DOMs using piercing selector
// Piercing syntax: "host-selector >>> inner-selector" or nested "host1 >>> host2 >>> target"
async function toolShadowInteract(params) {
  const tab = await getActiveTab();
  const { piercingSelector, action, value, clearFirst, fields } = params;

  if (!piercingSelector) {
    return { error: "piercingSelector is required (e.g. 'my-component >>> .inner-button')" };
  }

  return await executeInTab(
    tab.id,
    (piercingSelector, action, value, clearFirst, fields) => {
      // Parse piercing selector: split on " >>> "
      const parts = piercingSelector.split(" >>> ").map((s) => s.trim());
      if (parts.length < 2) {
        return {
          error:
            "piercingSelector must contain at least one ' >>> ' separator (e.g. 'host >>> target')",
        };
      }

      // Traverse through shadow boundaries
      let currentRoot = document;
      for (let i = 0; i < parts.length - 1; i++) {
        const host = currentRoot.querySelector(parts[i]);
        if (!host) {
          return {
            error: `Shadow host not found: "${parts[i]}" at depth ${i}`,
          };
        }
        if (!host.shadowRoot) {
          return {
            error: `Element "${parts[i]}" does not have a shadow root (it may be closed)`,
          };
        }
        currentRoot = host.shadowRoot;
      }

      // Now find the target element in the deepest shadow root
      const targetSelector = parts[parts.length - 1];
      const el = currentRoot.querySelector(targetSelector);

      if (!el) {
        return {
          error: `Target element not found: "${targetSelector}" inside shadow root`,
        };
      }

      // Default action is "query" (just return info about the element)
      if (!action || action === "query") {
        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().substring(0, 200),
          id: el.id || undefined,
          className: el.className || undefined,
          visible: el.offsetParent !== null,
          value: el.value || undefined,
        };
      }

      if (action === "click") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
          }),
        );
        el.click();
        return {
          success: true,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().substring(0, 100),
        };
      }

      if (action === "type") {
        el.focus();
        if (clearFirst) {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        }
        const nativeSetter =
          Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set ||
          Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )?.set;
        const newVal = (clearFirst ? "" : el.value || "") + value;
        if (nativeSetter) {
          nativeSetter.call(el, newVal);
        } else {
          el.value = newVal;
        }
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return { success: true, value: el.value };
      }

      if (action === "extract_text") {
        return { success: true, text: el.innerText };
      }

      if (action === "query_all") {
        const els = currentRoot.querySelectorAll(targetSelector);
        const items = [];
        for (let i = 0; i < Math.min(20, els.length); i++) {
          items.push({
            tag: els[i].tagName.toLowerCase(),
            text: (els[i].textContent || "").trim().substring(0, 200),
            id: els[i].id || undefined,
            visible: els[i].offsetParent !== null,
            value: els[i].value || undefined,
          });
        }
        return { success: true, count: els.length, items };
      }

      if (action === "fill_form" && fields) {
        const results = [];
        for (const field of fields) {
          const fieldEl = currentRoot.querySelector(field.selector);
          if (!fieldEl) {
            results.push({ selector: field.selector, error: "Not found" });
            continue;
          }
          fieldEl.focus();
          if (fieldEl.tagName === "SELECT") {
            fieldEl.value = field.value;
            fieldEl.dispatchEvent(
              new Event("change", { bubbles: true, composed: true }),
            );
          } else {
            fieldEl.value = field.value;
            fieldEl.dispatchEvent(
              new Event("input", { bubbles: true, composed: true }),
            );
            fieldEl.dispatchEvent(
              new Event("change", { bubbles: true, composed: true }),
            );
          }
          results.push({ selector: field.selector, success: true });
        }
        return { success: true, results };
      }

      if (action === "get_dom_state") {
        const INTERACTIVE = [
          "a[href]",
          "button",
          'input:not([type="hidden"])',
          "textarea",
          "select",
          '[role="button"]',
          '[role="link"]',
          "[onclick]",
          "[tabindex]",
          "[contenteditable]",
        ];
        const seen = new Set();
        const elements = [];
        const allEls = currentRoot.querySelectorAll(INTERACTIVE.join(","));
        for (const el of allEls) {
          if (seen.has(el)) continue;
          seen.add(el);
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          )
            continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const tag = el.tagName.toLowerCase();
          const entry = { tag };
          const t = (el.textContent || "").trim().substring(0, 80);
          if (t) entry.text = t;
          if (el.getAttribute("type")) entry.type = el.getAttribute("type");
          if (el.getAttribute("name")) entry.name = el.getAttribute("name");
          if (el.getAttribute("placeholder"))
            entry.placeholder = el.getAttribute("placeholder");
          if (el.id) entry.id = el.id;
          if (el.value && tag !== "a")
            entry.value = String(el.value).substring(0, 80);
          elements.push(entry);
          if (elements.length >= 200) break;
        }
        const indexed = {};
        for (let i = 0; i < elements.length; i++) indexed[i] = elements[i];
        return { elementCount: elements.length, elements: indexed };
      }

      return { error: `Unknown shadow action: ${action}` };
    },
    [piercingSelector, action || "query", value, clearFirst || false, fields],
  );
}

// Deep query: search across main DOM, all iframes, and all shadow DOMs
async function toolDeepQuery(params) {
  const tab = await getActiveTab();
  const { selector, text, limit } = params;
  const maxItems = limit || 30;

  // 1. Search main document (including shadow DOMs)
  const mainResults = await executeInTab(
    tab.id,
    (selector, text, maxItems) => {
      const results = [];

      function searchInRoot(root, context) {
        if (selector) {
          const els = root.querySelectorAll(selector);
          for (let i = 0; i < Math.min(els.length, maxItems - results.length); i++) {
            results.push({
              context,
              tag: els[i].tagName.toLowerCase(),
              text: (els[i].textContent || "").trim().substring(0, 200),
              id: els[i].id || undefined,
              visible: els[i].offsetParent !== null,
              value: els[i].value || undefined,
            });
          }
        }
        if (text) {
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
          );
          while (walker.nextNode() && results.length < maxItems) {
            if (walker.currentNode.textContent.trim().includes(text)) {
              const parent = walker.currentNode.parentElement;
              if (parent) {
                results.push({
                  context,
                  tag: parent.tagName.toLowerCase(),
                  text: walker.currentNode.textContent.trim().substring(0, 200),
                  id: parent.id || undefined,
                  visible: parent.offsetParent !== null,
                });
              }
            }
          }
        }
        // Recurse into shadow roots
        if (results.length < maxItems) {
          const all = root.querySelectorAll("*");
          for (const el of all) {
            if (el.shadowRoot && results.length < maxItems) {
              const hostDesc =
                el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "");
              searchInRoot(
                el.shadowRoot,
                context + " >>> " + hostDesc,
              );
            }
          }
        }
      }

      searchInRoot(document, "main");
      return results;
    },
    [selector, text, maxItems],
  );

  // 2. Search inside iframes
  let iframeResults = [];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const iframes = (frames || []).filter((f) => f.frameId !== 0);

    for (const frame of iframes) {
      if (iframeResults.length + (mainResults || []).length >= maxItems) break;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frame.frameId] },
          world: "MAIN",
          func: (selector, text, maxItems) => {
            const results = [];
            if (selector) {
              const els = document.querySelectorAll(selector);
              for (
                let i = 0;
                i < Math.min(els.length, maxItems);
                i++
              ) {
                results.push({
                  tag: els[i].tagName.toLowerCase(),
                  text: (els[i].textContent || "").trim().substring(0, 200),
                  id: els[i].id || undefined,
                  visible: els[i].offsetParent !== null,
                  value: els[i].value || undefined,
                });
              }
            }
            if (text) {
              const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
              );
              while (walker.nextNode() && results.length < maxItems) {
                if (walker.currentNode.textContent.trim().includes(text)) {
                  const parent = walker.currentNode.parentElement;
                  if (parent) {
                    results.push({
                      tag: parent.tagName.toLowerCase(),
                      text: walker.currentNode.textContent
                        .trim()
                        .substring(0, 200),
                      id: parent.id || undefined,
                      visible: parent.offsetParent !== null,
                    });
                  }
                }
              }
            }
            return results;
          },
          args: [
            selector,
            text,
            maxItems - (mainResults || []).length - iframeResults.length,
          ],
        });
        if (results && results[0] && results[0].result) {
          for (const item of results[0].result) {
            iframeResults.push({
              ...item,
              context: `iframe[frameId=${frame.frameId}](${frame.url?.substring(0, 80)})`,
            });
          }
        }
      } catch {
        // Some frames may not be accessible (cross-origin without permissions)
      }
    }
  } catch {
    // webNavigation may fail on restricted pages
  }

  const allResults = [...(mainResults || []), ...iframeResults];
  return {
    totalFound: allResults.length,
    results: allResults.slice(0, maxItems),
  };
}
