/**
 * AutoDOM — Service Worker (Background Script)
 *
 * Manages the WebSocket connection to the MCP bridge server.
 * Routes tool calls from the server → content script → results back.
 * Uses chrome.scripting, chrome.tabs, and chrome.debugger APIs.
 */

// Load shared modules. importScripts() works in Chrome MV3 service workers
// (non-module workers); Firefox MV3 declares the same files in its
// manifest.firefox.json `background.scripts` array, so this call is a no-op
// because the scripts have already been evaluated globally.
try {
  if (typeof importScripts === "function" && !globalThis.AutoDOMProviders) {
    importScripts("providers.js");
  }
  if (typeof importScripts === "function" && !globalThis.AutoDOMAgent) {
    importScripts("agent-tools.js");
  }
  if (typeof importScripts === "function" && !globalThis.AutoDOMActionGate) {
    importScripts("action-gate.js");
  }
} catch (_) {
  // Already loaded (Firefox path) — ignore.
}

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

// API keys live in chrome.storage.session (RAM-only) so they are never
// persisted to disk. Falls back to chrome.storage.local on browsers that
// don't yet expose `session` storage. The non-secret provider settings
// (source, model, baseUrl) stay in chrome.storage.local so the user's
// choice survives a browser restart — only the secret has to be re-entered.
const secretStorage = (() => {
  try {
    return chrome.storage.session || chrome.storage.local;
  } catch (_) {
    return chrome.storage.local;
  }
})();
const _secretStorageIsSession =
  typeof chrome !== "undefined" &&
  chrome.storage &&
  chrome.storage.session &&
  secretStorage === chrome.storage.session;

function _readApiKey() {
  return new Promise((resolve) => {
    try {
      secretStorage.get(["aiProviderApiKey"], (r) =>
        resolve((r && r.aiProviderApiKey) || ""),
      );
    } catch (_) {
      resolve("");
    }
  });
}

function _writeApiKey(value) {
  try {
    secretStorage.set({ aiProviderApiKey: value || "" });
  } catch (_) {}
}

