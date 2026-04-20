/**
 * AutoDOM — In-Browser AI Chat Panel (MCP-Aware)
 *
 * Injects a floating sidebar chat panel into web pages that communicates
 * with MCP agents through the extension's service worker. The chat panel
 * is ONLY visible when MCP is actively connected — it hides completely
 * when there is no active MCP session.
 *
 * AI-Powered: Messages are routed through the MCP AI agent for context-aware
 * responses. The AI has full knowledge of the page DOM, can invoke tools,
 * and provides intelligent answers — like an inline GPT tool built into
 * the browser.
 *
 * Architecture:
 *   Chat Panel (content script)
 *     ←→ Service Worker
 *       ←→ MCP Bridge Server
 *         ←→ AI Agent (Claude, GPT, etc.)
 *
 * The panel can:
 *   - Send natural language requests routed to the MCP AI agent
 *   - Display AI responses with tool call results inline
 *   - Show page context (DOM state, URL, title) automatically
 *   - Provide quick actions for common tasks
 *   - Auto-hide when MCP disconnects
 *   - Be invoked via Ctrl/Cmd+Shift+K like an inline AI tool
 */

(function () {
  const PANEL_ID = "__autodom_chat_panel";
  const STYLE_ID = "__autodom_chat_style";
  const INLINE_OVERLAY_ID = "__autodom_inline_overlay";

  // Declared early so _log/_err closures can reference it without TDZ issues
  let _contextInvalidated = false;
  function _pushActivityLog(level, args) {
    try {
      chrome.runtime.sendMessage({
        type: "ACTIVITY_LOG_APPEND",
        level: level || "info",
        source: "chat-panel",
        text: args
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
          .join(" "),
      });
    } catch (_) {}
  }

  const _log = (...args) => {
    if (_contextInvalidated) return;
    _pushActivityLog("info", args);
  };
  const _err = (...args) => {
    if (_contextInvalidated) return;
    const joined = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg && typeof arg.message === "string") return arg.message;
        try {
          return String(arg);
        } catch (_) {
          return "";
        }
      })
      .join(" ");
    if (
      joined.includes("Extension context invalidated") ||
      joined.includes("Extension context was invalidated") ||
      joined.includes("message port closed") ||
      joined.includes("Receiving end does not exist")
    ) {
      return;
    }
    _pushActivityLog("error", args);
  };

  _log("Content script loading...");

  // Prevent double injection
  if (document.getElementById(PANEL_ID)) {
    _log("Panel already exists, skipping injection");
    return;
  }

  // ─── State ───────────────────────────────────────────────────
  let isOpen = false;
  let isMcpActive = false;
  let isConnected = false;
  let messages = [];
  let conversationHistory = [];
  let pendingRequests = new Map();
  let requestIdCounter = 0;
  let isProcessing = false;
  let inlineMode = false; // inline overlay mode (like browser atlas)
  let _statusPollInterval = null;

  // ─── Persistence Helpers ─────────────────────────────────
  const STORAGE_KEY_MESSAGES = "__autodom_chat_messages";
  const STORAGE_KEY_HISTORY = "__autodom_chat_history";
  const STORAGE_KEY_OPEN = "__autodom_chat_open";
  const MAX_PERSISTED_MESSAGES = 50;

  function persistChatState() {
    if (_contextInvalidated) return;
    try {
      const trimmedMessages = messages.slice(-MAX_PERSISTED_MESSAGES);
      const trimmedHistory = conversationHistory.slice(-MAX_PERSISTED_MESSAGES);
      sessionStorage.setItem(
        STORAGE_KEY_MESSAGES,
        JSON.stringify(trimmedMessages),
      );
      sessionStorage.setItem(
        STORAGE_KEY_HISTORY,
        JSON.stringify(trimmedHistory),
      );
      sessionStorage.setItem(STORAGE_KEY_OPEN, isOpen ? "1" : "0");
    } catch (_) {}
  }

  function restoreChatState() {
    try {
      const storedMessages = sessionStorage.getItem(STORAGE_KEY_MESSAGES);
      const storedHistory = sessionStorage.getItem(STORAGE_KEY_HISTORY);
      const storedOpen = sessionStorage.getItem(STORAGE_KEY_OPEN);
      if (storedMessages) {
        messages = JSON.parse(storedMessages);
      }
      if (storedHistory) {
        conversationHistory = JSON.parse(storedHistory);
      }
      return {
        hadMessages: messages.length > 0,
        wasOpen: storedOpen === "1",
      };
    } catch (_) {
      return { hadMessages: false, wasOpen: false };
    }
  }

  // ─── Inject Styles ─────────────────────────────────────────
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* ─── Tokens ───────────────────────────────────────────────── */
    /* Dark-only panel injected into host pages — no light mode needed */
    #${PANEL_ID},
    #${INLINE_OVERLAY_ID} {
      --c-bg:       #161618;
      --c-surface:  #1e1e21;
      --c-raised:   #262629;
      --c-border:   #2e2e32;
      --c-border-s: #3a3a3f;
      --c-text:     #e4e4e7;
      --c-text-2:   #a1a1a6;
      --c-text-3:   #8e8e97;
      --c-accent:   #e4e4e7;
      --c-accent-muted: #3a3a3f;
      --c-success:  #34d399;
      --c-danger:   #f87171;
      --c-warn:     #fbbf24;
      --c-info:     #818cf8;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --radius: 8px;
    }

    /* ─── Keyframes (minimal, purposeful) ─────────────────────── */
    @keyframes __autodom_slide_in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes __autodom_typing {
      0%, 60%, 100% { opacity: 0.25; }
      30% { opacity: 1; }
    }
    @keyframes __autodom_dot_pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    @media (prefers-reduced-motion: reduce) {
      #${PANEL_ID} *,
      #${INLINE_OVERLAY_ID} * {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }

    /* ─── Chat Panel (Sidebar) ────────────────────────────────── */
    #${PANEL_ID} {
      position: fixed;
      top: 0;
      right: 0;
      width: 400px;
      height: 100vh;
      background: var(--c-bg);
      border-left: 1px solid var(--c-border);
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      overflow: visible;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: var(--c-text);
      transform: translateX(100%);
      transition: transform 0.3s var(--ease-out);
      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.35);
      pointer-events: auto;
      /* a11y: landmark role applied in HTML */
    }
    #${PANEL_ID}.open {
      transform: translateX(0);
    }
    #${PANEL_ID} * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* ─── Header ──────────────────────────────────────────────── */
    .autodom-chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: var(--c-surface);
      border-bottom: 1px solid var(--c-border);
      flex-shrink: 0;
      gap: 6px;
      position: relative;
      overflow: visible;
      min-height: 44px;
    }
    .autodom-chat-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }

    /* Close Button */
    .autodom-chat-close-btn {
      position: absolute;
      top: 10px;
      left: -48px;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      background: var(--c-surface);
      border: 1px solid var(--c-border-s);
      color: var(--c-text-2);
      cursor: pointer;
      border-radius: var(--radius);
      transition: color 0.15s ease, background-color 0.15s ease, opacity 0.2s ease;
      font-family: inherit;
      opacity: 0;
      pointer-events: none;
      /* a11y: 40×40 meets WCAG 2.5.8 Target Size minimum */
    }
    #${PANEL_ID}.open .autodom-chat-close-btn {
      opacity: 1;
      pointer-events: auto;
    }
    .autodom-chat-close-btn:hover {
      background: var(--c-raised);
      color: var(--c-danger);
    }
    .autodom-chat-close-btn:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }
    .autodom-chat-close-btn svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* Logo */
    .autodom-chat-header-logo {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      background: var(--c-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .autodom-chat-header-logo svg {
      width: 13px;
      height: 13px;
      fill: none;
      stroke: var(--c-bg);
      stroke-width: 2.5;
    }
    .autodom-chat-header-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--c-text);
      letter-spacing: -0.02em;
      white-space: nowrap;
    }

    /* Status Badge — moved to header-right, acts as the single connection indicator */
    .autodom-chat-header-status {
      font-size: 9px;
      padding: 3px 8px;
      border-radius: 999px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      border: 1px solid transparent;
      transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
      white-space: nowrap;
      flex-shrink: 0;
      line-height: 1;
      display: inline-flex;
      align-items: center;
    }

    /* BETA Badge — subtle, doesn't compete with status */
    .autodom-chat-beta-badge {
      font-size: 8px;
      font-weight: 700;
      color: var(--c-text-3);
      background: var(--c-raised);
      border: 1px solid var(--c-border-s);
      padding: 2px 5px;
      border-radius: 3px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      flex-shrink: 0;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      white-space: nowrap;
    }
    .autodom-chat-header-status.connected {
      background: rgba(52, 211, 153, 0.1);
      border-color: rgba(52, 211, 153, 0.2);
      color: var(--c-success);
    }
    .autodom-chat-header-status.direct {
      background: rgba(129, 140, 248, 0.1);
      border-color: rgba(129, 140, 248, 0.2);
      color: var(--c-info);
    }
    .autodom-chat-header-status.disconnected {
      background: rgba(248, 113, 113, 0.1);
      border-color: rgba(248, 113, 113, 0.15);
      color: var(--c-danger);
    }
    .autodom-chat-header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .autodom-chat-header-btn {
      background: none;
      border: none;
      color: var(--c-text-3);
      cursor: pointer;
      padding: 6px;
      border-radius: 6px;
      transition: color 0.15s ease, background-color 0.15s ease;
      display: flex;
      align-items: center;
      min-width: 32px;
      min-height: 32px;
      justify-content: center;
    }
    .autodom-chat-header-btn:hover {
      color: var(--c-text);
      background: var(--c-raised);
    }
    .autodom-chat-header-btn:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }
    .autodom-chat-header-btn svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
    }

    /* AI Badge — hidden to reduce header density; info already conveyed by status badge */
    .autodom-ai-badge {
      display: none;
    }
    .autodom-ai-badge svg {
      width: 9px;
      height: 9px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
    }

    /* ─── Context Bar ─────────────────────────────────────────── */
    /* Removed redundant MCP indicator — status badge in header is sufficient */
    .autodom-chat-context {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--c-surface);
      border-bottom: 1px solid var(--c-border);
      font-size: 11px;
      color: var(--c-text-2);
      flex-shrink: 0;
      overflow: hidden;
      min-height: 34px;
    }
    .autodom-chat-context-icon {
      flex-shrink: 0;
      opacity: 0.5;
      display: flex;
      align-items: center;
    }
    .autodom-chat-context-icon svg {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      display: block;
    }
    .autodom-chat-context-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      font-weight: 500;
      line-height: 1.3;
    }
    .autodom-chat-context-mcp {
      display: none;
    }
    .autodom-chat-context-mcp .dot {
      display: none;
    }

    /* ─── Messages ────────────────────────────────────────────── */
    .autodom-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      scroll-behavior: smooth;
    }
    .autodom-chat-messages::-webkit-scrollbar {
      width: 4px;
    }
    .autodom-chat-messages::-webkit-scrollbar-track {
      background: transparent;
    }
    .autodom-chat-messages::-webkit-scrollbar-thumb {
      background: var(--c-border-s);
      border-radius: 2px;
    }

    .autodom-chat-msg {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.55;
      font-size: 13px;
      word-wrap: break-word;
      white-space: pre-wrap;
      animation: __autodom_slide_in 0.2s var(--ease-out);
      position: relative;
    }

    /* User message */
    .autodom-chat-msg.user {
      align-self: flex-end;
      background: var(--c-accent);
      color: var(--c-bg);
      border-bottom-right-radius: 3px;
      font-weight: 500;
    }

    /* Assistant message */
    .autodom-chat-msg.assistant {
      align-self: flex-start;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      color: var(--c-text);
      border-bottom-left-radius: 3px;
    }

    /* AI response */
    .autodom-chat-msg.ai-response {
      align-self: flex-start;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      color: var(--c-text);
      border-bottom-left-radius: 3px;
    }
    .autodom-chat-msg.ai-response::before {
      content: '✦';
      position: absolute;
      top: -9px;
      left: 10px;
      font-size: 10px;
      color: var(--c-text-3);
      line-height: 1;
    }

    /* System message */
    .autodom-chat-msg.system {
      align-self: center;
      background: rgba(251, 191, 36, 0.08);
      border: 1px solid rgba(251, 191, 36, 0.15);
      color: var(--c-warn);
      font-size: 11px;
      padding: 5px 14px;
      border-radius: 999px;
      text-align: center;
      font-weight: 500;
    }

    /* Error message */
    .autodom-chat-msg.error {
      align-self: center;
      background: rgba(248, 113, 113, 0.08);
      border: 1px solid rgba(248, 113, 113, 0.15);
      color: var(--c-danger);
      font-size: 11px;
      padding: 5px 14px;
      border-radius: 999px;
      text-align: center;
      font-weight: 500;
    }

    /* Tool result */
    .autodom-chat-msg.tool-result {
      align-self: flex-start;
      background: var(--c-bg);
      border: 1px solid var(--c-border);
      font-family: var(--mono);
      font-size: 11px;
      color: var(--c-text-2);
      max-height: 200px;
      overflow-y: auto;
      border-radius: var(--radius);
    }
    .autodom-chat-msg .tool-name {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--c-raised);
      border: 1px solid var(--c-border);
      color: var(--c-text-2);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 6px;
      font-family: var(--mono);
      letter-spacing: 0.02em;
    }
    .autodom-chat-msg .ai-tool-calls {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--c-border);
      font-size: 11px;
      color: var(--c-text-3);
    }
    .autodom-chat-msg .ai-tool-call-item {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 3px 0;
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.4;
    }
    .autodom-chat-msg .ai-tool-call-item .tool-icon {
      color: var(--c-success);
      font-size: 11px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    /* ─── Typing Indicator ────────────────────────────────────── */
    .autodom-chat-typing {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-radius: 12px;
      border-bottom-left-radius: 3px;
      min-height: 40px;
    }
    .autodom-chat-typing .ai-thinking-label {
      font-size: 11px;
      color: var(--c-text-2);
      font-weight: 500;
      line-height: 1;
    }
    .autodom-chat-typing .dots {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .autodom-chat-typing .dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--c-text-3);
      animation: __autodom_typing 1.4s ease-in-out infinite;
    }
    .autodom-chat-typing .dots span:nth-child(2) { animation-delay: 0.2s; }
    .autodom-chat-typing .dots span:nth-child(3) { animation-delay: 0.4s; }

    /* ─── Quick Actions ───────────────────────────────────────── */
    .autodom-chat-quick-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-top: 1px solid var(--c-border);
      background: var(--c-surface);
      overflow-x: auto;
      flex-shrink: 0;
      -webkit-mask-image: linear-gradient(to right, #000 85%, transparent 100%);
      mask-image: linear-gradient(to right, #000 85%, transparent 100%);
    }
    .autodom-chat-quick-actions::-webkit-scrollbar {
      height: 0;
    }
    .autodom-chat-quick-btn {
      flex-shrink: 0;
      padding: 5px 10px;
      border-radius: 6px;
      background: var(--c-raised);
      border: 1px solid var(--c-border);
      color: var(--c-text-2);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
      font-family: inherit;
      white-space: nowrap;
      line-height: 1.3;
      display: inline-flex;
      align-items: center;
      min-height: 30px;
    }
    .autodom-chat-quick-btn:hover {
      background: var(--c-border-s);
      border-color: var(--c-border-s);
      color: var(--c-text);
    }
    .autodom-chat-quick-btn:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }
    .autodom-chat-quick-btn:active {
      opacity: 0.8;
    }
    .autodom-chat-quick-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    /* ─── Input Area ──────────────────────────────────────────── */
    .autodom-chat-input-area {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 10px 14px;
      background: var(--c-surface);
      border-top: 1px solid var(--c-border);
      flex-shrink: 0;
      /* a11y: textarea and send button both ≥40px touch targets */
    }
    .autodom-chat-input {
      flex: 1;
      min-height: 40px;
      max-height: 120px;
      padding: 9px 12px;
      background: var(--c-bg);
      border: 1px solid var(--c-border-s);
      border-radius: var(--radius);
      color: var(--c-text);
      font-family: inherit;
      font-size: 13px;
      line-height: 1.45;
      resize: none;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .autodom-chat-input:focus {
      border-color: var(--c-text-3);
    }
    .autodom-chat-input::placeholder {
      color: var(--c-text-3);
    }
    .autodom-chat-send-btn {
      width: 40px;
      height: 40px;
      border-radius: var(--radius);
      background: var(--c-accent-muted);
      border: 1px solid var(--c-border-s);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.15s ease, border-color 0.15s ease;
      flex-shrink: 0;
    }
    .autodom-chat-send-btn:hover {
      background: var(--c-border-s);
      border-color: var(--c-text-3);
    }
    .autodom-chat-send-btn:active {
      background: var(--c-raised);
    }
    .autodom-chat-send-btn:disabled {
      opacity: 0.25;
      cursor: not-allowed;
    }
    .autodom-chat-send-btn:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }
    .autodom-chat-send-btn svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: var(--c-text);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ─── Welcome Screen ──────────────────────────────────────── */
    .autodom-chat-welcome {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0;
      padding: 40px 24px 32px;
      text-align: center;
    }
    .autodom-chat-welcome-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--c-raised);
      border: 1px solid var(--c-border-s);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
    }
    .autodom-chat-welcome-icon::before {
      display: none;
    }
    .autodom-chat-welcome-icon svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: var(--c-text-3);
      stroke-width: 1.5;
    }
    .autodom-chat-welcome h3 {
      font-size: 14px;
      font-weight: 600;
      color: var(--c-text);
      letter-spacing: -0.01em;
      margin-bottom: 6px;
    }
    .autodom-chat-welcome p {
      font-size: 12px;
      color: var(--c-text-3);
      line-height: 1.6;
      max-width: 240px;
      margin-bottom: 20px;
    }
    .autodom-chat-welcome .shortcut-hint {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: var(--c-text-2);
      background: var(--c-surface);
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--c-border);
      font-weight: 500;
    }
    .autodom-chat-welcome .shortcut-hint kbd {
      font-family: var(--mono);
      font-size: 9px;
      background: var(--c-raised);
      padding: 2px 5px;
      border-radius: 3px;
      color: var(--c-text-2);
      border: 1px solid var(--c-border-s);
    }

    /* ─── Footer ──────────────────────────────────────────────── */
    .autodom-chat-footer {
      padding: 5px 14px;
      text-align: center;
      font-size: 10px;
      color: var(--c-text-3);
      border-top: 1px solid var(--c-border);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: var(--c-surface);
      line-height: 1;
    }
    .autodom-chat-footer .ai-powered {
      display: none;
    }
    .autodom-chat-footer .ai-powered svg {
      display: none;
    }

    /* ─── Inline Overlay (Spotlight-style) ─────────────────────── */
    #${INLINE_OVERLAY_ID} {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.96);
      width: 560px;
      max-width: 90vw;
      background: var(--c-bg);
      border: 1px solid var(--c-border-s);
      border-radius: 14px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.1);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s var(--ease-out);
      overflow: hidden;
    }
    #${INLINE_OVERLAY_ID}.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, -50%) scale(1);
    }
    #${INLINE_OVERLAY_ID} * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    .autodom-inline-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 16px 8px;
      font-size: 12px;
      color: var(--c-text-3);
    }
    .autodom-inline-header .logo {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background: var(--c-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .autodom-inline-header .logo svg {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: var(--c-bg);
      stroke-width: 2.5;
    }
    .autodom-inline-header .title {
      font-weight: 700;
      color: var(--c-text);
    }
    .autodom-inline-header .mcp-status {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: var(--c-success);
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
    }
    .autodom-inline-header .mcp-status .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--c-success);
      animation: __autodom_dot_pulse 2s ease-in-out infinite;
    }
    .autodom-inline-input-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px 14px;
    }
    .autodom-inline-input {
      flex: 1;
      height: 44px;
      padding: 0 14px;
      background: var(--c-surface);
      border: 1px solid var(--c-border-s);
      border-radius: var(--radius);
      color: var(--c-text);
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .autodom-inline-input:focus {
      border-color: var(--c-text-3);
    }
    .autodom-inline-input::placeholder {
      color: var(--c-text-3);
    }
    .autodom-inline-send {
      width: 44px;
      height: 44px;
      border-radius: var(--radius);
      background: var(--c-accent-muted);
      border: 1px solid var(--c-border-s);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.15s ease, border-color 0.15s ease;
      flex-shrink: 0;
    }
    .autodom-inline-send:hover {
      background: var(--c-border-s);
      border-color: var(--c-text-3);
    }
    .autodom-inline-send:active {
      background: var(--c-raised);
    }
    .autodom-inline-send:disabled {
      opacity: 0.25;
      cursor: not-allowed;
    }
    .autodom-inline-send:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }
    /* a11y: visible focus for inline hint buttons */
    .autodom-inline-hint:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }
    .autodom-inline-send svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: var(--c-text);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .autodom-inline-response {
      display: none;
      padding: 0 16px 14px;
      max-height: 300px;
      overflow-y: auto;
    }
    .autodom-inline-response.visible {
      display: block;
    }
    .autodom-inline-response-content {
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-radius: var(--radius);
      padding: 14px;
      font-size: 13px;
      color: var(--c-text);
      line-height: 1.55;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .autodom-inline-response-content .ai-sparkle {
      color: var(--c-text-3);
      margin-right: 4px;
    }
    .autodom-inline-response::-webkit-scrollbar {
      width: 4px;
    }
    .autodom-inline-response::-webkit-scrollbar-thumb {
      background: var(--c-border-s);
      border-radius: 2px;
    }
    .autodom-inline-hints {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 16px 12px;
      overflow-x: auto;
    }
    .autodom-inline-hints::-webkit-scrollbar { height: 0; }
    .autodom-inline-hint {
      flex-shrink: 0;
      padding: 5px 10px;
      border-radius: 6px;
      background: var(--c-raised);
      border: 1px solid var(--c-border);
      color: var(--c-text-2);
      font-size: 10px;
      font-weight: 500;
      cursor: pointer;
      transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
      font-family: inherit;
      white-space: nowrap;
      line-height: 1.3;
      display: inline-flex;
      align-items: center;
      min-height: 28px;
    }
    .autodom-inline-hint:hover {
      background: var(--c-border-s);
      border-color: var(--c-border-s);
      color: var(--c-text);
    }
    .autodom-inline-footer {
      padding: 8px 16px 10px;
      text-align: center;
      font-size: 10px;
      color: var(--c-text-3);
      border-top: 1px solid var(--c-border);
      background: var(--c-surface);
      letter-spacing: 0.01em;
    }
    .autodom-inline-footer kbd {
      font-family: var(--mono);
      font-size: 9px;
      background: var(--c-raised);
      padding: 2px 6px;
      border-radius: 3px;
      color: var(--c-text-2);
      border: 1px solid var(--c-border-s);
      margin: 0 1px;
    }

    /* Backdrop for inline overlay */
    .autodom-inline-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 2147483646;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .autodom-inline-backdrop.visible {
      opacity: 1;
      pointer-events: auto;
    }

    /* ─── Confirmation Prompt (Guardrails) ─────────────────── */
    .autodom-chat-msg.confirm-prompt {
      align-self: flex-start;
      background: var(--c-surface);
      border: 1px solid rgba(251, 191, 36, 0.25);
      color: var(--c-text);
      border-radius: 12px;
      border-bottom-left-radius: 3px;
      padding: 14px 16px;
      max-width: 92%;
      animation: __autodom_slide_in 0.2s var(--ease-out);
    }
    .confirm-prompt-icon {
      font-size: 18px;
      margin-bottom: 6px;
    }
    .confirm-prompt-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--c-warn);
      margin-bottom: 6px;
    }
    .confirm-prompt-reason {
      font-size: 12px;
      color: var(--c-text-2);
      line-height: 1.55;
      margin-bottom: 8px;
    }
    .confirm-prompt-details {
      font-size: 10px;
      font-family: var(--mono);
      color: var(--c-text-3);
      background: var(--c-bg);
      border: 1px solid var(--c-border);
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .confirm-prompt-buttons {
      display: flex;
      gap: 8px;
    }
    .confirm-prompt-btn {
      flex: 1;
      padding: 8px 14px;
      border-radius: 6px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s ease, background-color 0.15s ease;
      min-height: 36px;
    }
    .confirm-prompt-btn.confirm {
      background: var(--c-success);
      color: #0d1117;
    }
    .confirm-prompt-btn.confirm:hover {
      opacity: 0.85;
    }
    .confirm-prompt-btn.cancel {
      background: transparent;
      color: var(--c-danger);
      border: 1px solid rgba(248, 113, 113, 0.25);
    }
    .confirm-prompt-btn.cancel:hover {
      background: rgba(248, 113, 113, 0.08);
    }
    .confirm-prompt-btn:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(228, 228, 231, 0.15);
    }
    .confirm-prompt-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .confirm-prompt-btn:active {
      opacity: 0.7;
    }

    /* Responsive: narrow screens */
    @media (max-width: 480px) {
      #${PANEL_ID} {
        width: 100vw;
      }
      .autodom-chat-close-btn {
        left: auto;
        right: 8px;
        top: -48px;
        background: var(--c-surface);
        border-color: var(--c-border-s);
      }
      #${INLINE_OVERLAY_ID} {
        width: 95vw;
        border-radius: 10px;
      }
      .autodom-chat-quick-btn {
        min-height: 44px;
        padding: 8px 12px;
      }
      .confirm-prompt-btn {
        min-height: 44px;
      }
    }
  `;
  document.documentElement.appendChild(style);

  // Toggle button removed — it was obscuring the page.
  // Panel is opened via popup button, Ctrl+Shift+K, or service worker message.

  // ─── Chat Panel ────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "AutoDOM AI Chat");
  panel.innerHTML = `
    <!-- Header -->
    <div class="autodom-chat-header" role="banner">
      <!-- Close × button — overflows outside the panel left edge -->
      <button class="autodom-chat-close-btn" id="__autodom_close_btn" title="Close panel (Esc)" aria-label="Close chat panel">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <div class="autodom-chat-header-left">
        <div class="autodom-chat-header-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M8 10h8M8 14h5" stroke-linecap="round"/></svg>
        </div>
        <span class="autodom-chat-header-title">AutoDOM AI</span>
        <span class="autodom-ai-badge" aria-label="MCP AI mode">
          <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          MCP AI
        </span>
        <span class="autodom-chat-beta-badge" aria-label="Beta">BETA</span>
        <span class="autodom-chat-header-status disconnected" id="__autodom_status_badge" role="status" aria-live="polite">Offline</span>
      </div>
      <div class="autodom-chat-header-actions">
        <button class="autodom-chat-header-btn" id="__autodom_clear_btn" title="Clear conversation" aria-label="Clear conversation">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>

    <!-- Context Bar -->
    <div class="autodom-chat-context" role="status" aria-label="Page context">
      <span class="autodom-chat-context-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l2 2"/></svg>
      </span>
      <span class="autodom-chat-context-text" id="__autodom_context_text">Loading page context...</span>
      <span class="autodom-chat-context-mcp" id="__autodom_mcp_indicator" aria-label="MCP connection active">
        <span class="dot" aria-hidden="true"></span>
        MCP Active
      </span>
    </div>

    <!-- Messages Area -->
    <div class="autodom-chat-messages" id="__autodom_messages" role="log" aria-label="Chat messages" aria-live="polite">
      <div class="autodom-chat-welcome">
        <div class="autodom-chat-welcome-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </div>
        <h3>AutoDOM AI Assistant</h3>
        <p>Ask me anything about this page — I'll use AI + MCP tools to help you interact with, analyze, and automate the browser.</p>
        <div class="shortcut-hint" aria-label="Keyboard shortcuts: Ctrl+Shift+K to toggle, Ctrl+Shift+L for inline mode">
          Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> to toggle &middot; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> for inline mode
        </div>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="autodom-chat-quick-actions" id="__autodom_quick_actions" role="toolbar" aria-label="Quick actions">
      <button class="autodom-chat-quick-btn" data-action="dom_state">🔍 DOM State</button>
      <button class="autodom-chat-quick-btn" data-action="screenshot">📸 Screenshot</button>
      <button class="autodom-chat-quick-btn" data-action="page_info">ℹ\uFE0F Page Info</button>
      <button class="autodom-chat-quick-btn" data-action="summarize">📝 Summarize</button>
      <button class="autodom-chat-quick-btn" data-action="accessibility">♿ A11y Check</button>
    </div>

    <!-- Input Area -->
    <div class="autodom-chat-input-area">
      <textarea
        class="autodom-chat-input"
        id="__autodom_chat_input"
        placeholder="Ask AI anything about this page..."
        rows="1"
        aria-label="Chat message input"
      ></textarea>
      <button class="autodom-chat-send-btn" id="__autodom_send_btn" title="Send (Enter)" aria-label="Send message">
        <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>

    <!-- Footer -->
    <div class="autodom-chat-footer" role="contentinfo">
      AutoDOM
    </div>
  `;
  document.documentElement.appendChild(panel);

  // ─── Inline Overlay (Browser Atlas-style) ──────────────────
  const inlineBackdrop = document.createElement("div");
  inlineBackdrop.className = "autodom-inline-backdrop";
  document.documentElement.appendChild(inlineBackdrop);

  const inlineOverlay = document.createElement("div");
  inlineOverlay.id = INLINE_OVERLAY_ID;
  inlineOverlay.setAttribute("role", "dialog");
  inlineOverlay.setAttribute("aria-label", "AutoDOM AI Quick Prompt");
  inlineOverlay.setAttribute("aria-modal", "true");
  inlineOverlay.innerHTML = `
    <div class="autodom-inline-header">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M8 10h8M8 14h5" stroke-linecap="round"/></svg>
      </div>
      <span class="title">AutoDOM AI</span>
      <span class="autodom-chat-beta-badge" aria-label="Beta">BETA</span>
      <span class="mcp-status" id="__autodom_inline_status" role="status" aria-live="polite">
        <span class="dot" aria-hidden="true"></span>
        Connected
      </span>
    </div>
    <div class="autodom-inline-input-row">
      <input
        type="text"
        class="autodom-inline-input"
        id="__autodom_inline_input"
        placeholder="Ask AI to do something on this page..."
        autocomplete="off"
        aria-label="Quick AI prompt"
      />
      <button class="autodom-inline-send" id="__autodom_inline_send" title="Send" aria-label="Send prompt">
        <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <div class="autodom-inline-hints" id="__autodom_inline_hints" role="toolbar" aria-label="Suggested prompts">
      <button class="autodom-inline-hint" data-text="What's on this page?">What's on this page?</button>
      <button class="autodom-inline-hint" data-text="Take a screenshot">Screenshot</button>
      <button class="autodom-inline-hint" data-text="Show interactive elements">DOM State</button>
      <button class="autodom-inline-hint" data-text="Summarize this page">Summarize</button>
      <button class="autodom-inline-hint" data-text="Check accessibility">A11y Check</button>
    </div>
    <div class="autodom-inline-response" id="__autodom_inline_response" aria-live="polite">
      <div class="autodom-inline-response-content" id="__autodom_inline_response_content"></div>
    </div>
    <div class="autodom-inline-footer">
      <kbd>Esc</kbd> close &middot; <kbd>Enter</kbd> send &middot; <kbd>Ctrl+Shift+L</kbd> toggle
    </div>
  `;
  document.documentElement.appendChild(inlineOverlay);

  // ─── DOM References ────────────────────────────────────────
  const messagesContainer = document.getElementById("__autodom_messages");
  const chatInput = document.getElementById("__autodom_chat_input");
  const sendBtn = document.getElementById("__autodom_send_btn");
  const closeBtn = document.getElementById("__autodom_close_btn");
  const clearBtn = document.getElementById("__autodom_clear_btn");
  const statusBadge = document.getElementById("__autodom_status_badge");
  const contextText = document.getElementById("__autodom_context_text");
  const mcpIndicator = document.getElementById("__autodom_mcp_indicator");
  const quickActions = document.getElementById("__autodom_quick_actions");

  // Inline overlay refs
  const inlineInput = document.getElementById("__autodom_inline_input");
  const inlineSendBtn = document.getElementById("__autodom_inline_send");
  const inlineResponse = document.getElementById("__autodom_inline_response");
  const inlineResponseContent = document.getElementById(
    "__autodom_inline_response_content",
  );
  const inlineHints = document.getElementById("__autodom_inline_hints");

  // ─── MCP Visibility Control ────────────────────────────────
  // The chat button and panel are ONLY visible when MCP is active.
  // The toggle button is not even in the DOM until MCP activates.
  function setMcpActive(active) {
    _log("setMcpActive:", active, "was:", isMcpActive);
    isMcpActive = active;
    // MCP indicator in context bar is hidden via CSS — connection status
    // is shown solely through the header status badge (setConnectionStatus).
    if (!active) {
      // Auto-close panel when MCP disconnects
      if (isOpen) {
        addMessage("system", "MCP session ended. Chat panel will close.");
        setTimeout(() => closePanel(), 2000);
      }
      // Close inline overlay too
      if (inlineMode) {
        closeInlineOverlay();
      }
    }
  }

  // ─── Panel Toggle ──────────────────────────────────────────
  function openPanel() {
    _log("openPanel called, isOpen was:", isOpen);
    // Allow opening even without MCP — slash commands work offline.
    // The panel will show connection status to the user.
    isOpen = true;
    panel.classList.add("open");
    if (chatInput) {
      chatInput.focus();
    }
    updateContext();
    checkConnectionStatus();
    persistChatState();
  }

  function closePanel() {
    _log("closePanel called");
    isOpen = false;
    panel.classList.remove("open");
    persistChatState();
  }

  closeBtn.addEventListener("click", closePanel);

  // ─── Clear Conversation ────────────────────────────────────
  clearBtn.addEventListener("click", () => {
    messages = [];
    conversationHistory = [];
    persistChatState();
    messagesContainer.innerHTML = `
      <div class="autodom-chat-welcome">
        <div class="autodom-chat-welcome-icon">
          <svg viewBox="0 0 24 24">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </div>
        <h3>AutoDOM AI Assistant</h3>
        <p>Conversation cleared. Ask me anything about this page.</p>
      </div>
    `;
  });

  // ─── Inline Overlay Toggle ─────────────────────────────────
  function openInlineOverlay() {
    // Allow opening even without MCP — local commands still work
    inlineMode = true;
    inlineBackdrop.classList.add("visible");
    inlineOverlay.classList.add("visible");
    inlineInput.value = "";
    inlineResponse.classList.remove("visible");
    inlineResponseContent.textContent = "";
    inlineHints.style.display = "flex";
    setTimeout(() => inlineInput.focus(), 100);
  }

  function closeInlineOverlay() {
    inlineMode = false;
    inlineBackdrop.classList.remove("visible");
    inlineOverlay.classList.remove("visible");
  }

  inlineBackdrop.addEventListener("click", closeInlineOverlay);

  // ─── Context Update ────────────────────────────────────────
  function updateContext() {
    const title = document.title || "(untitled)";
    const url = location.href;
    const truncUrl = url.length > 60 ? url.substring(0, 57) + "..." : url;
    contextText.textContent = `${title} \u00B7 ${truncUrl}`;
  }

  // ─── Get Page Context for AI ───────────────────────────────
  // Gathers current page context to send alongside AI messages
  let _cachedPageContext = null;
  let _pageContextCacheTime = 0;
  const _PAGE_CONTEXT_TTL = 3000; // 3 second cache

  function getPageContext() {
    const now = Date.now();
    if (_cachedPageContext && now - _pageContextCacheTime < _PAGE_CONTEXT_TTL) {
      return _cachedPageContext;
    }

    const context = {
      url: location.href,
      title: document.title || "(untitled)",
      domain: location.hostname,
      pathname: location.pathname,
      readyState: document.readyState,
    };

    // Get visible text summary (first 2000 chars)
    try {
      const bodyText = document.body ? document.body.innerText : "";
      context.visibleTextPreview = bodyText.substring(0, 2000);
    } catch (_) {
      context.visibleTextPreview = "";
    }

    // Get some metadata
    try {
      const metas = document.querySelectorAll("meta[name], meta[property]");
      const metaData = {};
      metas.forEach((meta) => {
        const key = meta.getAttribute("name") || meta.getAttribute("property");
        if (key)
          metaData[key] = (meta.getAttribute("content") || "").substring(
            0,
            200,
          );
      });
      context.meta = metaData;
    } catch (_) {}

    // Count interactive elements
    try {
      context.interactiveElements = {
        links: document.querySelectorAll("a[href]").length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        inputs: document.querySelectorAll("input, textarea, select").length,
        forms: document.querySelectorAll("form").length,
      };
    } catch (_) {}

    _cachedPageContext = context;
    _pageContextCacheTime = now;
    return context;
  }

  // ─── Connection Status ─────────────────────────────────────
  let _lastKnownProvider = "ide";

  function setConnectionStatus(connected, _unused) {
    _log("setConnectionStatus:", connected, "was:", isConnected);
    isConnected = connected;
    if (statusBadge) {
      if (connected) {
        const isDirect =
          _lastKnownProvider !== "ide" && _lastKnownProvider !== "mcp";
        if (isDirect) {
          const label =
            _lastKnownProvider === "openai"
              ? "GPT"
              : _lastKnownProvider === "anthropic"
                ? "Claude"
                : _lastKnownProvider === "ollama"
                  ? "Ollama"
                  : "AI";
          statusBadge.textContent = `${label} Online`;
          statusBadge.className = "autodom-chat-header-status direct";
        } else {
          statusBadge.textContent = "AI Online";
          statusBadge.className = "autodom-chat-header-status connected";
        }
      } else {
        statusBadge.textContent = "Offline";
        statusBadge.className = "autodom-chat-header-status disconnected";
      }
    }
  }

  function _handleContextInvalidated() {
    if (_contextInvalidated) return;
    const wasOpen = isOpen;
    const wasInline = inlineMode;
    _contextInvalidated = true;
    if (_statusPollInterval) {
      clearInterval(_statusPollInterval);
      _statusPollInterval = null;
    }
    // Close panel/overlay gracefully without invoking logging paths after invalidation
    if (wasOpen) {
      isOpen = false;
      panel.classList.remove("open");
    }
    if (wasInline) {
      inlineMode = false;
      inlineBackdrop.classList.remove("visible");
      inlineOverlay.classList.remove("visible");
    }
    // Remove injected DOM so the fresh content script can re-inject
    try {
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove();
      const s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      const io = document.getElementById(INLINE_OVERLAY_ID);
      if (io) io.remove();
      const bd = document.querySelector(".autodom-inline-backdrop");
      if (bd) bd.remove();
    } catch (_) {}
  }

  function checkConnectionStatus(_unused) {
    if (_contextInvalidated) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const runtime = chrome && chrome.runtime;
        if (!runtime || !runtime.sendMessage || !runtime.id) {
          _handleContextInvalidated();
          resolve(false);
          return;
        }
        runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
          if (_contextInvalidated) {
            resolve(false);
            return;
          }

          let lastError = null;
          try {
            lastError = runtime.lastError;
          } catch (_) {
            _handleContextInvalidated();
            resolve(false);
            return;
          }

          if (lastError) {
            const msg = lastError.message || "";
            if (
              msg.includes("Extension context invalidated") ||
              msg.includes("Extension context was invalidated") ||
              msg.includes("message port closed") ||
              msg.includes("Receiving end does not exist")
            ) {
              _handleContextInvalidated();
              resolve(false);
              return;
            }
            _log("checkConnectionStatus: lastError:", msg);
            setConnectionStatus(false);
            resolve(false);
            return;
          }
          const bridgeConnected = !!(response && response.connected);
          // A direct provider (OpenAI/Anthropic/Ollama with key) counts
          // as "connected" even when the bridge server is offline.
          const providerSrc = response?.provider?.source || "ide";
          const hasDirectKey = !!(response?.provider?.apiKey || "").trim();
          const directProviderReady =
            providerSrc === "ollama" ||
            ((providerSrc === "openai" || providerSrc === "anthropic") &&
              hasDirectKey);
          const connected = bridgeConnected || directProviderReady;
          _lastKnownProvider = providerSrc;
          setConnectionStatus(connected);
          if (connected && !isMcpActive) {
            setMcpActive(true);
          }
          resolve(connected);
        });
      } catch (err) {
        const msg = (err && err.message) || String(err || "");
        if (
          msg.includes("Extension context invalidated") ||
          msg.includes("Extension context was invalidated") ||
          msg.includes("message port closed") ||
          msg.includes("Receiving end does not exist")
        ) {
          _handleContextInvalidated();
          resolve(false);
          return;
        }
        _err("checkConnectionStatus: exception:", msg);
        setConnectionStatus(false);
        resolve(false);
      }
    });
  }

  // Poll connection status every 5 seconds (faster than before to reduce stale state)
  _statusPollInterval = setInterval(checkConnectionStatus, 5000);
  checkConnectionStatus();

  // ─── Message Rendering ─────────────────────────────────────
  function clearWelcome() {
    const welcome = messagesContainer.querySelector(".autodom-chat-welcome");
    if (welcome) welcome.remove();
  }

  function addMessage(role, content, extra) {
    clearWelcome();

    const msg = document.createElement("div");
    msg.className = `autodom-chat-msg ${role}`;

    if (extra && extra.toolName) {
      const toolTag = document.createElement("div");
      toolTag.className = "tool-name";
      toolTag.textContent = extra.toolName;
      msg.appendChild(toolTag);
    }

    const textNode = document.createTextNode(content);
    msg.appendChild(textNode);

    // Show AI tool calls if present
    if (extra && extra.toolCalls && extra.toolCalls.length > 0) {
      const toolCallsDiv = document.createElement("div");
      toolCallsDiv.className = "ai-tool-calls";
      toolCallsDiv.textContent = "Tools used:";
      extra.toolCalls.forEach((tc) => {
        const item = document.createElement("div");
        item.className = "ai-tool-call-item";
        item.innerHTML = `<span class="tool-icon">\u2713</span> ${tc.tool || tc.name || tc}`;
        toolCallsDiv.appendChild(item);
      });
      msg.appendChild(toolCallsDiv);
    }

    messagesContainer.appendChild(msg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    messages.push({ role, content });
    persistChatState();
    return msg;
  }

  function showTyping() {
    clearWelcome();
    const typing = document.createElement("div");
    typing.className = "autodom-chat-typing";
    typing.id = "__autodom_typing";
    typing.setAttribute("role", "status");
    typing.setAttribute("aria-label", "AI is thinking");
    typing.innerHTML = `
      <span class="ai-thinking-label">AI thinking</span>
      <div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
    `;
    messagesContainer.appendChild(typing);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function hideTyping() {
    const typing = document.getElementById("__autodom_typing");
    if (typing) typing.remove();
  }

  function formatToolResult(result) {
    if (typeof result === "string") return result;
    try {
      const str = JSON.stringify(result, null, 2);
      if (str.length > 2000) {
        return str.substring(0, 2000) + "\n... (truncated)";
      }
      return str;
    } catch (_) {
      return String(result);
    }
  }

  // ─── Tool Execution via Service Worker ─────────────────────
  function callTool(toolName, params) {
    _log("callTool:", toolName, JSON.stringify(params));
    return new Promise((resolve) => {
      if (_contextInvalidated) {
        resolve({
          error: "Extension context invalidated — please reload the page.",
        });
        return;
      }
      const reqId = ++requestIdCounter;

      try {
        const runtime = chrome && chrome.runtime;
        if (!runtime || !runtime.sendMessage || !runtime.id) {
          _handleContextInvalidated();
          resolve({
            error: "Extension context invalidated — please reload the page.",
          });
          return;
        }
        runtime.sendMessage(
          {
            type: "CHAT_TOOL_CALL",
            requestId: reqId,
            tool: toolName,
            params: params || {},
          },
          (response) => {
            let lastError = null;
            try {
              lastError = runtime.lastError;
            } catch (_) {
              _handleContextInvalidated();
              resolve({
                error:
                  "Extension context invalidated — please reload the page.",
              });
              return;
            }
            if (lastError) {
              const msg = lastError.message || "";
              if (
                msg.includes("Extension context invalidated") ||
                msg.includes("Extension context was invalidated") ||
                msg.includes("message port closed") ||
                msg.includes("Receiving end does not exist")
              ) {
                _handleContextInvalidated();
                resolve({
                  error:
                    "Extension context invalidated — please reload the page.",
                });
                return;
              }
              _err("callTool error:", msg);
              resolve({ error: `Extension error: ${msg}` });
              return;
            }
            _log(
              "callTool response for",
              toolName,
              ":",
              response ? "OK" : "empty",
            );
            resolve(response || { error: "No response from service worker" });
          },
        );
      } catch (err) {
        const msg = (err && err.message) || String(err || "");
        if (
          msg.includes("Extension context invalidated") ||
          msg.includes("Extension context was invalidated") ||
          msg.includes("message port closed") ||
          msg.includes("Receiving end does not exist")
        ) {
          _handleContextInvalidated();
          resolve({
            error: "Extension context invalidated — please reload the page.",
          });
        } else {
          _err("callTool exception:", msg);
          resolve({ error: `Failed to call tool: ${msg}` });
        }
      }
    });
  }

  // ─── AI Chat via MCP ───────────────────────────────────────
  // Routes messages to the MCP AI agent for context-aware responses.
  // Falls back to local tool dispatch if AI routing is unavailable.
  function sendAiMessage(text) {
    _log("sendAiMessage:", text.substring(0, 80));
    return new Promise((resolve) => {
      if (_contextInvalidated) {
        resolve({
          fallback: true,
          error: "Extension context invalidated — please reload the page.",
        });
        return;
      }
      const context = getPageContext();

      try {
        const runtime = chrome && chrome.runtime;
        if (!runtime || !runtime.sendMessage || !runtime.id) {
          _handleContextInvalidated();
          resolve({
            fallback: true,
            error: "Extension context invalidated — please reload the page.",
          });
          return;
        }
        runtime.sendMessage(
          {
            type: "CHAT_AI_MESSAGE",
            text: text,
            context: context,
            conversationHistory: conversationHistory.slice(-20), // Last 20 messages
          },
          (response) => {
            let lastError = null;
            try {
              lastError = runtime.lastError;
            } catch (_) {
              _handleContextInvalidated();
              resolve({
                fallback: true,
                error:
                  "Extension context invalidated — please reload the page.",
              });
              return;
            }
            if (lastError) {
              const msg = lastError.message || "";
              if (
                msg.includes("Extension context invalidated") ||
                msg.includes("Extension context was invalidated") ||
                msg.includes("message port closed") ||
                msg.includes("Receiving end does not exist")
              ) {
                _handleContextInvalidated();
                resolve({
                  fallback: true,
                  error:
                    "Extension context invalidated — please reload the page.",
                });
                return;
              }
              _err("sendAiMessage lastError:", msg);
              // AI routing not available — fall back to local tool dispatch
              resolve({ fallback: true, error: msg });
              return;
            }
            _log(
              "sendAiMessage response:",
              JSON.stringify(response).substring(0, 200),
            );
            resolve(response || { fallback: true, error: "No response" });
          },
        );
      } catch (err) {
        const msg = (err && err.message) || String(err || "");
        if (
          msg.includes("Extension context invalidated") ||
          msg.includes("Extension context was invalidated") ||
          msg.includes("message port closed") ||
          msg.includes("Receiving end does not exist")
        ) {
          _handleContextInvalidated();
          resolve({
            fallback: true,
            error: "Extension context invalidated — please reload the page.",
          });
        } else {
          _err("sendAiMessage exception:", msg);
          resolve({ fallback: true, error: msg });
        }
      }
    });
  }

  // ─── Command Parser ────────────────────────────────────────
  // Parses slash commands and natural language into tool calls.
  // Used as a fallback when AI routing is not available, or for
  // direct tool invocations.

  function parseCommand(text) {
    const lower = text.toLowerCase().trim();

    // Direct tool invocation with /tool syntax
    if (lower.startsWith("/")) {
      const parts = text.substring(1).split(/\s+/);
      const tool = parts[0];
      const rest = parts.slice(1).join(" ");

      switch (tool) {
        case "screenshot":
        case "ss":
          return { tool: "take_screenshot", params: {} };
        case "snap":
        case "snapshot":
          return { tool: "take_snapshot", params: { maxDepth: 4 } };
        case "dom":
        case "domstate":
        case "state":
          return { tool: "get_dom_state", params: {} };
        case "info":
        case "pageinfo":
          return { tool: "get_page_info", params: {} };
        case "click":
          if (!isNaN(rest)) {
            return {
              tool: "click_by_index",
              params: { index: parseInt(rest) },
            };
          }
          return { tool: "click", params: { text: rest || undefined } };
        case "type":
        case "input": {
          const match = rest.match(/^(\d+)\s+(.+)$/);
          if (match) {
            return {
              tool: "type_by_index",
              params: {
                index: parseInt(match[1]),
                text: match[2],
                clearFirst: true,
              },
            };
          }
          return null;
        }
        case "nav":
        case "navigate":
        case "goto":
          return { tool: "navigate", params: { url: rest } };
        case "exec":
        case "js":
        case "eval":
          return { tool: "execute_code", params: { code: rest } };
        case "extract":
          return {
            tool: "execute_code",
            params: {
              code: `return document.body.innerText.substring(0, 3000);`,
            },
          };
        case "help":
          return { type: "help" };
        default:
          return { tool: tool, params: rest ? tryParseJSON(rest) : {} };
      }
    }

    // Not a slash command — return null to trigger AI routing
    return null;
  }

  function tryParseJSON(str) {
    try {
      return JSON.parse(str);
    } catch (_) {
      return { text: str };
    }
  }

  // ─── Send Message (Main Handler) ───────────────────────────
  async function sendMessage() {
    const text = chatInput.value.trim();
    _log(
      "sendMessage called, text:",
      text ? text.substring(0, 50) : "(empty)",
      "isProcessing:",
      isProcessing,
    );
    if (!text || isProcessing) return;

    addMessage("user", text);
    chatInput.value = "";
    autoResizeInput();

    // Add to conversation history for AI context
    conversationHistory.push({ role: "user", content: text });

    // Check for slash commands first (direct tool invocation)
    // Slash commands use local tool handlers and do NOT require MCP bridge
    const command = parseCommand(text);

    if (command && command.type === "help") {
      // Help is always available regardless of connection status
      const helpText =
        "\u{1F4D6} AutoDOM AI Chat Commands\n\n" +
        "AI Mode (default):\n" +
        "  Just type naturally — AI understands context!\n" +
        '  "Click the login button"\n' +
        '  "Summarize this page"\n' +
        '  "Fill in the form with test data"\n\n' +
        "Slash Commands (direct tool calls):\n" +
        "  /dom \u2014 Interactive elements map\n" +
        "  /click <index|text> \u2014 Click element\n" +
        "  /type <index> <text> \u2014 Type into element\n" +
        "  /nav <url> \u2014 Navigate to URL\n" +
        "  /screenshot \u2014 Capture page\n" +
        "  /snapshot \u2014 DOM tree snapshot\n" +
        "  /info \u2014 Page metadata\n" +
        "  /js <code> \u2014 Execute JavaScript\n" +
        "  /extract \u2014 Extract page text\n\n" +
        "Shortcuts:\n" +
        "  Ctrl+Shift+K \u2014 Toggle sidebar\n" +
        "  Ctrl+Shift+L \u2014 Inline AI overlay";
      addMessage("assistant", helpText);
      conversationHistory.push({ role: "assistant", content: helpText });
      return;
    }

    // If it's a slash command, execute directly via local tool handlers
    // (these don't require MCP bridge — they use chrome.scripting APIs)
    if (command && command.tool) {
      await executeToolCommand(command);
      return;
    }

    // ─── AI Mode ─────────────────────────────────────────────
    // Refresh connection status once, then route to MCP AI agent or fallback
    _log("AI mode: refreshing connection status...");
    const freshConnected = await checkConnectionStatus();
    _log(
      "AI mode: freshConnected =",
      freshConnected,
      "isConnected =",
      isConnected,
    );

    if (!freshConnected) {
      // Try local NLP-to-tool mapping as fallback even when disconnected
      const localCommand = parseNaturalLanguage(text);
      if (localCommand) {
        await executeToolCommand(localCommand);
        return;
      }
      addMessage(
        "system",
        "Not connected to any AI provider.\n\n" +
          "To enable AI chat, go to the AutoDOM extension popup → Config tab and select a provider:\n" +
          "• **Connect with GPT** — enter your OpenAI API key\n" +
          "• **Connect with Claude** — enter your Anthropic API key\n" +
          "• **Connect with Ollama** — free, runs locally (no key needed)\n\n" +
          "You can still use slash commands like /dom, /screenshot, /click, or /help while offline.",
      );
      return;
    }

    // Route to MCP AI agent for intelligent, context-aware response
    _log("Routing to MCP AI agent...");
    isProcessing = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      const aiResult = await sendAiMessage(text);

      _log(
        "AI result received:",
        aiResult ? JSON.stringify(aiResult).substring(0, 200) : "null",
      );
      hideTyping();

      if (aiResult && !aiResult.fallback && !aiResult.error) {
        // Successful AI response
        const responseText = aiResult.response || "AI processed your request.";
        const toolCalls = aiResult.toolCalls || [];
        _log(
          "AI success, response length:",
          responseText.length,
          "toolCalls:",
          toolCalls.length,
        );

        addMessage("ai-response", responseText, { toolCalls });
        conversationHistory.push({ role: "assistant", content: responseText });
      } else if (aiResult && aiResult.fallback) {
        _log("AI fallback, trying local NLP...");
        // AI routing not available — try local NLP-to-tool mapping
        const localCommand = parseNaturalLanguage(text);
        if (localCommand) {
          await executeToolCommand(localCommand);
        } else {
          // No local mapping either — provide helpful response
          addMessage(
            "assistant",
            "I understood your request but the AI agent isn't available right now. " +
              "Try using slash commands like /dom, /click, /screenshot, or /help for all options.\n\n" +
              "The full AI experience requires the MCP server to be connected to an AI agent (Claude, GPT, etc.) through your IDE.",
          );
          conversationHistory.push({
            role: "assistant",
            content: "AI agent not available. Suggested using slash commands.",
          });
        }
      } else if (aiResult && aiResult.error) {
        addMessage("error", `AI Error: ${aiResult.error}`);
      }
    } catch (err) {
      hideTyping();
      addMessage("error", `Failed: ${err.message}`);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
  }

  // ─── Natural Language → Tool Mapping ───────────────────────
  // Local fallback when AI agent is not available
  function parseNaturalLanguage(text) {
    const lower = text.toLowerCase().trim();

    if (
      lower.includes("screenshot") ||
      lower.includes("capture") ||
      lower === "ss"
    ) {
      return { tool: "take_screenshot", params: {} };
    }
    if (
      lower.includes("dom state") ||
      lower.includes("interactive elements") ||
      lower.includes("what can i click")
    ) {
      return { tool: "get_dom_state", params: {} };
    }
    if (
      lower.includes("page info") ||
      lower.includes("page details") ||
      lower.includes("what page")
    ) {
      return { tool: "get_page_info", params: {} };
    }
    if (
      lower.startsWith("go to ") ||
      lower.startsWith("navigate to ") ||
      lower.startsWith("open ")
    ) {
      const url = text.replace(/^(go to|navigate to|open)\s+/i, "").trim();
      const fullUrl = url.startsWith("http") ? url : `https://${url}`;
      return { tool: "navigate", params: { url: fullUrl } };
    }
    if (lower.startsWith("click ")) {
      const target = text.substring(6).trim();
      if (!isNaN(target)) {
        return { tool: "click_by_index", params: { index: parseInt(target) } };
      }
      return { tool: "click", params: { text: target } };
    }
    if (lower.includes("summarize") || lower.includes("summary")) {
      return {
        tool: "execute_code",
        params: { code: `return document.body.innerText.substring(0, 5000);` },
      };
    }
    if (
      lower.includes("extract") &&
      (lower.includes("text") || lower.includes("content"))
    ) {
      return {
        tool: "execute_code",
        params: { code: `return document.body.innerText.substring(0, 3000);` },
      };
    }
    if (lower.includes("scroll down")) {
      return { tool: "scroll", params: { direction: "down", amount: 500 } };
    }
    if (lower.includes("scroll up")) {
      return { tool: "scroll", params: { direction: "up", amount: 500 } };
    }
    if (lower.includes("accessibility") || lower.includes("a11y")) {
      return {
        tool: "execute_code",
        params: {
          code: `
            const issues = [];
            document.querySelectorAll('img').forEach(img => {
              if (!img.getAttribute('alt')) issues.push('Missing alt: ' + (img.src||'').substring(0,80));
            });
            document.querySelectorAll('input:not([type="hidden"]),textarea,select').forEach(inp => {
              const id = inp.id;
              const label = id ? document.querySelector('label[for="'+id+'"]') : null;
              const ariaLabel = inp.getAttribute('aria-label');
              if (!label && !ariaLabel && !inp.closest('label'))
                issues.push('Unlabeled: <' + inp.tagName.toLowerCase() + '> name=' + (inp.name||'(none)'));
            });
            const h1s = document.querySelectorAll('h1').length;
            if (h1s === 0) issues.push('No h1 element');
            if (h1s > 1) issues.push('Multiple h1: ' + h1s);
            return { issueCount: issues.length, issues: issues.slice(0, 20) };
          `,
        },
      };
    }
    if (lower.startsWith("run ") || lower.startsWith("execute ")) {
      const code = text.replace(/^(run|execute)\s+/i, "").trim();
      return { tool: "execute_code", params: { code } };
    }

    return null;
  }

  // ─── Execute Tool Command ──────────────────────────────────
  async function executeToolCommand(command) {
    _log(
      "executeToolCommand:",
      command.tool,
      JSON.stringify(command.params).substring(0, 100),
    );
    isProcessing = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      const result = await callTool(command.tool, command.params);
      _log(
        "Tool result for",
        command.tool,
        ":",
        result ? (result.error ? "ERROR: " + result.error : "OK") : "null",
      );
      hideTyping();

      // ─── Confirmation Required (Guardrails) ──────────────
      if (result && result.confirmRequired) {
        _log(
          "Confirmation required for",
          command.tool,
          "confirmId:",
          result.confirmId,
        );
        clearWelcome();
        const msg = document.createElement("div");
        msg.className = "autodom-chat-msg confirm-prompt";

        const shieldIcon = document.createElement("div");
        shieldIcon.className = "confirm-prompt-icon";
        shieldIcon.setAttribute("aria-hidden", "true");
        shieldIcon.innerHTML = "\u{1F6E1}\uFE0F";
        msg.appendChild(shieldIcon);

        const title = document.createElement("div");
        title.className = "confirm-prompt-title";
        title.setAttribute("role", "heading");
        title.setAttribute("aria-level", "4");
        title.textContent = "Confirmation Required";
        msg.appendChild(title);

        const reason = document.createElement("div");
        reason.className = "confirm-prompt-reason";
        reason.textContent =
          result.reason ||
          result.message ||
          `Action "${command.tool}" requires confirmation.`;
        msg.appendChild(reason);

        const details = document.createElement("div");
        details.className = "confirm-prompt-details";
        details.textContent =
          `Tool: ${command.tool}` +
          (result.domain ? ` | Domain: ${result.domain}` : "");
        msg.appendChild(details);

        const btnRow = document.createElement("div");
        btnRow.className = "confirm-prompt-buttons";

        const confirmBtn = document.createElement("button");
        confirmBtn.className = "confirm-prompt-btn confirm";
        confirmBtn.setAttribute(
          "aria-label",
          "Confirm and execute action: " + command.tool,
        );
        confirmBtn.textContent = "Confirm & Execute";
        confirmBtn.addEventListener("click", async () => {
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          confirmBtn.textContent = "Executing...";
          try {
            const confirmResult = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { type: "CONFIRM_SUBMIT_ACTION", confirmId: result.confirmId },
                (resp) => {
                  if (chrome.runtime.lastError) {
                    resolve({ error: chrome.runtime.lastError.message });
                  } else {
                    resolve(resp || { error: "No response" });
                  }
                },
              );
            });
            btnRow.remove();
            if (confirmResult && confirmResult.error) {
              addMessage("error", `Error: ${confirmResult.error}`);
            } else if (confirmResult && confirmResult.result) {
              const formatted = formatToolResult(confirmResult.result);
              addMessage("tool-result", formatted, { toolName: command.tool });
              conversationHistory.push({
                role: "assistant",
                content: `[Confirmed ${command.tool}]: ${formatted.substring(0, 500)}`,
              });
            } else {
              addMessage(
                "assistant",
                `\u2705 Action "${command.tool}" confirmed and executed.`,
              );
            }
          } catch (err) {
            addMessage("error", `Confirm failed: ${err.message}`);
          }
        });
        btnRow.appendChild(confirmBtn);

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "confirm-prompt-btn cancel";
        cancelBtn.setAttribute("aria-label", "Cancel action: " + command.tool);
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => {
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          chrome.runtime.sendMessage(
            { type: "CANCEL_SUBMIT_ACTION", confirmId: result.confirmId },
            () => {},
          );
          btnRow.remove();
          addMessage("system", `Action "${command.tool}" cancelled.`);
          conversationHistory.push({
            role: "assistant",
            content: `[Cancelled ${command.tool}]`,
          });
        });
        btnRow.appendChild(cancelBtn);

        msg.appendChild(btnRow);
        messagesContainer.appendChild(msg);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        messages.push({
          role: "assistant",
          content: `[Confirmation required for ${command.tool}]`,
        });
        conversationHistory.push({
          role: "assistant",
          content: `Confirmation required: ${result.reason || command.tool}`,
        });
        return;
      }

      // ─── Rate Limited (Guardrails) ───────────────────────
      if (result && result.rateLimited) {
        const resetSecs = result.resetInMs
          ? Math.ceil(result.resetInMs / 1000)
          : "?";
        addMessage(
          "error",
          `\u{1F6A6} Rate limit hit for ${result.domain || "this domain"}: ` +
            `${result.callsInWindow || "?"}/${result.budget || "?"} calls used. ` +
            `Resets in ${resetSecs}s.`,
        );
        conversationHistory.push({
          role: "assistant",
          content: `Rate limited on ${result.domain}: ${result.error}`,
        });
        return;
      }

      if (result && result.error) {
        addMessage("error", `Error: ${result.error}`);
        conversationHistory.push({
          role: "assistant",
          content: `Error: ${result.error}`,
        });
      } else if (result && result.screenshot) {
        // Screenshot: render as image
        clearWelcome();
        const msg = document.createElement("div");
        msg.className = "autodom-chat-msg assistant";

        const toolTag = document.createElement("div");
        toolTag.className = "tool-name";
        toolTag.textContent = "take_screenshot";
        msg.appendChild(toolTag);

        const img = document.createElement("img");
        img.src = result.screenshot;
        img.style.cssText = "max-width:100%;border-radius:6px;margin-top:6px;";
        img.alt = "Screenshot";
        msg.appendChild(img);

        messagesContainer.appendChild(msg);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        messages.push({ role: "assistant", content: "[screenshot]" });
        conversationHistory.push({
          role: "assistant",
          content: "[Screenshot captured]",
        });
      } else {
        const formatted = formatToolResult(result);
        addMessage("tool-result", formatted, { toolName: command.tool });
        conversationHistory.push({
          role: "assistant",
          content: `[Tool ${command.tool} result]: ${formatted.substring(0, 500)}`,
        });
      }
    } catch (err) {
      hideTyping();
      addMessage("error", `Failed: ${err.message}`);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
  }

  // ─── Input Handling ────────────────────────────────────────
  function autoResizeInput() {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  }

  chatInput.addEventListener("input", autoResizeInput);

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);

  // ─── Quick Actions ─────────────────────────────────────────
  quickActions.addEventListener("click", async (e) => {
    const btn = e.target.closest(".autodom-chat-quick-btn");
    if (!btn || isProcessing) return;

    const action = btn.dataset.action;
    let command;
    let displayText;

    switch (action) {
      case "dom_state":
        displayText = "/dom";
        command = { tool: "get_dom_state", params: {} };
        break;
      case "screenshot":
        displayText = "/screenshot";
        command = { tool: "take_screenshot", params: {} };
        break;
      case "page_info":
        displayText = "/info";
        command = { tool: "get_page_info", params: {} };
        break;
      case "summarize":
        displayText = "Summarize this page";
        command = {
          tool: "execute_code",
          params: {
            code: `return document.body.innerText.substring(0, 5000);`,
          },
        };
        break;
      case "accessibility":
        displayText = "/a11y check";
        command = {
          tool: "execute_code",
          params: {
            code: `
              const issues = [];
              document.querySelectorAll('img').forEach(img => {
                if (!img.getAttribute('alt')) issues.push('Missing alt: ' + (img.src||'').substring(0,80));
              });
              document.querySelectorAll('input:not([type="hidden"]),textarea,select').forEach(inp => {
                const id = inp.id;
                const label = id ? document.querySelector('label[for="'+id+'"]') : null;
                if (!label && !inp.getAttribute('aria-label') && !inp.closest('label'))
                  issues.push('Unlabeled: <' + inp.tagName.toLowerCase() + '> name=' + (inp.name||'(none)'));
              });
              const h1s = document.querySelectorAll('h1').length;
              if (h1s === 0) issues.push('No h1 element');
              if (h1s > 1) issues.push('Multiple h1: ' + h1s);
              return { issueCount: issues.length, issues: issues.slice(0, 20) };
            `,
          },
        };
        break;
      default:
        return;
    }

    addMessage("user", displayText);
    conversationHistory.push({ role: "user", content: displayText });

    // Quick actions use local tool handlers (chrome.scripting APIs) —
    // they do NOT require the MCP bridge server to be connected.
    await executeToolCommand(command);
  });

  // ─── Inline Overlay Send ───────────────────────────────────
  async function sendInlineMessage() {
    const text = inlineInput.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;
    inlineSendBtn.disabled = true;
    inlineHints.style.display = "none";
    inlineResponse.classList.add("visible");
    inlineResponseContent.innerHTML =
      '<span class="ai-sparkle">\u2728</span> AI thinking...';

    conversationHistory.push({ role: "user", content: text });

    try {
      // Try AI routing first
      const aiResult = await sendAiMessage(text);

      if (aiResult && !aiResult.fallback && !aiResult.error) {
        const responseText = aiResult.response || "Done.";
        inlineResponseContent.innerHTML =
          '<span class="ai-sparkle">\u2728</span> ' + escapeHtml(responseText);
        conversationHistory.push({ role: "assistant", content: responseText });
      } else {
        // Fallback: try local command parsing
        const command = parseCommand(text) || parseNaturalLanguage(text);
        if (command && command.tool) {
          const result = await callTool(command.tool, command.params);
          if (result && result.error) {
            inlineResponseContent.textContent = `Error: ${result.error}`;
          } else if (result && result.screenshot) {
            inlineResponseContent.innerHTML =
              '<span class="ai-sparkle">\u{1F4F8}</span> Screenshot captured! Open the sidebar to view it.';
          } else {
            const formatted = formatToolResult(result);
            inlineResponseContent.textContent = formatted.substring(0, 1000);
          }
        } else {
          inlineResponseContent.innerHTML =
            '<span class="ai-sparkle">\u2728</span> ' +
            (aiResult?.error
              ? escapeHtml(aiResult.error)
              : "Could not process. Try slash commands like /dom, /screenshot, /help");
        }
      }
    } catch (err) {
      inlineResponseContent.textContent = `Error: ${err.message}`;
    } finally {
      isProcessing = false;
      inlineSendBtn.disabled = false;
      inlineInput.value = "";
      inlineInput.focus();
    }
  }

  inlineInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendInlineMessage();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeInlineOverlay();
    }
  });

  inlineSendBtn.addEventListener("click", sendInlineMessage);

  // Inline hints
  inlineHints.addEventListener("click", (e) => {
    const hint = e.target.closest(".autodom-inline-hint");
    if (!hint) return;
    inlineInput.value = hint.dataset.text;
    inlineInput.focus();
  });

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Listen for status/control messages from service worker ─
  _log("Registering onMessage listener...");
  chrome.runtime.onMessage.addListener((message) => {
    if (_contextInvalidated) return;
    _log(
      "onMessage received:",
      message.type,
      message.mcpActive !== undefined ? "mcpActive=" + message.mcpActive : "",
    );
    // MCP status changed — show/hide chat panel toggle
    if (message.type === "MCP_STATUS_CHANGED") {
      const active = !!message.mcpActive;
      setConnectionStatus(active);
      // When mcpStopped is set, the session has truly ended (inactivity
      // timeout or explicit stop) — tear down the panel and border on
      // every tab, including non-active / background ones.
      if (message.mcpStopped && !active) {
        setMcpActive(false);
      } else if (active && !isMcpActive) {
        // Only promote to active — demoting tears down the panel and is
        // handled explicitly by HIDE_CHAT_PANEL when MCP truly stops.
        setMcpActive(true);
      }
    }

    // Explicit show/hide commands from service worker
    if (message.type === "SHOW_CHAT_PANEL") {
      setMcpActive(true);
      setConnectionStatus(true);
    }
    if (message.type === "HIDE_CHAT_PANEL") {
      setMcpActive(false);
      setConnectionStatus(false);
    }

    // Toggle chat panel (from popup or keyboard command)
    if (message.type === "TOGGLE_CHAT_PANEL") {
      _log(
        "TOGGLE_CHAT_PANEL: mcpActive=",
        message.mcpActive,
        "isOpen=",
        isOpen,
        "isMcpActive=",
        isMcpActive,
      );
      // Always toggle the panel regardless of mcpActive — slash commands
      // work offline. Refresh MCP state in the background after opening.
      if (message.mcpActive) {
        setMcpActive(true);
        setConnectionStatus(true);
      }
      isMcpActive = true;
      if (inlineMode) closeInlineOverlay();
      if (isOpen) {
        _log("Panel is open, closing...");
        closePanel();
      } else {
        _log("Panel is closed, opening...");
        openPanel();
        // Refresh MCP status in background after panel opens
        checkConnectionStatus();
      }
    }

    // Toggle inline AI overlay (from keyboard command Ctrl+Shift+L)
    if (message.type === "TOGGLE_INLINE_AI") {
      if (message.mcpActive) {
        setMcpActive(true);
        setConnectionStatus(true);
      }
      isMcpActive = true;
      if (isOpen) closePanel();
      if (inlineMode) {
        closeInlineOverlay();
      } else {
        openInlineOverlay();
        checkConnectionStatus();
      }
    }

    // Status updates from service worker
    if (message.type === "STATUS_UPDATE") {
      const connected = !!message.connected;
      setConnectionStatus(connected);
      // Only promote to active here. Explicit HIDE_CHAT_PANEL handles teardown
      // when the MCP session actually stops.
      if (connected && !isMcpActive) {
        setMcpActive(true);
      }

      // Show inactivity warnings in chat
      if (message.log && message.logLevel === "warn" && isOpen) {
        if (
          message.log.includes("idle") ||
          message.log.includes("Idle") ||
          message.log.includes("inactivity") ||
          message.log.includes("auto-closed")
        ) {
          addMessage("system", message.log);
        }
      }
    }

    if (message.type === "TOOL_CALLED" && isOpen) {
      // Show external tool calls in chat for transparency
      // (tools called by the IDE agent, not by our chat)
    }
  });

  // ─── Keyboard Shortcuts ────────────────────────────────────
  // Ctrl/Cmd + Shift + K → Toggle sidebar chat panel
  // Ctrl/Cmd + Shift + L → Toggle inline AI overlay (like Browser Atlas)
  // Escape → Close active panel/overlay
  document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd + Shift + K: Toggle sidebar
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "K") {
      e.preventDefault();
      isMcpActive = true;
      if (inlineMode) closeInlineOverlay();
      if (isOpen) {
        closePanel();
      } else {
        openPanel();
        checkConnectionStatus();
      }
    }

    // Ctrl/Cmd + Shift + L: Toggle inline AI overlay
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "L") {
      e.preventDefault();
      isMcpActive = true;
      if (isOpen) closePanel();
      if (inlineMode) {
        closeInlineOverlay();
      } else {
        openInlineOverlay();
        checkConnectionStatus();
      }
    }

    // Escape to close whatever is open
    if (e.key === "Escape") {
      if (inlineMode) {
        closeInlineOverlay();
      } else if (isOpen) {
        closePanel();
      }
    }
  });

  // ─── Initial Setup ─────────────────────────────────────────
  _log("Initial setup: checking connection, updating context...");
  _log("Panel element:", panel ? "OK" : "MISSING");
  _log("chatInput element:", chatInput ? "OK" : "MISSING");
  _log("sendBtn element:", sendBtn ? "OK" : "MISSING");
  _log("messagesContainer:", messagesContainer ? "OK" : "MISSING");
  // ─── Restore Persisted Chat State ──────────────────────────
  const restored = restoreChatState();
  if (restored.hadMessages) {
    // Re-render persisted messages into the DOM
    messagesContainer.innerHTML = "";
    messages.forEach((msg) => {
      const el = document.createElement("div");
      el.className = `autodom-chat-msg ${msg.role}`;
      el.appendChild(document.createTextNode(msg.content));
      messagesContainer.appendChild(el);
    });
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  if (restored.wasOpen) {
    // Re-open panel if it was open before reload/navigation
    isMcpActive = true;
    openPanel();
  }

  updateContext();

  // SPA navigation detection — uses History API interception instead of
  // a MutationObserver on the entire DOM tree. This eliminates thousands
  // of unnecessary callback invocations per second on dynamic pages.
  let _lastUrl = location.href;
  function _onUrlChange() {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      _cachedPageContext = null;
      updateContext();
    }
  }

  // Intercept pushState/replaceState for SPA routers
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    _origPushState.apply(this, args);
    _onUrlChange();
  };
  history.replaceState = function (...args) {
    _origReplaceState.apply(this, args);
    _onUrlChange();
  };
  // Back/forward navigation
  window.addEventListener("popstate", _onUrlChange);
  // hashchange for hash-based routers
  window.addEventListener("hashchange", _onUrlChange);
})();