// ─── Pre-activation Provider Connection Test ────────────────
// Lightweight ping to verify a provider's credentials, base URL,
// and (where possible) model before the user enables direct AI.
//
// Returns { ok: bool, latencyMs: number, error?: string, detail?: string }.
//
// Strategy per protocol:
//   • openai-compatible: GET {base}/models. Falls back to a 1-token
//     chat.completions ping when /models returns 4xx (some Chinese
//     providers gate /models behind paid tiers but still allow chat).
//   • anthropic: POST {base}/v1/messages with max_tokens=1. There is
//     no public /models endpoint; this is the cheapest validating ping.
//   • ollama: GET {base}/api/tags; if a model is set, also verify it
//     exists in the returned tags (otherwise inference would 404).
//
// All requests are bounded by a short AbortController timeout so the
// popup never hangs.
async function _testProviderConnection(p) {
  const TEST_TIMEOUT_MS = 8000;
  const source = p?.source || "ide";
  const apiKey = (p?.apiKey || "").trim();
  const baseUrlRaw = (p?.baseUrl || "").trim();
  const model = (p?.model || "").trim();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    if (source === "openai" || source === "gpt") {
      if (!apiKey) return { ok: false, error: "Missing API key" };
      const base = (baseUrlRaw || "https://api.openai.com/v1").replace(
        /\/+$/,
        "",
      );
      // First try /models — cheap and proves auth.
      let resp = await fetch(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ac.signal,
      }).catch((e) => ({ _err: e }));

      if (resp && !resp._err && resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const count = Array.isArray(data?.data) ? data.data.length : 0;
        return {
          ok: true,
          latencyMs: Date.now() - t0,
          detail: `${count} models${model ? ` · ${model}` : ""}`,
        };
      }
      // Fallback: tiny chat-completions ping (handles providers that
      // 401/403 on /models but still serve /chat/completions).
      const pingModel = model || "gpt-4.1-mini";
      const ping = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: pingModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      if (ping.ok) {
        return {
          ok: true,
          latencyMs: Date.now() - t0,
          detail: `chat.completions OK · ${pingModel}`,
        };
      }
      const errText = await ping.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${ping.status}: ${errText.substring(0, 200) || ping.statusText}`,
      };
    }

    if (source === "anthropic" || source === "claude") {
      if (!apiKey) return { ok: false, error: "Missing API key" };
      const base = (baseUrlRaw || "https://api.anthropic.com").replace(
        /\/+$/,
        "",
      );
      const pingModel = model || "claude-3-5-haiku-latest";
      const resp = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: pingModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (resp.ok) {
        return {
          ok: true,
          latencyMs: Date.now() - t0,
          detail: `messages OK · ${pingModel}`,
        };
      }
      const errText = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${resp.status}: ${errText.substring(0, 200) || resp.statusText}`,
      };
    }

    if (source === "ollama") {
      const base = (baseUrlRaw || "http://localhost:11434").replace(
        /\/+$/,
        "",
      );
      const resp = await fetch(`${base}/api/tags`, {
        method: "GET",
        signal: ac.signal,
      });
      if (!resp.ok) {
        return {
          ok: false,
          error: `HTTP ${resp.status}: ${resp.statusText}`,
        };
      }
      const data = await resp.json().catch(() => ({}));
      const tags = Array.isArray(data?.models) ? data.models : [];
      if (model) {
        const found = tags.some(
          (t) => (t?.name || "").split(":")[0] === model.split(":")[0],
        );
        if (!found) {
          return {
            ok: false,
            error: `Model '${model}' not pulled. Run: ollama pull ${model}`,
          };
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        detail: `${tags.length} model(s) installed${model ? ` · ${model} ✓` : ""}`,
      };
    }

    return { ok: false, error: `Unsupported provider: ${source}` };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, error: `Timeout after ${TEST_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the available models for the given provider config. Used by the
// chat panel's model picker so the dropdown reflects the selected AI
// provider instead of showing stale defaults.
//
// Strategy per protocol:
//   • openai-compatible: GET {base}/models → map data[].id
//   • ollama:            GET {base}/api/tags → map models[].name
//   • anthropic:         no public /models endpoint → static curated list
//   • ide/cli + cliKind: CLI binaries have no models API → static per-kind list
//
// Returns an array of { id, label, description } suitable for the picker.
// Always resolves (never rejects) — errors just become an empty list so the
// UI falls back to its static catalog.
const PROVIDER_MODEL_CACHE_TTL_MS = 60 * 1000;
const _providerModelCache = new Map();

function _providerModelCacheFingerprint(value) {
  const s = String(value || "");
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

function _providerModelCacheKey(p) {
  const rawSource = (p?.source || "ide").toLowerCase();
  const source =
    rawSource === "gpt" ? "openai" : rawSource === "claude" ? "anthropic" : rawSource;
  const baseUrlRaw = String(p?.baseUrl || "").trim();
  const cliKind = String(p?.cliKind || "").toLowerCase();
  const parts = [source];
  if (source === "openai") {
    const base = (baseUrlRaw || "https://api.openai.com/v1")
      .toLowerCase()
      .replace(/\/+$/, "");
    parts.push(base, _providerModelCacheFingerprint(p?.apiKey || ""));
  } else if (source === "ollama") {
    const base = (baseUrlRaw || "http://localhost:11434")
      .toLowerCase()
      .replace(/\/+$/, "");
    parts.push(base);
  } else if (source === "ide" || source === "cli") {
    parts.push(cliKind || "custom");
  }
  return parts.join("::");
}

function _getCachedProviderModels(p) {
  const key = _providerModelCacheKey(p);
  const entry = _providerModelCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    _providerModelCache.delete(key);
    return null;
  }
  return entry.models.map((model) => ({ ...model }));
}

function _setCachedProviderModels(p, models) {
  if (!Array.isArray(models) || models.length === 0) return;
  _providerModelCache.set(_providerModelCacheKey(p), {
    expiresAt: Date.now() + PROVIDER_MODEL_CACHE_TTL_MS,
    models: models.map((model) => ({ ...model })),
  });
}

async function _fetchProviderModels(p) {
  const TIMEOUT_MS = 6000;
  const source = (p?.source || "ide").toLowerCase();
  const apiKey = (p?.apiKey || "").trim();
  const baseUrlRaw = (p?.baseUrl || "").trim();
  const cliKind = (p?.cliKind || "").toLowerCase();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    if (source === "openai" || source === "gpt") {
      if (!apiKey) return [];
      const base = (baseUrlRaw || "https://api.openai.com/v1").replace(/\/+$/, "");
      const resp = await fetch(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ac.signal,
      });
      if (!resp.ok) return [];
      const data = await resp.json().catch(() => ({}));
      const arr = Array.isArray(data?.data) ? data.data : [];
      return arr
        .filter((m) => typeof m?.id === "string")
        // Keep chat-capable models; filter embeddings / tts / whisper / moderation.
        .filter((m) => !/^(text-embedding|whisper|tts|dall-e|omni-moderation)/.test(m.id))
        .map((m) => ({ id: m.id, label: m.id, description: m.owned_by || source }));
    }

    if (source === "ollama") {
      const base = (baseUrlRaw || "http://localhost:11434").replace(/\/+$/, "");
      const resp = await fetch(`${base}/api/tags`, {
        method: "GET",
        signal: ac.signal,
      });
      if (!resp.ok) return [];
      const data = await resp.json().catch(() => ({}));
      const tags = Array.isArray(data?.models) ? data.models : [];
      return tags
        .filter((t) => typeof t?.name === "string")
        .map((t) => ({ id: t.name, label: t.name, description: "Local · Ollama" }));
    }

    if (source === "anthropic" || source === "claude") {
      return [
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  description: "Fastest" },
        { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", description: "Balanced" },
        { id: "claude-opus-4-7",           label: "Claude Opus 4.7",   description: "Most capable" },
      ];
    }

    if (source === "ide" || source === "cli") {
      if (cliKind === "copilot") {
        return [
          { id: "gpt-5",             label: "GPT-5",             description: "GitHub Copilot" },
          { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", description: "GitHub Copilot" },
        ];
      }
      if (cliKind === "claude") {
        return [
          { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", description: "Claude Code CLI" },
          { id: "claude-opus-4-7",           label: "Claude Opus 4.7",   description: "Claude Code CLI" },
          { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  description: "Claude Code CLI" },
        ];
      }
      if (cliKind === "codex") {
        return [
          { id: "gpt-5",   label: "GPT-5",   description: "Codex CLI" },
          { id: "o4-mini", label: "o4-mini", description: "Codex CLI" },
        ];
      }
      return [];
    }

    return [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ─── Activity Log — In-Memory Buffer ─────────────────────────
// Keeps the in-memory log as the source of truth and batch-flushes
// to storage instead of doing a get+set on every single log call.
// This eliminates the high-frequency storage round-trips that the old
// implementation caused (one get+set per debug log, per tool call, etc.).
let _activityLog = [];       // In-memory ring buffer (authoritative)
let _activityLogDirty = false; // True when log has unpersisted entries
let _activityFlushTimer = null;
const ACTIVITY_FLUSH_MS = 300; // Coalesce writes within a 300ms window

// Seed the in-memory log from storage on startup so we don't lose
// entries that were persisted in a previous service worker lifetime.
activityStorage.get([ACTIVITY_LOG_KEY], (result) => {
  const stored = result?.[ACTIVITY_LOG_KEY];
  if (Array.isArray(stored) && stored.length > 0) {
    _activityLog = stored;
  }
});

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
  cliBinary: "",
  cliKind: "",
  cliExtraArgs: "",
  // `enabled` gates whether the direct (network) provider path is taken
  // by CHAT_AI_MESSAGE. Saving credentials alone is not enough — the
  // user must explicitly opt in via the popup toggle and pass a
  // pre-activation connection test (see TEST_AI_PROVIDER).
  enabled: false,
  preset: "custom",
};

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

function _modelLooksCompatibleWithSettings(model, settings) {
  const id = String(model || "").trim();
  if (!id) return false;
  const source = (settings?.source || "").toLowerCase();
  const base = _normalizedProviderBaseUrl(settings?.baseUrl);
  const cliKind = (settings?.cliKind || "").toLowerCase();
  const d = id.toLowerCase();

  if (source === "anthropic" || source === "claude") {
    return d.startsWith("claude");
  }
  if (source === "openai" || source === "gpt" || source === "chatgpt") {
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
  if (source === "ollama") {
    return !d.startsWith("claude") && !/^(gpt-(?:3|4|5)|o\d|chatgpt|text-)/.test(d);
  }
  if (source === "cli") {
    if (cliKind === "claude") return d.startsWith("claude");
    if (cliKind === "codex") return /^(gpt|o\d)/.test(d);
    if (cliKind === "copilot") return /^(gpt|claude)/.test(d);
    return false;
  }
  if (source === "ide") return false;
  return true;
}

function _effectiveConfiguredProviderModel(settings, override = null) {
  const chosen = String(override || "").trim();
  if (chosen) return chosen;
  const configured = String(settings?.model || "").trim();
  return _modelLooksCompatibleWithSettings(configured, settings) ? configured : "";
}

function _readCurrentProviderSettings() {
  return new Promise((resolve) => {
    const fallback = async () => {
      const apiKey = await _readApiKey();
      resolve({
        ...aiProviderSettings,
        apiKey: apiKey || aiProviderSettings.apiKey || "",
      });
    };

    try {
      chrome.storage.local.get(
        [
          "aiProviderSource",
          "aiProviderModel",
          "aiProviderBaseUrl",
          "aiProviderCliBinary",
          "aiProviderCliKind",
          "aiProviderCliExtraArgs",
          "aiProviderEnabled",
          "aiProviderPreset",
        ],
        async (result) => {
          const apiKey = await _readApiKey();
          resolve({
            source: result?.aiProviderSource || aiProviderSettings.source || "ide",
            apiKey: apiKey || aiProviderSettings.apiKey || "",
            model: result?.aiProviderModel || aiProviderSettings.model || "",
            baseUrl: result?.aiProviderBaseUrl || aiProviderSettings.baseUrl || "",
            cliBinary:
              result?.aiProviderCliBinary || aiProviderSettings.cliBinary || "",
            cliKind: result?.aiProviderCliKind || aiProviderSettings.cliKind || "",
            cliExtraArgs:
              result?.aiProviderCliExtraArgs ||
              aiProviderSettings.cliExtraArgs ||
              "",
            enabled:
              result?.aiProviderEnabled === true ||
              aiProviderSettings.enabled === true,
            preset: result?.aiProviderPreset || aiProviderSettings.preset || "custom",
          });
        },
      );
    } catch (_) {
      fallback();
    }
  });
}

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
  _activityLog.push({
    ts: Date.now(),
    level: level || "info",
    source: source || "background",
    text,
  });
  if (_activityLog.length > ACTIVITY_LOG_LIMIT) {
    _activityLog.splice(0, _activityLog.length - ACTIVITY_LOG_LIMIT);
  }
  _activityLogDirty = true;
  if (!_activityFlushTimer) {
    _activityFlushTimer = setTimeout(_flushActivityLog, ACTIVITY_FLUSH_MS);
  }
}

function _flushActivityLog() {
  _activityFlushTimer = null;
  if (!_activityLogDirty) return;
  _activityLogDirty = false;
  // Write the current snapshot; no read needed since we own the in-memory state.
  activityStorage.set({ [ACTIVITY_LOG_KEY]: _activityLog.slice() }).catch(() => {});
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

// ─── Conversation history compaction ─────────────────────────
// Single source of truth for how the panel's full conversationHistory
// is reduced before being handed to either a direct AI provider or the
// CLI/MCP bridge. Goals:
//   • Bound payload size: cap on number of recent turns + per-turn char
//     limits on older user content (assistant turns are preserved verbatim
//     because they often summarize tool-state continuity).
//   • Optional attachment binary stripping: CLI/bridge providers can't
//     consume image bytes, so leave a short text marker like
//     "[image attached: name]" instead of forwarding multi-MB data URLs.
//   • Earlier-turn awareness: if turns were dropped, prepend a synthetic
//     assistant note so the model knows context exists beyond the window
//     (otherwise long sessions feel amnesic — JetBrains AI does the same
//     "summary of earlier conversation" thing).
function _compactHistoryForOutbound(history, opts) {
  const sliceN = Math.max(2, opts?.sliceN ?? 8);
  const stripAttachmentBinaries = !!opts?.stripAttachmentBinaries;
  const maxOldUserChars = Math.max(120, opts?.maxOldUserChars ?? 400);
  const keepRecentVerbatim = Math.max(2, opts?.keepRecentVerbatim ?? 3);

  const arr = Array.isArray(history) ? history : [];
  if (arr.length === 0) return [];

  const recent = arr.slice(-sliceN);
  const droppedCount = arr.length - recent.length;

  // Determine the boundary inside `recent` beyond which we'll truncate
  // older user turns. The most recent N user turns stay full-length so
  // tool-state continuity isn't lost.
  let userTurnsSeen = 0;
  const oldUserBoundary = (() => {
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i]?.role === "user") {
        userTurnsSeen++;
        if (userTurnsSeen >= keepRecentVerbatim) return i;
      }
    }
    return 0;
  })();

  const sanitized = recent.map((m, i) => {
    if (!m || !m.role) return m;
    let content = String(m.content ?? "");
    const atts = Array.isArray(m.attachments) ? m.attachments : null;

    // Strip attachment binaries; keep a short text marker so the model
    // still knows an image was part of that turn. We omit per-image
    // names — uploads frequently have throwaway names (IC0.png,
    // screenshot.png, image (3).png) that would just mislead the model.
    if (stripAttachmentBinaries && atts && atts.length > 0) {
      const note = `[image attached × ${atts.length}; pixel data not forwarded to this AI bridge]`;
      content = content ? `${content}\n${note}` : note;
    }

    // Truncate older user turns; leave assistant turns alone (they may
    // hold the only surviving record of prior tool calls / summaries).
    if (
      m.role === "user" &&
      i < oldUserBoundary &&
      content.length > maxOldUserChars
    ) {
      content = content.slice(0, maxOldUserChars) + "\n…[truncated]";
    }

    const out = { role: m.role, content };
    if (atts && !stripAttachmentBinaries) out.attachments = atts;
    return out;
  });

  if (droppedCount > 0) {
    sanitized.unshift({
      role: "assistant",
      content: `[earlier conversation: ${droppedCount} prior turn(s) elided to keep context manageable. Ask the user if you need details from before this point.]`,
    });
  }

  return sanitized;
}


// ─── Direct AI Provider Calls ────────────────────────────────
// Provider clients live in providers.js (loaded above via importScripts).
// The wrappers below adapt the SW's settings + logger to the shared API.

async function _callDirectProvider(
  providerType,
  text,
  context,
  conversationHistory,
) {
  const apiKey = (aiProviderSettings.apiKey || "").trim();
  return globalThis.AutoDOMProviders.callDirectProvider(providerType, {
    apiKey,
    baseUrl: aiProviderSettings.baseUrl,
    model: aiProviderSettings.model,
    text,
    context,
    conversationHistory,
    debug: _debugLog,
  });
}

// ════════════════════════════════════════════════════════════
// AGENT LOOP — Playwright-style automation from in-page chat
// ════════════════════════════════════════════════════════════
//
// Lets the in-panel AI act on the page using the same TOOL_HANDLERS
// the MCP bridge uses, without the IDE host. Works for OpenAI,
// Anthropic, and Ollama (provided the model supports tool calls).
//
// Architecture:
//   1. We give the provider a curated tool catalog (agent-tools.js)
//   2. Provider returns either final text OR tool_calls
//   3. For each tool_call: execute via executeAgentTool() and stream
//      AGENT_TOOL_EVENT to the chat panel for live UI feedback
//   4. Append the (provider-native) tool results to the transcript
//   5. Loop until provider stops calling tools, hits a cap, or errors

const AGENT_MAX_TURNS = 12;
const AGENT_WALL_CLOCK_MS = 90 * 1000;
// Per-panel run lock so two CHAT_AI_MESSAGEs don't fight the same tab
const _agentRunLocks = new Set();

// Active agent-run handle — so the chat panel can cancel it with STOP_AGENT_RUN.
// Only one run can be active at a time (the lock above enforces this).
let _activeAgentRun = null; // { runId, aborter: AbortController, aborted: boolean, panelTabId }
let _agentRunIdCounter = 0;
const _chatPanelReadyTabs = new Set();
const _chatPanelInjectingTabs = new Map();

function _getActiveRunStatePayload() {
  if (!_activeAgentRun) return { active: false };
  return {
    active: true,
    runId: _activeAgentRun.runId,
    panelTabId: _activeAgentRun.panelTabId,
    toolRunning: !!_activeAgentRun.toolRunning,
  };
}

function _getAgentRunStateMessage() {
  return {
    type: "AGENT_RUN_STATE_CHANGED",
    ..._getActiveRunStatePayload(),
  };
}

function _startAgentRunHandle(panelTabId) {
  const runId = `run_${Date.now()}_${++_agentRunIdCounter}`;
  _activeAgentRun = {
    runId,
    aborter: new AbortController(),
    aborted: false,
    panelTabId,
  };
  _broadcastAgentRunState();
  return _activeAgentRun;
}
function _endAgentRunHandle(runId) {
  if (_activeAgentRun && _activeAgentRun.runId === runId) {
    _activeAgentRun = null;
    _broadcastAgentRunState();
  }
}
function _stopActiveAgentRun(reason) {
  const run = _activeAgentRun;
  if (!run) return false;
  run.aborted = true;
  try {
    run.aborter.abort(reason || "stopped_by_user");
  } catch (_) {}
  return true;
}

// Notify the currently-focused tab in every window that the run state
// changed, so its chat panel can re-mount or tear down the overlay.
// We target the active tab per window (cheap, predictable) instead of
// every tab; the user's overlay only needs to be visible where they
// are looking. Other tabs catch up via tabs.onActivated when they're
// switched to.
function _broadcastAgentRunState() {
  try {
    const stateMessage = _getAgentRunStateMessage();
    chrome.tabs.query({ active: true }, (tabs) => {
      try { void chrome.runtime.lastError; } catch (_) {}
      if (!tabs) return;
      for (const t of tabs) {
        if (!t || t.id == null) continue;
        try {
          chrome.tabs.sendMessage(t.id, stateMessage).catch(() => {});
        } catch (_) {}
      }
    });
  } catch (_) {}
}

// Pinned-tab execution context for the in-flight loop. Calls to active-tab
// helpers route through this so user clicking a different tab mid-run
// doesn't hijack the agent.
let _agentRunContext = null; // { tabId, windowId } | null
function _withAgentTabContext(ctx, fn) {
  const prev = _agentRunContext;
  _agentRunContext = ctx;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      _agentRunContext = prev;
    });
}

// Single execution path for tool calls coming from the agent. Keeps rate
// limiting and routes every call through the Ask-Before-Act ActionGate
// middleware (action-gate.js). Denied actions short-circuit here with a
// structured { ok:false, denied:true, reason } so the agent can replan.
async function executeAgentTool(toolName, params) {
  const handler = TOOL_HANDLERS.get(toolName);
  if (!handler) {
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }
  // Rate limit (re-uses bridge logic)
  let _gateTab;
  try {
    const tab = await getActiveTab();
    _gateTab = tab;
    const domain = getDomainFromTab(tab);
    const rateCheck = checkRateLimit(domain);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        error: `Rate-limited on ${rateCheck.domain}: ${rateCheck.error}`,
      };
    }
  } catch (_) {}

  // ── ActionGate: Ask Before Act ──────────────────────────────
  const Gate = globalThis.AutoDOMActionGate;
  if (Gate) {
    try {
      const origin = Gate.normalizeOrigin(_gateTab?.url || "");
      const decision = await Gate.requestDecision({
        tabId: _gateTab?.id,
        origin,
        toolName,
        params,
      });
      if (!decision?.allowed) {
        return {
          ok: false,
          denied: true,
          error: decision?.reason || `Action '${toolName}' denied by user`,
        };
      }
    } catch (err) {
      // Fail closed: if the gate itself crashes, refuse the action.
      return {
        ok: false,
        denied: true,
        error: `ActionGate error: ${err?.message || String(err)}`,
      };
    }
  }

  // Mark the active run as "mid-tool" so the UI can distinguish a run
  // that's actively executing a browser tool from one that's merely
  // unwinding / finalizing after the last tool result.
  if (_activeAgentRun) _activeAgentRun.toolRunning = true;
  try {
    touchToolActivity();
    const raw = await handler(params || {});
    return { ok: !raw?.error, ...(raw || {}) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (_activeAgentRun) _activeAgentRun.toolRunning = false;
  }
}

// Stream a "tool was called" event to the active chat panel so it can
// render an inline chip in the in-flight assistant message.
function _streamAgentToolEvent(tabId, evt) {
  if (tabId == null) return;
  try {
    chrome.tabs
      .sendMessage(tabId, { type: "AGENT_TOOL_EVENT", event: evt })
      .catch(() => {});
  } catch (_) {}
}

function _safeJsonParse(s) {
  if (s == null) return {};
  if (typeof s === "object") return s;
  try {
    return JSON.parse(s);
  } catch (_) {
    return {};
  }
}

// When the agent successfully switches/opens a tab, follow it for
// subsequent calls. Falls back silently for unexpected result shapes.
function _maybeRepinAgentTab(toolName, rawResult) {
  if (!rawResult || rawResult.error) return;
  let newTabId = null;
  let newWindowId = null;
  if (toolName === "switch_tab" || toolName === "open_new_tab") {
    newTabId =
      rawResult.tabId ??
      rawResult.tab?.id ??
      rawResult.id ??
      null;
    newWindowId =
      rawResult.windowId ??
      rawResult.tab?.windowId ??
      _agentRunContext?.windowId ??
      null;
  }
  if (newTabId != null) {
    _agentRunContext = { tabId: newTabId, windowId: newWindowId };
  }
}

// Acquire the pinned tab for this agent run. Falls back to active tab if
// nothing pinned yet.
async function _resolveAgentTab(initialTabId) {
  if (_agentRunContext?.tabId != null) {
    try {
      return await chrome.tabs.get(_agentRunContext.tabId);
    } catch (_) {
      _agentRunContext = null;
    }
  }
  if (initialTabId != null) {
    try {
      return await chrome.tabs.get(initialTabId);
    } catch (_) {}
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Build provider-formatted tool definitions for the catalog
function _toolsForProvider(providerType) {
  const cat = globalThis.AutoDOMAgent?.TOOL_CATALOG;
  if (!cat) return null;
  if (providerType === "openai") return AutoDOMAgent.formatToolsForOpenAI(cat);
  if (providerType === "anthropic")
    return AutoDOMAgent.formatToolsForAnthropic(cat);
  if (providerType === "ollama") return AutoDOMAgent.formatToolsForOllama(cat);
  return null;
}

// ─── Page-context dedup cache (jcodemunch session_context idea) ─────
// In a multi-turn chat on one page, the page context (~1000 tokens of
// visible text) is usually the same across turns — but we currently
// re-paste it into the system prompt every single call. Borrowing
// jcodemunch's "files_accessed" trick: cache a per-tab fingerprint of
// the page context; if unchanged on the next turn, drop the heavy text
// fields and inject a 1-line "[unchanged]" marker instead. The model
// already saw the text in an earlier turn's system prompt and can call
// get_dom_state if it needs fresh detail.
//
// This pays off massively in long sessions: a 10-turn chat on the same
// page saves ~9× the page-text cost (~9k tokens at 1k/turn).
const _pageCtxCache = new Map(); // tabId -> { fingerprint, ts }
const _PAGE_CTX_TTL_MS = 5 * 60 * 1000;

function _ctxFingerprint(ctx) {
  if (!ctx) return "";
  const t = String(ctx.visibleTextPreview || "");
  const o = String(ctx.visibleOverlayText || "");
  const ol = String(ctx.outline || "");
  // url+title catches navigation; text length+head catches in-place
  // mutation; overlay catches modal opens; outline catches heading
  // changes (e.g. SPA route swap that keeps the visible-text head). All
  // cheap; cache stays stable across scroll/blur events.
  return [
    ctx.url || "",
    ctx.title || "",
    t.length,
    t.slice(0, 96),
    o.length,
    ol.length,
    ol.slice(0, 64),
  ].join("|");
}

function _slimContextForRepeat(ctx) {
  if (!ctx) return ctx;
  return {
    url: ctx.url,
    title: ctx.title,
    interactiveElements: ctx.interactiveElements,
    outline: ctx.outline, // keep — it's tiny and structurally useful
    _pageUnchanged: true,
  };
}

function _agentSystemPrompt(context, providerInfo, cacheKey) {
  let effectiveCtx = context;
  if (cacheKey != null && context) {
    const fp = _ctxFingerprint(context);
    const prev = _pageCtxCache.get(cacheKey);
    if (
      prev &&
      prev.fingerprint === fp &&
      Date.now() - prev.ts < _PAGE_CTX_TTL_MS
    ) {
      effectiveCtx = _slimContextForRepeat(context);
    }
    _pageCtxCache.set(cacheKey, { fingerprint: fp, ts: Date.now() });
  }
  const base = AutoDOMProviders.buildSystemPrompt(effectiveCtx, providerInfo);
  // Compressed prompt — every line costs tokens on every turn. The
  // older verbose version had ~700 tokens of agent-mode + reply-hygiene
  // prose with examples. This bullet-form keeps every behavioural rule
  // but trims roughly 60% of the wire size. Examples were removed
  // because rule 4 was just BAD/GOOD pairs of rules 1-3 — net redundant.
  return (
    base +
    "\nAgent mode:\n" +
    "- Plan briefly, then call tools (get_dom_state, click_by_index, type_by_index, navigate, list_tabs, switch_tab, wait_for_popup) to read AND act on the page yourself.\n" +
    "- Don't tell the user to inspect the page — do it. Only ask follow-ups if a destructive action is ambiguous or info is genuinely missing.\n" +
    "- Don't repeat a failing tool call; change selector or approach. STOP calling tools once you have the answer (or call respond_to_user).\n" +
    "Reply rules (HARD):\n" +
    "- Never write internal shorthand (IC0, CB0, etc.) in user-facing text. Describe the element/action in plain English; never tell users to type placeholder tokens.\n" +
    "- When asked for a value (URL, price, name, count, text), report the resolved value from the tool result — never an index reference.\n" +
    "- For self-identification, answer in plain English as 'the AutoDOM in-page assistant'. Don't invent a model name; don't include any internal token.\n"
  );
}

// ─── Tool-result dedup within an agent loop (jcodemunch hash trick) ──
// Inside a single agent run the model often re-invokes the same read
// tool (get_dom_state, get_page_info) and gets the same payload back.
// Replaying the full payload each time wastes a lot of tokens — a
// fresh DOM dump can be 4-8 KB. We hash each result; on collision we
// replace the body with a short pointer ("same as step N") so the
// model still sees a result entry but the bytes drop to <100 chars.
//
// Per-loop scope is intentional: stale-cache risk is bounded because
// the helper is reset every agent invocation. Cross-loop dedup would
// require invalidation on every page mutation, which isn't worth it.
function _makeToolResultDeduper() {
  const seen = new Map(); // hash -> { stepNumber, toolName }
  let stepCounter = 0;
  function hash(s) {
    // FNV-1a 32-bit — fast, good distribution for short JSON.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  return {
    /**
     * @param toolName tool that produced the result
     * @param resultJson JSON-stringified result body
     * @returns either the original resultJson, or a short dedup pointer.
     */
    process(toolName, resultJson) {
      stepCounter++;
      // Don't dedup tiny payloads — the pointer would be longer than
      // the value and the saving is noise. 200 chars is the rough
      // crossover where dedup actually pays off.
      if (!resultJson || resultJson.length < 200) return resultJson;
      const h = hash(resultJson);
      const prev = seen.get(h);
      if (prev) {
        return JSON.stringify({
          ok: true,
          _dedup: `Identical to step ${prev.stepNumber} (${prev.toolName}). See that result above.`,
        });
      }
      seen.set(h, { stepNumber: stepCounter, toolName });
      return resultJson;
    },
  };
}

// Detect if the same tool+args has been called repeatedly without progress.
// Caches the last serialized key so we don't pay a JSON.stringify hit on
// every tool call in the hot agent loop — args can be large (DOM extracts,
// long text) and re-serializing each turn was a measurable overhead.
function _isRepeatLoop(history, toolName, args) {
  let argsKey;
  if (args && typeof args === "object") {
    if (args.__autodomKey) {
      argsKey = args.__autodomKey;
    } else {
      argsKey = JSON.stringify(args);
      try {
        Object.defineProperty(args, "__autodomKey", {
          value: argsKey,
          enumerable: false,
        });
      } catch (_) {
        // Frozen / sealed — ignore, will re-stringify next time.
      }
    }
  } else {
    argsKey = JSON.stringify(args || {});
  }
  const key = toolName + "::" + argsKey;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === key) count++;
    else break;
  }
  history.push(key);
  return count >= 2; // 3rd identical call in a row → loop
}

// ─── Multimodal user-message builder ─────────────────────────────────
// Translates the chat panel's attachment objects ({ name, mime, dataUrl })
// into provider-native message shapes. Returns the additional fields
// to spread onto a `{ role: "user", ... }` entry. Falls back to the
// plain text payload when no attachments are present (cheapest path).
function _buildUserMessageForProvider(text, attachments, providerType) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a && a.dataUrl) : [];
  if (list.length === 0) return { content: String(text || "") };

  if (providerType === "anthropic") {
    // Anthropic vision wants base64-decoded blocks: { type:"image", source:{ type:"base64", media_type, data } }
    const blocks = [];
    list.forEach((a) => {
      const m = String(a.dataUrl).match(/^data:([^;,]+);base64,(.+)$/);
      if (!m) return;
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: m[1], data: m[2] },
      });
    });
    if (text) blocks.push({ type: "text", text: String(text) });
    return blocks.length > 0 ? { content: blocks } : { content: String(text || "") };
  }

  if (providerType === "openai") {
    // OpenAI chat completions vision: content array with text + image_url parts.
    const parts = [];
    if (text) parts.push({ type: "text", text: String(text) });
    list.forEach((a) => {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    });
    return { content: parts };
  }

  if (providerType === "ollama") {
    // Ollama (llava/llama3.2-vision) takes raw base64 strings under `images`.
    const images = [];
    list.forEach((a) => {
      const m = String(a.dataUrl).match(/^data:[^;,]+;base64,(.+)$/);
      if (m) images.push(m[1]);
    });
    return images.length > 0
      ? { content: String(text || ""), images }
      : { content: String(text || "") };
  }

  // Unknown provider — fall back to text only so we never crash the loop
  // with an unsupported content shape.
  return { content: String(text || "") };
}

async function runAgentLoop({
  providerType,
  text,
  context,
  conversationHistory,
  initialTabId,
  modelOverride,
  attachments,
}) {
  const ProvidersApi = globalThis.AutoDOMProviders;
  const AgentApi = globalThis.AutoDOMAgent;
  if (!ProvidersApi || !AgentApi) {
    throw new Error("Agent modules not loaded");
  }
  const apiKey = (aiProviderSettings.apiKey || "").trim();
  // Per-run model override from the chat panel's model picker. Falls back
  // to the globally configured default in chrome.storage.
  const _model = _effectiveConfiguredProviderModel(
    aiProviderSettings,
    modelOverride,
  );
  const tools = _toolsForProvider(providerType);
  if (!tools) {
    throw new Error(`Agent loop not supported for provider: ${providerType}`);
  }

  // Pin the tab where the chat originated so user focus changes don't hijack the run
  const startTab = await _resolveAgentTab(initialTabId);
  const runCtx = startTab
    ? { tabId: startTab.id, windowId: startTab.windowId }
    : null;
  const panelTabId = startTab?.id ?? null;

  return _withAgentTabContext(runCtx, async () => {
    const startedAt = Date.now();
    const callHistory = []; // for repeat-loop detection
    const accumulatedToolCalls = []; // surfaced as chips in final response
    const deduper = _makeToolResultDeduper();

    // ── Abort / Stop plumbing ───────────────────────────────────
    // A single active run handle lets the chat panel send STOP_AGENT_RUN
    // and have both the in-flight provider fetch and the tool loop bail out.
    const runHandle = _startAgentRunHandle(panelTabId);
    const signal = runHandle.aborter.signal;
    const isAborted = () => runHandle.aborted;
    const abortedReply = () => ({
      response: "⏹ Stopped by user.",
      toolCalls: accumulatedToolCalls,
      aborted: true,
    });
    _streamAgentToolEvent(panelTabId, {
      phase: "run-start",
      runId: runHandle.runId,
    });
    let _runEnded = false;
    const endRun = (aborted) => {
      if (_runEnded) return;
      _runEnded = true;
      _streamAgentToolEvent(panelTabId, {
        phase: "run-end",
        runId: runHandle.runId,
        aborted: !!aborted,
      });
      _endAgentRunHandle(runHandle.runId);
    };
    const finish = (payload) => {
      endRun(payload.aborted);
      return payload;
    };

    try {
    // ── OpenAI / Ollama style: messages = [{role, content/tool_calls/...}] ──
    if (providerType === "openai" || providerType === "ollama") {
      const providerInfo = { model: _model, provider: providerType };
      const sys = _agentSystemPrompt(context, providerInfo, panelTabId);
      const messages = [{ role: "system", content: sys }];
      // Compact + dedupe the prior turns. _compactHistoryForOutbound
      // bounds payload size and (for very long sessions) prepends a
      // synthetic note that earlier turns existed — JetBrains-AI style.
      const compacted = _compactHistoryForOutbound(conversationHistory);
      // The client pushes the just-typed user message to history BEFORE
      // sending, so the trailing entry is typically the same as `text` —
      // dedupe to avoid the model seeing its current prompt twice.
      const last = compacted[compacted.length - 1];
      const lastIsCurrentUser =
        last && last.role === "user" && String(last.content) === String(text);
      const trimmed = lastIsCurrentUser ? compacted.slice(0, -1) : compacted;
      trimmed.forEach((m) => {
        if (!m?.role || !m?.content) return;
        messages.push({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content),
        });
      });
      messages.push({
        role: "user",
        ..._buildUserMessageForProvider(text, attachments, providerType),
      });

      for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
        if (isAborted()) return finish(abortedReply());
        if (Date.now() - startedAt > AGENT_WALL_CLOCK_MS) {
          return finish({
            response:
              "⚠️ Agent timed out (wall-clock limit). Returning partial results.",
            toolCalls: accumulatedToolCalls,
          });
        }
        const callFn =
          providerType === "openai"
            ? ProvidersApi.callOpenAI
            : ProvidersApi.callOllama;
        let resp;
        try {
          resp = await callFn({
            apiKey,
            baseUrl: aiProviderSettings.baseUrl,
            model: _model,
            tools,
            messagesOverride: messages,
            debug: _debugLog,
            signal,
          });
        } catch (err) {
          if (isAborted() || err?.name === "AbortError") {
            return finish(abortedReply());
          }
          throw err;
        }
        // Append assistant message verbatim (preserves tool_calls structure)
        const assistantMsg = resp.assistantMessage || {
          role: "assistant",
          content: resp.response || "",
        };
        messages.push(assistantMsg);

        if (!resp.toolCalls || resp.toolCalls.length === 0) {
          // Final reply
          return finish({
            response:
              resp.response ||
              "(Agent completed but returned no text response.)",
            toolCalls: accumulatedToolCalls,
          });
        }

        // Execute each tool call sequentially (parallel disabled in OpenAI body)
        for (const tc of resp.toolCalls) {
          if (isAborted()) return finish(abortedReply());
          const args = _safeJsonParse(tc.arguments);
          // Special "respond_to_user" tool short-circuits the loop
          if (tc.name === "respond_to_user") {
            return finish({
              response: args.markdown || resp.response || "(no response)",
              toolCalls: accumulatedToolCalls,
            });
          }
          if (_isRepeatLoop(callHistory, tc.name, args)) {
            const stuckMsg = `Aborting: tool '${tc.name}' called 3 times in a row with same args. Likely a loop on a flaky selector.`;
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: false, error: stuckMsg }),
            });
            return finish({
              response:
                "⚠️ Agent stopped: detected a repeat-loop on tool `" +
                tc.name +
                "`. " +
                "The page may not be in the expected state. Please refine your request or try again.",
              toolCalls: accumulatedToolCalls,
            });
          }
          _streamAgentToolEvent(panelTabId, {
            phase: "start",
            runId: runHandle.runId,
            tool: tc.name,
            args,
          });
          const rawResult = await executeAgentTool(tc.name, args);
          const result = AgentApi.truncateToolResult(tc.name, rawResult);
          // Re-pin the agent run to a new tab when the AI explicitly asked to.
          _maybeRepinAgentTab(tc.name, rawResult);
          accumulatedToolCalls.push({
            tool: tc.name,
            args,
            ok: !!rawResult?.ok && !rawResult?.error,
          });
          _streamAgentToolEvent(panelTabId, {
            phase: "end",
            runId: runHandle.runId,
            tool: tc.name,
            ok: !!rawResult?.ok && !rawResult?.error,
            error: rawResult?.error,
            result,
          });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: deduper.process(tc.name, JSON.stringify(result)),
          });
        }
      }
      return finish({
        response:
          "⚠️ Agent reached the maximum tool-use turns. Returning what was gathered so far.",
        toolCalls: accumulatedToolCalls,
      });
    }

    // ── Anthropic style: messages = [{role:'user'|'assistant', content: blocks[]}] ──
    if (providerType === "anthropic") {
      const providerInfo = { model: _model, provider: "anthropic" };
      const messages = [];
      // Compact + dedupe the prior turns — same JetBrains-AI style
      // bounding logic as the OpenAI/Ollama branch above.
      const compacted = _compactHistoryForOutbound(conversationHistory);
      const last = compacted[compacted.length - 1];
      const lastIsCurrentUser =
        last && last.role === "user" && String(last.content) === String(text);
      const trimmed = lastIsCurrentUser ? compacted.slice(0, -1) : compacted;
      trimmed.forEach((m) => {
        if (!m?.role || !m?.content) return;
        messages.push({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content),
        });
      });
      messages.push({
        role: "user",
        ..._buildUserMessageForProvider(text, attachments, "anthropic"),
      });

      // Build the system prompt here (with agent instructions + identity)
      // and pass it down — callAnthropic would otherwise rebuild a base
      // prompt from `context` and miss both the agent appendix and the
      // model identity disclosure.
      const agentContext = { ...context, _agentMode: true };
      const agentSystemPrompt = _agentSystemPrompt(agentContext, providerInfo, panelTabId);

      for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
        if (isAborted()) return finish(abortedReply());
        if (Date.now() - startedAt > AGENT_WALL_CLOCK_MS) {
          return finish({
            response:
              "⚠️ Agent timed out (wall-clock limit). Returning partial results.",
            toolCalls: accumulatedToolCalls,
          });
        }
        let resp;
        try {
          resp = await ProvidersApi.callAnthropic({
            apiKey,
            baseUrl: aiProviderSettings.baseUrl,
            model: _model,
            context: agentContext,
            messagesOverride: messages,
            systemPromptOverride: agentSystemPrompt,
            providerInfo,
            tools,
            debug: _debugLog,
            signal,
          });
        } catch (err) {
          if (isAborted() || err?.name === "AbortError") {
            return finish(abortedReply());
          }
          throw err;
        }

        // Append assistant message with the raw blocks (text + tool_use)
        const assistantBlocks = resp.assistantContent || [];
        if (assistantBlocks.length === 0 && resp.response) {
          messages.push({ role: "assistant", content: resp.response });
        } else {
          messages.push({ role: "assistant", content: assistantBlocks });
        }

        if (!resp.toolCalls || resp.toolCalls.length === 0) {
          return finish({
            response:
              resp.response ||
              "(Agent completed but returned no text response.)",
            toolCalls: accumulatedToolCalls,
          });
        }

        // Build a single user message containing all tool_result blocks
        const toolResultBlocks = [];
        let earlyReturn = null;
        for (const tc of resp.toolCalls) {
          if (isAborted()) return finish(abortedReply());
          const args = _safeJsonParse(tc.arguments);
          if (tc.name === "respond_to_user") {
            earlyReturn = args.markdown || resp.response || "(no response)";
            break;
          }
          if (_isRepeatLoop(callHistory, tc.name, args)) {
            earlyReturn =
              "⚠️ Agent stopped: detected a repeat-loop on tool `" +
              tc.name +
              "`. The page may not be in the expected state.";
            break;
          }
          _streamAgentToolEvent(panelTabId, {
            phase: "start",
            runId: runHandle.runId,
            tool: tc.name,
            args,
          });
          const rawResult = await executeAgentTool(tc.name, args);
          const result = AgentApi.truncateToolResult(tc.name, rawResult);
          _maybeRepinAgentTab(tc.name, rawResult);
          accumulatedToolCalls.push({
            tool: tc.name,
            args,
            ok: !!rawResult?.ok && !rawResult?.error,
          });
          _streamAgentToolEvent(panelTabId, {
            phase: "end",
            runId: runHandle.runId,
            tool: tc.name,
            ok: !!rawResult?.ok && !rawResult?.error,
            error: rawResult?.error,
            result,
          });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: deduper.process(tc.name, JSON.stringify(result)),
            is_error: !rawResult?.ok || !!rawResult?.error,
          });
        }
        if (earlyReturn) {
          return finish({
            response: earlyReturn,
            toolCalls: accumulatedToolCalls,
          });
        }
        messages.push({ role: "user", content: toolResultBlocks });
      }
      return finish({
        response:
          "⚠️ Agent reached the maximum tool-use turns. Returning what was gathered so far.",
        toolCalls: accumulatedToolCalls,
      });
    }

    throw new Error(`Agent loop not implemented for provider: ${providerType}`);
    } finally {
      // Guarantee run-end fires even on uncaught throws, so the chat panel
      // hides its "Running…" indicator and Stop button regardless.
      endRun(runHandle.aborted);
    }
  });
}

// ─── Inactivity Timeout ─────────────────────────────────────
// The bridge server is now the single source of truth for inactivity
// timeouts (see server/index.js startInactivityTimer). It sends
// INACTIVITY_WARNING messages at 80% of the timeout and SESSION_TIMEOUT
// when it actually shuts down — both of which are handled in ws.onmessage.
//
// The previous extension-side timer was a parallel implementation that
// raced with the server timer (different "what counts as activity" rules),
// so it has been removed in favour of the server-driven flow.
function touchToolActivity() {
  // Retained as a no-op so existing call sites stay compile-safe; the
  // server already resets its own timer whenever a tool result is sent
  // back over the WebSocket.
}

function startInactivityTimer() {
  // No-op — server-driven now (see header comment above).
}

function stopInactivityTimer() {
  // No-op — server-driven now (see header comment above).
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
  // Sync in-memory log when cleared externally (e.g. popup Clear button).
  // This prevents a pending flush from resurrecting logs after a clear.
  if (changes[ACTIVITY_LOG_KEY]) {
    const newVal = changes[ACTIVITY_LOG_KEY].newValue;
    if (!Array.isArray(newVal) || newVal.length === 0) {
      _activityLog = [];
      _activityLogDirty = false;
      if (_activityFlushTimer) {
        clearTimeout(_activityFlushTimer);
        _activityFlushTimer = null;
      }
    }
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
  if (SENSITIVE_INPUT_TYPES.has(type)) return true;
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
  const now = Date.now();
  sessionRecording.actions.push({
    timestamp: now,
    elapsed: now - sessionRecording.startTime,
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
  if (changeInfo.status === "loading") {
    _chatPanelReadyTabs.delete(tabId);
    _chatPanelInjectingTabs.delete(tabId);
  }
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
    // If an agent run is active, make sure the chat panel content
    // script is mounted on the tab the user just switched to so the
    // automation overlay + floating Stop appear there too. The panel's
    // own init restores busy state from the current run-state payload.
    if (_activeAgentRun && isInjectableTab(tab)) {
      try {
        await ensureChatPanelInjected(activeInfo.tabId);
        chrome.tabs
          .sendMessage(activeInfo.tabId, _getAgentRunStateMessage())
          .catch(() => {});
      } catch (_) {}
    }
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
  _chatPanelReadyTabs.delete(tabId);
  _chatPanelInjectingTabs.delete(tabId);
  _pageCtxCache.delete(tabId);
  // Don't kill the agent run when its panel tab is closed — the user
  // may want automation to keep running on whichever tab they switch
  // to next. Just unpin so getActiveTab() can fall back to whatever
  // tab is currently active.
  try {
    if (_activeAgentRun && _activeAgentRun.panelTabId === tabId) {
      _activeAgentRun.panelTabId = null;
    }
    if (_agentRunContext && _agentRunContext.tabId === tabId) {
      _agentRunContext = _agentRunContext.windowId != null
        ? { windowId: _agentRunContext.windowId }
        : null;
    }
  } catch (_) {}
});

// Previously we aborted the agent run on user-initiated navigation
// (refresh / URL change) of the panel tab. The user explicitly asked
// for the OPPOSITE behavior: keep the run alive across refresh / new
// tab / tab close so that long-running automation can't be killed by
// accident. The chat panel's overlay re-appears on the new page via
// PANEL_LOADED_RESET_RUN -> _applyAgentRunState(resp).

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

        // Handle CLI presence-check responses from the bridge
        if (message.type === "CHECK_CLI_BINARY_RESPONSE") {
          const pending = pendingCliChecks.get(message.id);
          if (pending) {
            pendingCliChecks.delete(message.id);
            pending.resolve({
              ok: !!message.ok,
              version: message.version || "",
              error: message.error || null,
            });
          }
          return;
        }

        if (message.type === "AUTOMATION_SCRIPT_RESULT") {
          const pending = pendingAutomationRuns.get(message.id);
          if (pending) {
            pendingAutomationRuns.delete(message.id);
            pending.resolve(message.result || { ok: false, error: "Empty automation result" });
          }
          return;
        }

        if (message.type === "AUTOMATION_SCRIPT_VALIDATION") {
          const pending = pendingAutomationValidations.get(message.id);
          if (pending) {
            pendingAutomationValidations.delete(message.id);
            pending.resolve(message.result || { ok: false, error: "Empty validation result" });
          }
          return;
        }

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
            _streamBridgeRunEnd(pending, !!message.aborted);
            pending.resolve({
              type: "AI_CHAT_RESPONSE",
              response: message.response,
              toolCalls: message.toolCalls || [],
              model: message.model || null,
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
          // Bridge is actively driving tools => the agent is alive.
          // Reset the idle timeout for any in-flight AI request so we
          // don't surface a spurious "timed out" while automation runs.
          refreshAiRequestActivity();
          _streamBridgeToolEvent({
            phase: "start",
            tool: message.tool,
            args: message.params || {},
          });
          const result = await handleToolCallWithRecording(
            message.tool,
            message.params,
            message.id,
          );
          _streamBridgeToolEvent({
            phase: "end",
            tool: message.tool,
            ok: !result?.error,
            error: result?.error,
            result: _compactBridgeToolResult(result),
          });
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
const KEEPALIVE_INTERVAL_MS = 45000;
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
  if (message.type === "STOP_AGENT_RUN") {
    let stopped = _stopActiveAgentRun(message.reason || "stopped_by_user");
    if (!stopped && typeof message.runId === "string" && message.runId.startsWith("bridge_")) {
      const id = Number.parseInt(message.runId.slice("bridge_".length), 10);
      const pending = pendingAiRequests.get(id);
      if (pending) {
        _streamBridgeRunEnd(pending, true);
        pendingAiRequests.delete(id);
        try {
          pending.resolve({
            type: "AI_CHAT_RESPONSE",
            aborted: true,
            error: "Cancelled by user.",
          });
        } catch (_) {}
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "AI_CHAT_ABORT", id }));
          } catch (_) {}
        }
        stopped = true;
      }
    }
    sendResponse({ ok: stopped });
    return false;
  }

  // Fresh content-script load (post-refresh, new tab, or first inject).
  // We NEVER abort an active run here — the user wants the overlay to
  // persist across refresh / new tab / tab close. Just rebind
  // panelTabId so future tool stream events reach the freshly mounted
  // panel, then return the current run state so the panel can restore
  // its UI without an extra round-trip.
  if (message.type === "PANEL_LOADED_RESET_RUN") {
    const tid = sender?.tab?.id ?? null;
    let wasActive = false;
    let kept = false;
    try {
      if (tid != null) {
        _chatPanelReadyTabs.add(tid);
        _chatPanelInjectingTabs.delete(tid);
      }
      if (_activeAgentRun) {
        wasActive = true;
        kept = true;
        if (tid != null) _activeAgentRun.panelTabId = tid;
      }
    } catch (_) {}
    sendResponse({ ok: true, wasActive, kept, ..._getActiveRunStatePayload() });
    return false;
  }

  // Query the current agent-run state. Used by the chat panel on load
  // so it can show the floating "automation running" overlay if a run
  // is genuinely still in flight.
  if (message.type === "GET_ACTIVE_RUN") {
    sendResponse(_getActiveRunStatePayload());
    return false;
  }

  // Best-effort "open the extension popup" request from chat-panel alerts.
  // chrome.action.openPopup is MV3-only and some Chrome versions require a
  // recent user gesture — we try, swallow errors, and return ok so the
  // caller doesn't surface yet another alert if it fails.
  // Return the list of models supported by the currently-configured AI
  // provider. Live fetch for openai-compatible + ollama; static catalog for
  // anthropic and CLI-backed IDE providers (no public list endpoint).
  if (message.type === "LIST_PROVIDER_MODELS") {
    _readCurrentProviderSettings()
      .then((settings) => {
        const cached = _getCachedProviderModels(settings);
        if (cached !== null) return cached;
        return _fetchProviderModels(settings).then((models) => {
          _setCachedProviderModels(settings, models);
          return models;
        });
      })
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err), models: [] }),
      );
    return true; // async response
  }

  if (message.type === "OPEN_POPUP") {
    try {
      if (chrome.action && typeof chrome.action.openPopup === "function") {
        chrome.action.openPopup(() => {
          try { void chrome.runtime.lastError; } catch (_) {}
        });
      }
    } catch (_) {}
    sendResponse({ ok: true });
    return false;
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

  // ─── CLI presence check (popup → bridge → spawn binary --version) ──
  if (message.type === "CHECK_CLI_BINARY") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({
        ok: false,
        error:
          "MCP bridge not connected. Click 'Connect / Start MCP' first — the CLI is launched by the bridge process, not the browser.",
      });
      return false;
    }
    const binary = (message.binary || "").trim();
    const kind = message.kind || "claude";
    if (!binary) {
      sendResponse({ ok: false, error: "No binary provided" });
      return false;
    }
    const id = ++cliCheckIdCounter;
    const timer = setTimeout(() => {
      if (pendingCliChecks.has(id)) {
        pendingCliChecks.delete(id);
        sendResponse({ ok: false, error: "Bridge did not respond in time" });
      }
    }, 8000);
    pendingCliChecks.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        sendResponse(r);
      },
    });
    try {
      ws.send(
        JSON.stringify({
          type: "CHECK_CLI_BINARY",
          id,
          binary,
          kind,
        }),
      );
    } catch (err) {
      pendingCliChecks.delete(id);
      clearTimeout(timer);
      sendResponse({ ok: false, error: err.message });
    }
    return true; // async
  }

  // ── ActionGate messages ─────────────────────────────────────
  if (message.type === "ACTION_GATE_DECISION") {
    const delivered = globalThis.AutoDOMActionGate?.deliverDecision(
      message.requestId,
      message.decision || { allowed: false, reason: "No decision" },
    );
    sendResponse({ ok: !!delivered });
    return false;
  }
  if (message.type === "ACTION_GATE_GET_STATE") {
    (async () => {
      const Gate = globalThis.AutoDOMActionGate;
      if (!Gate) return sendResponse({ ok: false, error: "ActionGate unavailable" });
      sendResponse({
        ok: true,
        settings: await Gate.getSettings(),
        permissions: await Gate.getPermissions(),
        audit: await Gate.getAuditLog(),
      });
    })();
    return true;
  }
  if (message.type === "ACTION_GATE_UPDATE_SETTINGS") {
    (async () => {
      const settings = await globalThis.AutoDOMActionGate?.setSettings(
        message.patch || {},
      );
      sendResponse({ ok: true, settings });
    })();
    return true;
  }
  if (message.type === "ACTION_GATE_REVOKE_ORIGIN") {
    (async () => {
      await globalThis.AutoDOMActionGate?.revokePermission(message.origin);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.type === "ACTION_GATE_CLEAR_PERMISSIONS") {
    (async () => {
      await globalThis.AutoDOMActionGate?.clearAllPermissions();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.type === "ACTION_GATE_CLEAR_AUDIT") {
    (async () => {
      await globalThis.AutoDOMActionGate?.clearAuditLog();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "RUN_AUTOMATION_SCRIPT") {
    const params = message.params || {};
    if ((params.backend || "browser-extension") === "browser-extension") {
      (async () => {
        try {
          const result = await toolRunBrowserScript({
            source: params.source || "",
            params: params.params || {},
            timeoutMs: params.timeoutMs || 15000,
          });
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, status: "error", error: err?.message || String(err) });
        }
      })();
      return true;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({
        ok: false,
        status: "error",
        error:
          "MCP bridge not connected. Connect MCP first to run Playwright/Node automation scripts locally.",
      });
      return false;
    }

    const id = ++automationRunIdCounter;
    const timeoutMs = params.timeoutMs || 60000;
    const timer = setTimeout(() => {
      if (pendingAutomationRuns.has(id)) {
        pendingAutomationRuns.delete(id);
        sendResponse({
          ok: false,
          status: "timeout",
          error: `Automation did not respond within ${timeoutMs}ms`,
        });
      }
    }, timeoutMs + 3000);
    pendingAutomationRuns.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        sendResponse(result);
      },
    });
    try {
      ws.send(
        JSON.stringify({
          type: "RUN_AUTOMATION_SCRIPT",
          id,
          params,
        }),
      );
    } catch (err) {
      pendingAutomationRuns.delete(id);
      clearTimeout(timer);
      sendResponse({ ok: false, status: "error", error: err.message });
    }
    return true;
  }

  if (message.type === "VALIDATE_AUTOMATION_SCRIPT") {
    const params = message.params || {};
    if ((params.backend || "browser-extension") === "browser-extension") {
      // MV3 service-worker CSP blocks `new Function` / eval, so parse-by-compile
      // isn't available here. Match the server's approach for Playwright/Node
      // (see server/automation/backends.js: validateAutomationScript) and defer
      // real syntax checking to run time, where the script is compiled in the
      // page's main world via executeInTab.
      const src = String(params.source || "").trim();
      if (!src) {
        sendResponse({
          ok: false,
          backend: "browser-extension",
          error: "Script source is empty",
        });
      } else {
        sendResponse({ ok: true, backend: "browser-extension" });
      }
      return false;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({
        ok: false,
        error:
          "MCP bridge not connected. Connect MCP first to validate Playwright/Node scripts.",
      });
      return false;
    }
    const id = ++automationValidationIdCounter;
    const timer = setTimeout(() => {
      if (pendingAutomationValidations.has(id)) {
        pendingAutomationValidations.delete(id);
        sendResponse({ ok: false, error: "Validation did not respond in time" });
      }
    }, 8000);
    pendingAutomationValidations.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        sendResponse(result);
      },
    });
    try {
      ws.send(
        JSON.stringify({
          type: "VALIDATE_AUTOMATION_SCRIPT",
          id,
          params,
        }),
      );
    } catch (err) {
      pendingAutomationValidations.delete(id);
      clearTimeout(timer);
      sendResponse({ ok: false, error: err.message });
    }
    return true;
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
    const effectiveModel = _effectiveConfiguredProviderModel(aiProviderSettings);
    sendResponse({
      connected: isConnected,
      running: shouldRunMcp,
      port: getCurrentPort(),
      recording: sessionRecording.active,
      provider: {
        source: aiProviderSettings.source,
        apiKey: aiProviderSettings.apiKey,
        model: effectiveModel,
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
      // ── Local CLI provider settings (passed through to bridge) ──
      cliBinary: incomingProvider.cliBinary || "",
      cliKind: incomingProvider.cliKind || "",
      cliExtraArgs: incomingProvider.cliExtraArgs || "",
      enabled: incomingProvider.enabled === true,
      preset: incomingProvider.preset || "custom",
    };
    const effectiveModel = _effectiveConfiguredProviderModel(aiProviderSettings);
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
        aiProviderModel: aiProviderSettings.model,
        aiProviderBaseUrl: aiProviderSettings.baseUrl,
        aiProviderCliBinary: aiProviderSettings.cliBinary,
        aiProviderCliKind: aiProviderSettings.cliKind,
        aiProviderCliExtraArgs: aiProviderSettings.cliExtraArgs,
        aiProviderEnabled: aiProviderSettings.enabled,
        aiProviderPreset: aiProviderSettings.preset,
      },
      () => {
        _debugLog(
          "[AutoDOM SW] Provider settings persisted (apiKey kept in session storage only)",
        );
      },
    );
    _writeApiKey(aiProviderSettings.apiKey);
    // Defensive: drop any legacy plaintext key that may still be in
    // chrome.storage.local from prior versions.
    try {
      chrome.storage.local.remove("aiProviderApiKey");
    } catch (_) {}

    sendResponse({
      success: true,
      provider: {
        source: aiProviderSettings.source,
        apiKey: aiProviderSettings.apiKey,
        model: effectiveModel,
        baseUrl: aiProviderSettings.baseUrl,
      },
      statusText:
        aiProviderSettings.source === "ide"
          ? isConnected
            ? "Using IDE Agent over MCP"
            : "IDE Agent selected — connect MCP to enable full AI"
          : aiProviderSettings.apiKey
            ? `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} ready${effectiveModel ? ` · ${effectiveModel}` : ""}`
            : `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} selected — add API key to enable direct AI`,
    });

    chrome.runtime.sendMessage({
      type: "AI_PROVIDER_STATUS",
      provider: {
        source: aiProviderSettings.source,
        apiKey: aiProviderSettings.apiKey,
        model: effectiveModel,
        baseUrl: aiProviderSettings.baseUrl,
      },
      statusText:
        aiProviderSettings.source === "ide"
          ? isConnected
            ? "Using IDE Agent over MCP"
            : "IDE Agent selected — connect MCP to enable full AI"
          : aiProviderSettings.apiKey
            ? `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} ready${effectiveModel ? ` · ${effectiveModel}` : ""}`
            : `${aiProviderSettings.source === "openai" ? "GPT" : aiProviderSettings.source === "anthropic" ? "Claude" : "Provider"} selected — add API key to enable direct AI`,
    });

    return false;
  }

  // ─── Pre-activation Connection Test ──────────────────────────
  // Sends a lightweight request to the chosen provider to verify
  // the API key, base URL, and (where possible) the model are
  // reachable BEFORE the user enables the direct path. Inspired by
  // mostbean-cn/coding-switch's health-check pattern.
  //
  // The popup passes the *current form values* explicitly — we do NOT
  // read aiProviderSettings here so the user can test edits without
  // having to save them first.
  if (message.type === "TEST_AI_PROVIDER") {
    const p = message.provider || {};
    (async () => {
      try {
        const result = await _testProviderConnection(p);
        sendResponse({ success: true, ...result });
      } catch (err) {
        sendResponse({
          success: true,
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true; // async response
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
  // ─── ABORT_AI_CHAT ──────────────────────────────────────────
  // User pressed the stop button in the chat panel. Resolve every
  // pending AI request locally with a "cancelled" marker so the UI
  // returns to its idle state immediately, and forward an abort to
  // the bridge so it can suppress any in-flight tool calls / further
  // AI_CHAT_RESPONSE messages for those ids.
  if (message.type === "ABORT_AI_CHAT") {
    _stopActiveAgentRun("stopped_by_user");
    const cancelledIds = [];
    for (const [id, pending] of pendingAiRequests.entries()) {
      cancelledIds.push(id);
      _streamBridgeRunEnd(pending, true);
      pendingAiRequests.delete(id);
      try {
        pending.resolve({
          type: "AI_CHAT_RESPONSE",
          aborted: true,
          error: "Cancelled by user.",
        });
      } catch (_) {}
    }
    if (ws && ws.readyState === 1) {
      for (const id of cancelledIds) {
        try {
          ws.send(JSON.stringify({ type: "AI_CHAT_ABORT", id }));
        } catch (_) {}
      }
    }
    sendResponse({ ok: true, cancelled: cancelledIds.length });
    return false;
  }

  if (message.type === "CHAT_AI_MESSAGE") {
    const { text, context, conversationHistory, provider, attachments } = message;
    _debugLog(
      "[AutoDOM SW] CHAT_AI_MESSAGE received, text:",
      (text || "").substring(0, 80),
      Array.isArray(attachments) && attachments.length > 0
        ? `(+${attachments.length} image)`
        : "",
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
    // Only take the direct path when the user has explicitly enabled
    // the network provider via the popup toggle (and it passed the
    // pre-activation connection test). Without `enabled`, the chat
    // panel falls through to the IDE/MCP path.
    const isDirectProvider =
      aiProviderSettings.enabled === true &&
      (hasDirectKey || hasDirectAnthropic || isOllama);

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
    // Service worker calls OpenAI / Anthropic / Ollama API directly,
    // running an AGENT LOOP so the AI can read AND act on the page
    // (Playwright-style automation) without the IDE host.
    if (isDirectProvider) {
      _debugLog("[AutoDOM SW] Using DIRECT provider path for:", providerType);

      // Per-tab run lock — block overlapping agent runs on the same panel
      const lockKey = sender?.tab?.id || "popup";
      if (_agentRunLocks.has(lockKey)) {
        sendResponse({
          type: "AI_CHAT_RESPONSE",
          error:
            "An agent run is already in progress on this tab. Please wait for it to finish.",
        });
        return false;
      }
      _agentRunLocks.add(lockKey);

      (async () => {
        try {
          const effectiveModel = _effectiveConfiguredProviderModel(
            aiProviderSettings,
            message.model || null,
          );
          const normalizedProvider =
            providerType === "gpt" || providerType === "chatgpt"
              ? "openai"
              : providerType === "claude"
                ? "anthropic"
                : providerType;
          // Surface model/provider mismatch loudly instead of letting the
          // provider client silently fall back to a hardcoded default
          // (which was the root cause of "I picked Claude but it ran on
          // gpt-4.1-mini" reports).
          if (!effectiveModel) {
            const configured = String(aiProviderSettings.model || "").trim();
            const reason = configured
              ? `Configured model "${configured}" is not compatible with provider "${normalizedProvider}". Please pick a matching model in the popup.`
              : `No model configured for provider "${normalizedProvider}". Please pick a model in the popup.`;
            throw new Error(reason);
          }
          const result = await runAgentLoop({
            providerType: normalizedProvider,
            text,
            context: context || {},
            conversationHistory: conversationHistory || [],
            initialTabId: sender?.tab?.id,
            modelOverride: effectiveModel,
            attachments: Array.isArray(attachments) ? attachments : [],
          });
          _debugLog(
            "[AutoDOM SW] Agent loop finished, length:",
            (result.response || "").length,
            "toolCalls:",
            (result.toolCalls || []).length,
          );
          sendResponse({
            type: "AI_CHAT_RESPONSE",
            response: result.response,
            toolCalls: result.toolCalls || [],
            model: effectiveModel || null,
            error: null,
          });
        } catch (err) {
          _debugError("[AutoDOM SW] Agent loop error:", err.message);
          sendResponse({
            type: "AI_CHAT_RESPONSE",
            error: `${providerType} error: ${err.message}`,
          });
        } finally {
          _agentRunLocks.delete(lockKey);
        }
      })();

      return true; // Keep message channel open for async sendResponse
    }

    // ─── IDE / MCP Path (requires bridge server) ─────────────
    // Image attachments: the CLI/MCP bridge can't pipe image bytes to
    // the underlying CLI (Claude Code / Copilot / Codex). We used to
    // hard-fail the whole turn here — that broke the conversation flow.
    // Instead, gracefully degrade: drop the binaries, prepend a SHORT
    // hint to the outbound text so the model knows an image existed
    // (and is told NOT to claim it saw it), and continue. The user's
    // chat bubble in the UI still shows the original image. We
    // deliberately omit filenames here — many uploads come in with
    // throwaway names (IC0.png, image.png, screenshot.png) that the
    // model would otherwise echo back to the user.
    let outboundText = text || "";
    if (Array.isArray(attachments) && attachments.length > 0) {
      const note =
        `[Note: the user attached ${attachments.length} image(s), but this AI bridge is text-only and did NOT receive the pixel data. Do not describe or pretend to have seen the image. If you need the visuals, ask the user to describe them in one sentence.]`;
      outboundText = outboundText
        ? `${note}\n\n${outboundText}`
        : note;
    }

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
    const bridgeRunId = `bridge_${aiRequestId}`;
    const panelTabId = sender?.tab?.id ?? null;

    // Sanitize the outbound history: bound size, truncate older user
    // turns, and STRIP attachment binaries from prior turns so we don't
    // balloon the WS payload (or leak unsupported fields to the CLI).
    const sanitizedHistory = _compactHistoryForOutbound(conversationHistory, {
      sliceN: 12,
      stripAttachmentBinaries: true,
      maxOldUserChars: 500,
    });

    const aiMessage = {
      type: "AI_CHAT_REQUEST",
      id: aiRequestId,
      text: outboundText,
      context: context || {},
      conversationHistory: sanitizedHistory,
      provider: providerType,
      providerConfig: {
        provider: aiProviderSettings.source || "ide",
        cliBinary: aiProviderSettings.cliBinary || "",
        cliKind: aiProviderSettings.cliKind || "",
        cliExtraArgs: aiProviderSettings.cliExtraArgs || "",
        // Forward the model picker selection so CLI/IDE providers honour
        // the dropdown instead of silently using their built-in default.
        cliModel:
          (message.model || "").trim() ||
          (aiProviderSettings.model || "").trim() ||
          "",
      },
    };

    // Register the pending request first, then arm the idle timeout.
    // The timeout is reset on bridge activity (TOOL_CALL) so long-running
    // agent loops don't get killed mid-stream.
    pendingAiRequests.set(aiRequestId, {
      timeoutHandle: null,
      panelTabId,
      runId: bridgeRunId,
      resolve: (result) => {
        _debugLog(
          "[AutoDOM SW] AI response resolved for id:",
          aiRequestId,
          "hasError:",
          !!(result && result.error),
        );
        const pending = pendingAiRequests.get(aiRequestId);
        if (pending) _streamBridgeRunEnd(pending, !!result?.aborted);
        const entry = pendingAiRequests.get(aiRequestId);
        if (entry && entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
        sendResponse(result);
      },
    });
    armAiRequestTimeout(aiRequestId);

    try {
      _debugLog(
        "[AutoDOM SW] Sending AI_CHAT_REQUEST to bridge, id:",
        aiRequestId,
      );
      ws.send(JSON.stringify(aiMessage));
    } catch (err) {
      const entry = pendingAiRequests.get(aiRequestId);
      if (entry && entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
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

function _streamBridgeRunEnd(pending, aborted) {
  if (!pending || pending._runEnded) return;
  pending._runEnded = true;
  if (!pending._runStarted) return;
  _streamAgentToolEvent(pending.panelTabId, {
    phase: "run-end",
    runId: pending.runId,
    aborted: !!aborted,
  });
}

function _streamBridgeToolEvent(evt) {
  for (const pending of pendingAiRequests.values()) {
    if (!pending._runStarted) {
      pending._runStarted = true;
      _streamAgentToolEvent(pending.panelTabId, {
        phase: "run-start",
        runId: pending.runId,
      });
    }
    _streamAgentToolEvent(pending.panelTabId, {
      runId: pending.runId,
      ...evt,
    });
  }
}

function _compactBridgeToolResult(result) {
  if (result == null) return result;
  try {
    const json = JSON.stringify(result);
    if (json.length > 6000) {
      return {
        truncated: true,
        summary: json.substring(0, 6000),
      };
    }
  } catch (_) {
    return { summary: String(result).substring(0, 4000) };
  }
  return result;
}

// Idle timeout for an in-flight AI request. The IDE agent can run for a
// long time when it is chaining many tool calls (e.g. generating a Deluge
// function). We use an *idle* timer that is reset every time the bridge
// reports activity (a TOOL_CALL from the agent), so the user only sees a
// timeout when the bridge has actually gone silent.
// Disabled by default: the chat bar Stop action is the source of truth for
// cancelling automation. Some local CLI providers can run long tasks without
// streaming TOOL_CALL activity, and timing out the UI while automation keeps
// running is worse than waiting for an explicit stop.
const AI_REQUEST_IDLE_TIMEOUT_MS = 0;

function armAiRequestTimeout(id) {
  if (!AI_REQUEST_IDLE_TIMEOUT_MS || AI_REQUEST_IDLE_TIMEOUT_MS <= 0) return;
  const pending = pendingAiRequests.get(id);
  if (!pending) return;
  if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
  pending.timeoutHandle = setTimeout(() => {
    if (!pendingAiRequests.has(id)) return;
    const entry = pendingAiRequests.get(id);
    _streamBridgeRunEnd(entry, true);
    pendingAiRequests.delete(id);
    // Tell the bridge to abort the still-running agent loop so it
    // stops calling tools after we have already surfaced the timeout
    // to the UI. Without this, the chat shows "AI request timed out"
    // while the bridge keeps driving automation in the background.
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "AI_CHAT_ABORT", id }));
      } catch (_) {}
    }
    try {
      entry.resolve({
        type: "AI_CHAT_RESPONSE",
        error: "AI request timed out. The agent may be busy.",
      });
    } catch (_) {}
  }, AI_REQUEST_IDLE_TIMEOUT_MS);
}

function refreshAiRequestActivity() {
  // Any signal of life from the bridge (e.g. an incoming TOOL_CALL)
  // counts as activity for every in-flight AI request.
  for (const id of pendingAiRequests.keys()) {
    armAiRequestTimeout(id);
  }
}

// Pending CLI presence-check requests (popup → SW → bridge → spawn → back)
const pendingCliChecks = new Map();
let cliCheckIdCounter = 0;
const pendingAutomationRuns = new Map();
let automationRunIdCounter = 0;
const pendingAutomationValidations = new Map();
let automationValidationIdCounter = 0;

function resolvePendingAiRequests(error) {
  for (const [id, pending] of pendingAiRequests.entries()) {
    _streamBridgeRunEnd(pending, false);
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
  ["run_browser_script", toolRunBrowserScript],
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
  const pinnedWindowId = _agentRunContext?.windowId;
  if (_agentRunContext?.tabId != null) {
    try {
      return await chrome.tabs.get(_agentRunContext.tabId);
    } catch (_) {
      _agentRunContext =
        pinnedWindowId != null ? { windowId: pinnedWindowId } : null;
    }
  }
  const [tab] = await chrome.tabs.query(
    pinnedWindowId != null
      ? { active: true, windowId: pinnedWindowId }
      : { active: true, currentWindow: true },
  );
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

async function waitForTabComplete(tabId, timeout = 15000) {
  const initialTab = await chrome.tabs.get(tabId);
  if (initialTab.status === "complete") {
    return initialTab;
  }

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab || initialTab);
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete" || tab?.status === "complete") {
        finish(tab);
      }
    };

    const timer = setTimeout(() => {
      chrome.tabs
        .get(tabId)
        .then(finish)
        .catch(() => finish(initialTab));
    }, timeout);

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") {
          finish(tab);
        }
      })
      .catch(() => {});
  });
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
    const updatedTab = await chrome.tabs.update(tab.id, { url });
    return {
      success: true,
      url: updatedTab.pendingUrl || updatedTab.url || url,
      title: updatedTab.title,
      status: updatedTab.status,
    };
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
      el.scrollIntoView({ behavior: "auto", block: "center" });
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

  // Temporarily hide AutoDOM's own injected UI (chat panel, overlays,
  // stop button, run indicator) so the screenshot reflects what the
  // user is automating — not our own widgets. We also need to drop the
  // page-push class on <html> so the host page reflows to the full
  // viewport width; otherwise hiding the panel leaves a blank band on
  // the right where the panel's margin was reserving space.
  const HIDE_IDS = [
    "__autodom_chat_panel",
    "__autodom_inline_overlay",
    "__autodom_automation_overlay",
    "__autodom_automation_stop",
    "__autodom_run_indicator",
    "__bmcp_session_border",
    "__bmcp_session_border_badge",
  ];
  const HIDE_MARK = "data-autodom-screenshot-hidden";
  const PUSH_CLASS = "__autodom_panel_open";
  const PUSH_MARK = "data-autodom-screenshot-unpushed";

  async function setHiddenState(hidden) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        world: "MAIN",
        args: [HIDE_IDS, HIDE_MARK, PUSH_CLASS, PUSH_MARK, hidden],
        func: (ids, mark, pushClass, pushMark, on) => {
          for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (on) {
              if (!el.hasAttribute(mark)) {
                // Snapshot BOTH display + visibility so we can restore
                // exactly what was there (most callers don't set either,
                // so the snapshot is empty strings — restoring removes
                // the inline overrides cleanly).
                el.setAttribute(
                  mark,
                  JSON.stringify({
                    d: el.style.getPropertyValue("display"),
                    dp: el.style.getPropertyPriority("display"),
                    v: el.style.getPropertyValue("visibility"),
                    vp: el.style.getPropertyPriority("visibility"),
                  }),
                );
              }
              // display:none with !important beats every stylesheet rule
              // including the panel's own `display: flex !important`.
              // Removes the element from layout entirely, so it cannot
              // appear in the captured PNG.
              el.style.setProperty("display", "none", "important");
              el.style.setProperty("visibility", "hidden", "important");
            } else if (el.hasAttribute(mark)) {
              let prev = { d: "", dp: "", v: "", vp: "" };
              try { prev = JSON.parse(el.getAttribute(mark)) || prev; } catch (_) {}
              el.style.removeProperty("display");
              el.style.removeProperty("visibility");
              if (prev.d) el.style.setProperty("display", prev.d, prev.dp);
              if (prev.v) el.style.setProperty("visibility", prev.v, prev.vp);
              el.removeAttribute(mark);
            }
          }
          // Drop / restore the html.__autodom_panel_open class so the
          // host page reflows to the full viewport width during the
          // capture and snaps back afterwards. Marker attribute remembers
          // whether the class was originally present so we don't add it
          // back on pages where the panel was closed.
          const html = document.documentElement;
          if (html) {
            if (on) {
              if (html.classList.contains(pushClass)) {
                html.setAttribute(pushMark, "1");
                html.classList.remove(pushClass);
              }
              // Also clear the panel-width CSS variable so any host-page
              // CSS that depends on it reflows for the capture.
              const root = document.documentElement;
              if (root && root.style.getPropertyValue("--autodom-panel-w")) {
                root.setAttribute(
                  "data-autodom-prev-pw",
                  root.style.getPropertyValue("--autodom-panel-w"),
                );
                root.style.removeProperty("--autodom-panel-w");
              }
            } else {
              if (html.hasAttribute(pushMark)) {
                html.classList.add(pushClass);
                html.removeAttribute(pushMark);
              }
              const root = document.documentElement;
              if (root && root.hasAttribute("data-autodom-prev-pw")) {
                root.style.setProperty(
                  "--autodom-panel-w",
                  root.getAttribute("data-autodom-prev-pw"),
                );
                root.removeAttribute("data-autodom-prev-pw");
              }
            }
          }
        },
      });
    } catch (_e) {
      // Tab may not allow scripting (e.g. chrome:// pages); fall through.
    }
  }

  let hidden = false;
  try {
    await setHiddenState(true);
    hidden = true;
    // Two animation frames + a margin so the reflow + display-none
    // change paint before capture. captureVisibleTab snapshots the
    // current paint, so we MUST wait long enough for the compositor.
    await new Promise((r) => setTimeout(r, 120));

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params?.format || "png",
      quality: params?.quality || 80,
    });
    return { success: true, screenshot: dataUrl };
  } catch (err) {
    return { error: `Screenshot failed: ${err.message}` };
  } finally {
    if (hidden) await setHiddenState(false);
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
      el.scrollIntoView({ behavior: "auto", block: "center" });
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
    await new Promise((r) => setTimeout(r, 150));
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
        // Optionally switch to the new tab
        if (params?.switchTo !== false) {
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        resolve({
          success: true,
          newTab: {
            id: tab.id,
            title: tab.title,
            url: tab.pendingUrl || tab.url,
            status: tab.status,
            windowId: tab.windowId,
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
      const scrollBehavior = behavior || "auto";

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
    [direction ?? "down", amount ?? 500, selector ?? null, behavior ?? "auto"],
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
    await new Promise((r) => setTimeout(r, 100));
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
  const updatedTab = await waitForTabComplete(tab.id, timeout);
  if (updatedTab.status === "complete") {
    return {
      success: true,
      url: updatedTab.url,
      title: updatedTab.title,
      elapsed: Date.now() - startTime,
    };
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
      el.scrollIntoView({ behavior: "auto", block: "center" });
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
    return {
      success: true,
      tabId: tab.id,
      url: tab.pendingUrl || tab.url || url,
      title: tab.title,
      status: tab.status,
      windowId: tab.windowId,
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

// Combined broadcast to avoid multiple chrome.tabs.query calls
async function broadcastToAllTabs(messages) {
  try {
    const tabs = await chrome.tabs.query({});
    const needsPanel = messages.some(_messageNeedsChatPanel);
    for (const tab of tabs) {
      if (isInjectableTab(tab)) {
        if (needsPanel) await ensureChatPanelInjected(tab.id);
        for (const msg of messages) {
          chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
        }
      }
    }
  } catch {}
}

// Messages that target the chat-panel content script. When any of these
// are sent we make sure chat-panel.js is loaded into the target tab —
// it's lazy-loaded (not in `content_scripts`) to avoid paying the 2.8k
// LOC parse cost on every page load.
const _CHAT_PANEL_MESSAGE_TYPES = new Set([
  "SHOW_CHAT_PANEL",
  "HIDE_CHAT_PANEL",
  "TOGGLE_CHAT_PANEL",
  "TOGGLE_INLINE_AI",
  "MCP_STATUS_CHANGED",
  "AI_PROVIDER_STATUS",
]);
function _messageNeedsChatPanel(msg) {
  return msg && _CHAT_PANEL_MESSAGE_TYPES.has(msg.type);
}

async function ensureChatPanelInjected(tabId) {
  if (_chatPanelReadyTabs.has(tabId)) return true;
  if (_chatPanelInjectingTabs.has(tabId)) {
    return _chatPanelInjectingTabs.get(tabId);
  }
  const injectionPromise = (async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["common/webext-api.js", "content/chat-panel.js"],
      });
      return true;
    } catch (_) {
      // Restricted page (chrome://, file://, etc.) or tab gone — silent skip.
      _chatPanelReadyTabs.delete(tabId);
      return false;
    } finally {
      _chatPanelInjectingTabs.delete(tabId);
    }
  })();
  _chatPanelInjectingTabs.set(tabId, injectionPromise);
  return injectionPromise;
}

// Show border / chat state on refreshed tabs when MCP is connected, and
// always remount the chat panel when an agent run is active so the
// automation overlay + stop affordances survive reloads.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isInjectableTab(tab)) return;
  if (!isConnected && !_activeAgentRun) return;
  if (isConnected) {
    chrome.tabs
      .sendMessage(tabId, { type: "SHOW_SESSION_BORDER" })
      .catch(() => {});
  }
  const injected = await ensureChatPanelInjected(tabId);
  if (!injected) return;
  if (isConnected) {
    chrome.tabs.sendMessage(tabId, { type: "SHOW_CHAT_PANEL" }).catch(() => {});
  }
  if (_activeAgentRun) {
    chrome.tabs
      .sendMessage(tabId, _getAgentRunStateMessage())
      .catch(() => {});
  }
});

// ─── Keyboard Command Handlers ───────────────────────────────
// Handle manifest-registered keyboard shortcuts (Ctrl+Shift+K, Ctrl+Shift+L)
// These fire even when no popup/page is focused, unlike content-script listeners.
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return;

    if (command === "toggle-chat-panel") {
      // Open Chrome's native side panel — this is the primary chat
      // surface (Claude-extension style). Falls back to the in-page
      // injected panel only when sidePanel API is unavailable (older
      // Chrome, Firefox via manifest.firefox.json, restricted pages
      // where the side panel can't be opened).
      try {
        if (chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
          await chrome.sidePanel.open({ windowId: tab.windowId });
          return;
        }
      } catch (e) {
        _debugWarn?.("[AutoDOM] sidePanel.open failed, falling back:", e);
      }
      if (!tab.url || !isInjectableTab(tab)) return;
      await ensureChatPanelInjected(tab.id);
      chrome.tabs
        .sendMessage(tab.id, {
          type: "TOGGLE_CHAT_PANEL",
          mcpActive: isConnected,
        })
        .catch(() => {});
      return;
    }

    if (command === "toggle-inline-ai") {
      if (!tab.url || !isInjectableTab(tab)) return;
      await ensureChatPanelInjected(tab.id);
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

// Side panel: route the toolbar action click straight to the side
// panel (no popup). This must be configured at top level so it's
// idempotent across SW restarts; setPanelBehavior is harmless to
// re-call. Wrapped in try/catch because the API is Chrome-only and
// the same SW source is shared with the Firefox manifest variant.
try {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => _debugWarn?.("[AutoDOM] setPanelBehavior failed:", e));
  }
} catch (e) {
  _debugWarn?.("[AutoDOM] sidePanel API unavailable:", e);
}

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
    "aiProviderCliBinary",
    "aiProviderCliKind",
    "aiProviderCliExtraArgs",
    "aiProviderEnabled",
    "aiProviderPreset",
  ],
  async (result) => {
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

    // Migrate legacy plaintext key (chrome.storage.local) → session storage.
    let apiKey = await _readApiKey();
    if (!apiKey && result.aiProviderApiKey) {
      apiKey = result.aiProviderApiKey;
      _writeApiKey(apiKey);
      try {
        chrome.storage.local.remove("aiProviderApiKey");
        _debugLog(
          "[AutoDOM SW] Migrated legacy plaintext API key from local → session storage",
        );
      } catch (_) {}
    }

    aiProviderSettings = {
      source: result.aiProviderSource || "ide",
      apiKey,
      model: result.aiProviderModel || "",
      baseUrl: result.aiProviderBaseUrl || "",
      cliBinary: result.aiProviderCliBinary || "",
      cliKind: result.aiProviderCliKind || "",
      cliExtraArgs: result.aiProviderCliExtraArgs || "",
      enabled: result.aiProviderEnabled === true,
      preset: result.aiProviderPreset || "custom",
    };

    _debugLog(
      "[AutoDOM SW] Startup: loaded provider settings (apiKey from " +
        (_secretStorageIsSession ? "session" : "local-fallback") +
        " storage):",
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

async function toolRunBrowserScript(params) {
  const tab = await getActiveTab();
  const source = String(params?.source || "");
  const scriptParams = params?.params || {};
  const timeoutMs = params?.timeoutMs || params?.timeout || 15000;
  if (!source.trim()) {
    return { ok: false, status: "validation_error", error: "Script source is empty" };
  }

  return await executeInTab(
    tab.id,
    (source, scriptParams, timeoutMs) => {
      return new Promise((resolve) => {
        const logs = [];
        const startedAt = Date.now();
        const log = (...args) => {
          logs.push(
            args
              .map((v) => {
                try {
                  return typeof v === "string" ? v : JSON.stringify(v);
                } catch (_) {
                  return String(v);
                }
              })
              .join(" "),
          );
        };
        const finish = (payload) => {
          clearTimeout(timer);
          resolve({
            backend: "browser-extension",
            elapsedMs: Date.now() - startedAt,
            logs,
            ...payload,
          });
        };
        const timer = setTimeout(() => {
          finish({
            ok: false,
            status: "timeout",
            error: `Browser script timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);

        try {
          const fn = new Function(
            "params",
            "log",
            `"use strict"; return (async () => {\n${source}\n})()`,
          );
          Promise.resolve(fn(scriptParams, log))
            .then((value) => {
              try {
                finish({
                  ok: true,
                  status: "completed",
                  result: JSON.parse(JSON.stringify(value ?? null)),
                });
              } catch (_) {
                finish({ ok: true, status: "completed", result: String(value) });
              }
            })
            .catch((err) => {
              finish({
                ok: false,
                status: "failed",
                error: err?.message || String(err),
              });
            });
        } catch (err) {
          finish({
            ok: false,
            status: "validation_error",
            error: err?.message || String(err),
          });
        }
      });
    },
    [source, scriptParams, timeoutMs],
  );
}

// get_dom_state: Compact map of interactive elements with numeric indices.
// Returns ~2-5K chars instead of 500K+ for full snapshots.
async function toolGetDomState(params) {
  const tab = await getActiveTab();
  const includeHidden = params?.includeHidden || false;
  const maxElements = params?.maxElements || 80;

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
        '[tabindex]:not([tabindex="-1"])',
        "[contenteditable]",
        "details > summary",
      ];
      const INTERACTIVE_QUERY = INTERACTIVE_SELECTORS.join(",");
      const INTERACTIVE_ROLES = new Set([
        "button",
        "link",
        "tab",
        "menuitem",
        "checkbox",
        "radio",
        "switch",
        "combobox",
        "slider",
        "textbox",
      ]);
      const EXTENSION_UI_SELECTOR = [
        "#__autodom_chat_panel",
        "#__autodom_inline_overlay",
        "#__autodom_automation_overlay",
        "#__autodom_automation_stop",
        "#__bmcp_session_border",
        "#__bmcp_session_border_badge",
      ].join(",");
      const APP_CHROME_SELECTOR =
        "nav,aside,header,footer,[role='navigation']";
      const ROOT_CANDIDATE_SELECTORS = [
        "main",
        '[role="main"]',
        "article",
        "#main",
        "#content",
        "#main-content",
        ".main",
        ".main-content",
        ".content",
        ".content-area",
        ".page-content",
        ".workspace",
        '[data-testid*="main"]',
        '[data-testid*="content"]',
        '[data-role="main"]',
      ];
      const OVERLAY_CANDIDATE_SELECTORS = [
        '[role="dialog"]',
        '[aria-modal="true"]',
        ".modal",
        ".popup",
        ".popover",
        ".dialog",
        ".dropdown-menu",
        "[data-popup]",
        "[data-modal]",
      ];

      function isVisible(el) {
        if (includeHidden) return true;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      }

      function isExtensionUi(el) {
        return !!(EXTENSION_UI_SELECTOR && el.closest(EXTENSION_UI_SELECTOR));
      }

      function isNoisyContainer(el) {
        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (INTERACTIVE_ROLES.has(role)) return false;
        if (
          el.matches("a[href], button, input, textarea, select, summary") ||
          el.isContentEditable ||
          el.hasAttribute("onclick")
        ) {
          return false;
        }
        if (!["div", "section", "main", "article", "nav", "aside"].includes(tag)) {
          return false;
        }
        return el.querySelectorAll(INTERACTIVE_QUERY).length >= 4;
      }

      function describeRoot(root, strategy) {
        if (!root || root === document.body || root === document.documentElement) {
          return { strategy, label: "document body" };
        }
        const tag = root.tagName ? root.tagName.toLowerCase() : "section";
        const label =
          root.getAttribute("aria-label") ||
          (root.id ? `#${root.id}` : "") ||
          (typeof root.className === "string" && root.className.trim()
            ? "." + root.className.trim().split(/\s+/).slice(0, 2).join(".")
            : "") ||
          tag;
        return { strategy, label: `${tag} ${label}`.trim() };
      }

      function serializeElement(el, index) {
        const tag = el.tagName.toLowerCase();
        const entry = { index, tag };

        const text = (el.textContent || "").trim().replace(/\s+/g, " ");
        if (text) entry.text = text.substring(0, 80);

        const type = el.getAttribute("type");
        if (type) entry.type = type;

        const name = el.getAttribute("name");
        if (name) entry.name = name;

        const placeholder = el.getAttribute("placeholder");
        if (placeholder) entry.placeholder = placeholder.substring(0, 80);

        const href = el.getAttribute("href");
        if (href) entry.href = href.substring(0, 120);

        const role = el.getAttribute("role");
        if (role) entry.role = role;

        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) entry.ariaLabel = ariaLabel.substring(0, 80);

        const value = el.value;
        if (value && tag !== "a") entry.value = String(value).substring(0, 80);

        const id = el.id;
        if (id) entry.id = id;

        if (id) {
          entry.selector = `#${CSS.escape(id)}`;
        } else if (name) {
          entry.selector = `${tag}[name="${CSS.escape(name)}"]`;
        }

        return entry;
      }

      function collectElements(root, excludeChrome) {
        const seen = new Set();
        const elements = [];
        const allEls = root.querySelectorAll(INTERACTIVE_QUERY);

        for (const el of allEls) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (el.closest("script, style, noscript")) continue;
          if (isExtensionUi(el)) continue;
          if (excludeChrome && el.closest(APP_CHROME_SELECTOR)) continue;
          if (!isVisible(el)) continue;
          if (isNoisyContainer(el)) continue;

          elements.push(serializeElement(el, elements.length));
          if (elements.length >= maxElements) break;
        }

        return elements;
      }

      function pickPreferredRoot() {
        const seenRoots = new Set();
        let best = null;
        let bestScore = 0;

        const consider = (root) => {
          if (!root || seenRoots.has(root) || isExtensionUi(root) || !isVisible(root)) {
            return;
          }
          seenRoots.add(root);
          const rect = root.getBoundingClientRect();
          const score = Math.max(0, rect.width) * Math.max(0, rect.height);
          if (score > bestScore) {
            best = root;
            bestScore = score;
          }
        };

        ROOT_CANDIDATE_SELECTORS.forEach((selector) => {
          document.querySelectorAll(selector).forEach(consider);
        });

        const probe = document.elementFromPoint(
          Math.min(window.innerWidth - 40, Math.floor(window.innerWidth * 0.66)),
          Math.min(window.innerHeight - 40, Math.max(80, Math.floor(window.innerHeight * 0.28))),
        );
        if (probe) {
          consider(probe.closest(ROOT_CANDIDATE_SELECTORS.join(",")));
        }

        return best;
      }

      function pickVisibleOverlay() {
        let best = null;
        let bestScore = 0;
        document
          .querySelectorAll(OVERLAY_CANDIDATE_SELECTORS.join(","))
          .forEach((el) => {
            if (isExtensionUi(el) || !isVisible(el)) return;
            const text = (el.textContent || "").trim();
            if (!text && el.querySelectorAll(INTERACTIVE_QUERY).length === 0) {
              return;
            }
            const rect = el.getBoundingClientRect();
            const score = Math.max(1, rect.width) * Math.max(1, rect.height);
            if (score > bestScore) {
              best = el;
              bestScore = score;
            }
          });
        return best;
      }

      let scope = { strategy: "document-filtered", label: "document body" };
      let elements = [];

      const overlayRoot = pickVisibleOverlay();
      if (overlayRoot) {
        elements = collectElements(overlayRoot, false);
        scope = describeRoot(overlayRoot, "visible-overlay");
      }

      const preferredRoot = elements.length ? null : pickPreferredRoot();
      if (preferredRoot) {
        elements = collectElements(preferredRoot, true);
        scope = describeRoot(preferredRoot, "main-root");
      }

      if (elements.length < Math.min(maxElements, 8)) {
        const fallback = collectElements(document, true);
        if (fallback.length > elements.length) {
          elements = fallback;
          scope = { strategy: "document-filtered", label: "document body" };
        }
      }

      if (elements.length < Math.min(maxElements, 4)) {
        const fullPage = collectElements(document, false);
        if (fullPage.length > elements.length) {
          elements = fullPage;
          scope = { strategy: "full-document", label: "document body" };
        }
      }

      return {
        title: document.title,
        url: location.href,
        scope,
        elementCount: elements.length,
        elements,
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
        '[tabindex]:not([tabindex="-1"])',
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
          el.scrollIntoView({ behavior: "auto", block: "center" });
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
        '[tabindex]:not([tabindex="-1"])',
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
        // Let Chrome attach the initial tab, then return promptly.
        await new Promise((r) => setTimeout(r, 300));
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
          el.scrollIntoView({ behavior: "auto", block: "center" });
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
            '[tabindex]:not([tabindex="-1"])',
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
          return {
            title: document.title,
            url: location.href,
            elementCount: elements.length,
            elements: Object.fromEntries(elements.entries()),
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
        el.scrollIntoView({ behavior: "auto", block: "center" });
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
          '[tabindex]:not([tabindex="-1"])',
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
        return { elementCount: elements.length, elements: Object.fromEntries(elements.entries()) };
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
