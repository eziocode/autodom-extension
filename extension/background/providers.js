/**
 * AutoDOM — Direct AI Provider clients (service-worker side).
 *
 * Loaded via importScripts() from service-worker.js. Exposes pure HTTP
 * wrappers for OpenAI, Anthropic, and Ollama so the giant SW file does
 * not have to inline ~150 LOC of provider plumbing.
 *
 * NOTE: A near-identical implementation exists in server/index.js
 * (callOpenAIProvider / callAnthropicProvider / callOllamaProvider) for
 * the IDE-side direct-provider path. The two paths intentionally take
 * their config from different places (extension settings vs. env vars),
 * so they have not been collapsed into a single shared module yet —
 * see audit report for the longer-term plan.
 *
 * The functions are attached to globalThis so the SW can call them as
 * `AutoDOMProviders.callDirectProvider(...)` after importScripts loads
 * this file.
 */
(function () {
  const ACCOUNT_CONTEXT_ID_RE =
    /\b(?:IC|CB)(?=[A-Z0-9_.-])(?:[A-Za-z0-9_.-]{1,})\b/g;

  function collapseOmittedAccountIds(text) {
    return String(text || "")
      .replace(
        /(?:\s*\[account identifier omitted\][,;|/\s-]*){3,}/g,
        " [multiple account identifiers omitted] ",
      )
      .split("\n")
      .map((line) => {
        const matches = line.match(/\[account identifier omitted\]/g) || [];
        if (matches.length < 2) return line;
        const remainder = line
          .replace(/\[account identifier omitted\]/g, "")
          .replace(/[,;|/\s_.-]/g, "");
        return remainder.length < 12
          ? "[multiple account identifiers omitted]"
          : line;
      })
      .join("\n")
      .replace(
        /(?:\[multiple account identifiers omitted\][,;|/\s-]*){2,}/g,
        "[multiple account identifiers omitted] ",
      );
  }

  function scrubContextIdentifiers(text) {
    const out = String(text || "")
      .replace(/\u0000(?:IC|CB)\d+\u0000/g, "")
      .replace(ACCOUNT_CONTEXT_ID_RE, "[account identifier omitted]");
    return collapseOmittedAccountIds(out);
  }

  // Trailing reply-style block appended to every system prompt. The
  // user picks one of these from the popup Chat tab; default is
  // "concise" which roughly matches Comet's ultra-tight summarizer.
  const RESPONSE_STYLE_INSTRUCTIONS = {
    concise:
      "Reply style — concise summarizer (DEFAULT, like Comet/Copilot quick answer):\n" +
      "- Open with a single one-line answer that resolves the user's question. No preamble, no restating the question.\n" +
      "- Then at most 3 short bullet points of supporting detail. Skip bullets entirely if the one-liner is sufficient.\n" +
      "- No headings. No closing summary. No 'I hope this helps'.\n",
    jetbrains:
      "Reply style — JetBrains AI Chat (structured assistant):\n" +
      "- Format using exactly these bold sections in this order, omitting any that don't apply:\n" +
      "  **Summary** — one short paragraph (≤2 lines).\n" +
      "  **Details** — focused bullets, each ≤1 sentence.\n" +
      "  **Next steps** — numbered list, only when the user can take a follow-up action.\n" +
      "- No filler outside those sections.\n",
    chatbar:
      "Reply style — GPT chatbar (conversational markdown):\n" +
      "- Friendly, second-person tone. Use **bold** for key terms and `code` for identifiers.\n" +
      "- Short paragraphs. Use bullets or numbered lists when listing >2 items.\n" +
      "- Headings (`###`) only when the reply runs longer than ~150 words.\n",
  };

  function _resolveResponseStyle(opts) {
    const raw = (opts && typeof opts.responseStyle === "string"
      ? opts.responseStyle
      : "concise").toLowerCase();
    return RESPONSE_STYLE_INSTRUCTIONS[raw]
      ? raw
      : "concise";
  }

  const BROWSER_AGENT_PROTOCOL =
    "Browser-agent protocol:\n" +
    "- Observe first: use page context, then get_dom_state for interactables, take_snapshot for role/accessibility structure, and deep_query/list_iframes/list_shadow_roots when a target is hidden.\n" +
    "- Identify targets by stable evidence (visible text, role/name, index, selector, frame/shadow context, state) before acting; avoid brittle selectors when an index or role-backed target is available.\n" +
    "- Act in short verified batches: click/type/navigate, wait for navigation or network idle, then verify with check_element_state, page text, URL/title, or a fresh snapshot.\n" +
    "- Handle real browser surfaces before giving up: dialogs, popups/windows, tabs, cross-origin iframes, shadow DOM, downloads, file inputs, and canvas each have dedicated tools.\n" +
    "- For destructive, payment, account, credential, or irreversible actions, ask for confirmation unless the user has already clearly authorized the exact action.\n";

  // Detect the host OS platform and return a short label.
  function _detectPlatform() {
    try {
      // navigator.userAgentData is available in Chrome/Edge MV3 workers.
      const uad = navigator.userAgentData;
      if (uad && uad.platform) {
        const p = uad.platform.toLowerCase();
        if (p.includes("mac")) return "macOS";
        if (p.includes("win")) return "Windows";
        if (p.includes("linux") || p.includes("chromeos")) return "Linux";
        return uad.platform;
      }
    } catch (_) {}
    try {
      const ua = (navigator.userAgent || "").toLowerCase();
      if (ua.includes("macintosh") || ua.includes("mac os x")) return "macOS";
      if (ua.includes("windows")) return "Windows";
      if (ua.includes("linux") || ua.includes("cros")) return "Linux";
    } catch (_) {}
    return "unknown";
  }

  function buildSystemPrompt(context, providerInfo, opts) {
    let p = "You are AutoDOM, an in-page browser assistant.\n";
    // Platform info — helps the model give OS-appropriate keyboard shortcuts
    // and paths (e.g. Cmd vs Ctrl, / vs \\ path separators).
    const platform = _detectPlatform();
    p += `Platform: ${platform}.\n`;
    if (providerInfo && (providerInfo.model || providerInfo.provider)) {
      const m = String(providerInfo.model || "unknown").trim();
      const prov = String(providerInfo.provider || "unknown").trim();
      // Identity disclosure — needed so 'what model are you?' doesn't
      // hallucinate. One-liner; verbose framing was wasted tokens.
      p += `Identity: provider=${prov}, model=${m}. When asked, answer truthfully with this exact pair; don't invent another model.\n`;
    }
    if (context) {
      p += "Page context report:\n";
      if (context.title) p += `- Title: ${scrubContextIdentifiers(context.title)}\n`;
      if (context.url) p += `- URL: ${scrubContextIdentifiers(context.url)}\n`;
      if (context.viewportWidth || context.viewportHeight) {
        p += `- Viewport: ${context.viewportWidth || 0}x${context.viewportHeight || 0}\n`;
      }
      if (context.scrollX != null || context.scrollY != null) {
        p += `- Scroll: x=${context.scrollX || 0}, y=${context.scrollY || 0}\n`;
      }
      // Outline is dense and cheap (~150 tokens). Send it on every turn,
      // including unchanged ones, so the model has structural anchors
      // even after we drop the visible-text body for dedup.
      if (context.outline) {
        p += `- Outline:\n${scrubContextIdentifiers(context.outline).substring(0, 800)}\n`;
      }
      if (context._pageUnchanged) {
        // Page-context dedup: SW detected this page is identical to the
        // previous turn's, so we skip re-pasting the visible-text block
        // (saves ~1k tokens/turn). The model already saw it earlier in
        // this same conversation and can call get_dom_state for fresh
        // detail if it needs more than headings.
        p += `- State: unchanged from previous turn; visible text omitted to save tokens. Call get_dom_state if you need fresh content.\n`;
        if (context.interactiveElements) {
          const ie = context.interactiveElements;
          p += `- Interactive: ${ie.links || 0}L ${ie.buttons || 0}B ${ie.inputs || 0}I ${ie.forms || 0}F\n`;
        }
      } else {
        // Page-context truncation — heaviest per-turn cost. With the
        // outline doing structural duty above, the visible-text block
        // can be tighter still: 600/800 chars. Model can call
        // get_dom_state for full content when it needs detail.
        if (context.visibleOverlayText) {
          p += `- Popup/dialog text:\n${scrubContextIdentifiers(context.visibleOverlayText).substring(0, 600)}\n`;
        }
        if (context.visibleTextPreview) {
          p += `- Page text:\n${scrubContextIdentifiers(context.visibleTextPreview).substring(0, 800)}\n`;
        }
        if (context.interactiveElements) {
          const ie = context.interactiveElements;
          p += `- Interactive: ${ie.links || 0}L ${ie.buttons || 0}B ${ie.inputs || 0}I ${ie.forms || 0}F\n`;
        }
      }
    }
    p +=
      BROWSER_AGENT_PROTOCOL +
      "Be concise. For browser actions, use slash commands (/dom /click /screenshot /nav) or call tools directly. Never show internal shorthand such as IC0 or CB0; describe the practical action in plain English.\n" +
      RESPONSE_STYLE_INSTRUCTIONS[_resolveResponseStyle(opts)];
    return p;
  }

  function buildMessages(text, context, conversationHistory, providerInfo, opts) {
    const msgs = [{ role: "system", content: buildSystemPrompt(context, providerInfo, opts) }];
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      conversationHistory.slice(-12).forEach((m) => {
        if (m && m.role && m.content) {
          msgs.push({
            role:
              m.role === "assistant" || m.role === "system" ? m.role : "user",
            content: String(m.content),
          });
        }
      });
    }
    msgs.push({ role: "user", content: text });
    return msgs;
  }

  // ─── Lightweight SSE / NDJSON streaming reader ──────────────
  // Reads a fetch Response body line/event by line. Yields each text
  // frame so callers can incrementally parse OpenAI/Anthropic SSE or
  // Ollama NDJSON without loading the whole thing into memory. Used by
  // the streaming branches of callOpenAI/callAnthropic/callOllama.
  async function _readSseFrames(response, onFrame) {
    if (!response.body || !response.body.getReader) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      // SSE event boundary is a blank line (\n\n). For NDJSON we use a
      // single newline. Both are handled by splitting on \n and treating
      // each non-empty line as a candidate frame; SSE callers strip the
      // "data: " prefix in their handler.
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        try { onFrame(line); } catch (_) {}
      }
      if (done) {
        if (buf.length > 0) {
          try { onFrame(buf); } catch (_) {}
        }
        return;
      }
    }
  }

  // Drain an SSE response that emits OpenAI-style chat.completions
  // chunks. Returns the accumulated final shape that matches the
  // non-streaming callOpenAI return shape (so the agent loop is
  // unchanged). Streams text deltas via onDelta.
  async function _drainOpenAiSse(response, onDelta) {
    let content = "";
    const toolCallsByIndex = new Map(); // index -> {id, name, argumentsStr}
    let finishReason = "stop";
    await _readSseFrames(response, (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { return; }
      const choice = evt?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        if (typeof onDelta === "function") {
          try { onDelta(delta.content); } catch (_) {}
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolCallsByIndex.get(idx);
          if (!acc) {
            acc = { id: tc.id || "", name: "", argumentsStr: "" };
            toolCallsByIndex.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            acc.argumentsStr += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });
    const tool_calls = Array.from(toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v], i) => ({
        id: v.id || `call_${Date.now()}_${i}`,
        type: "function",
        function: { name: v.name, arguments: v.argumentsStr || "{}" },
      }));
    return { content, tool_calls, finish_reason: finishReason };
  }

  // Drain an Anthropic SSE message stream. Yields incremental text
  // through onDelta (only from text blocks; tool_use input json deltas
  // are accumulated silently). Returns the same shape callAnthropic's
  // non-streaming branch returns: blocks[] with text + tool_use, and
  // a stop_reason.
  async function _drainAnthropicSse(response, onDelta) {
    const blocksByIndex = new Map(); // idx -> {type, text?, id?, name?, inputStr?}
    let stopReason = "end_turn";
    await _readSseFrames(response, (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { return; }
      const t = evt.type;
      if (t === "content_block_start" && evt.content_block) {
        const idx = evt.index;
        const cb = evt.content_block;
        if (cb.type === "text") {
          blocksByIndex.set(idx, { type: "text", text: "" });
        } else if (cb.type === "tool_use") {
          blocksByIndex.set(idx, {
            type: "tool_use",
            id: cb.id,
            name: cb.name,
            inputStr: "",
          });
        }
      } else if (t === "content_block_delta" && evt.delta) {
        const idx = evt.index;
        const acc = blocksByIndex.get(idx);
        if (!acc) return;
        if (evt.delta.type === "text_delta" && typeof evt.delta.text === "string") {
          acc.text = (acc.text || "") + evt.delta.text;
          if (typeof onDelta === "function") {
            try { onDelta(evt.delta.text); } catch (_) {}
          }
        } else if (evt.delta.type === "input_json_delta" && typeof evt.delta.partial_json === "string") {
          acc.inputStr = (acc.inputStr || "") + evt.delta.partial_json;
        }
      } else if (t === "message_delta" && evt.delta?.stop_reason) {
        stopReason = evt.delta.stop_reason;
      }
    });
    const blocks = Array.from(blocksByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => {
        if (v.type === "text") return { type: "text", text: v.text || "" };
        let input = {};
        if (v.inputStr) {
          try { input = JSON.parse(v.inputStr); } catch (_) { input = {}; }
        }
        return { type: "tool_use", id: v.id, name: v.name, input };
      });
    return { blocks, stop_reason: stopReason };
  }

  async function callOpenAI({
    apiKey,
    baseUrl,
    model,
    text,
    context,
    conversationHistory,
    debug,
    // Agent-loop additions:
    tools, // OpenAI tool schema array (optional)
    messagesOverride, // when provided, used verbatim (for multi-turn agent loops)
    signal, // optional AbortSignal so the caller can cancel an in-flight run
    providerInfo, // { model, provider } — used by buildSystemPrompt for identity
    responseStyle, // "concise" | "jetbrains" | "chatbar" — drives reply formatting
    onDelta, // (chunk) => void — when present, request streams and emits text deltas
  }) {
    if (!apiKey) throw new Error("No OpenAI API key configured");
    const cleanBase = (baseUrl || "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    const m = model || "gpt-4.1-mini";
    const messages =
      messagesOverride ||
      buildMessages(text, context, conversationHistory, providerInfo || { model: m, provider: "openai" }, { responseStyle });
    const wantStream = typeof onDelta === "function";
    debug && debug("[AutoDOM SW] Calling OpenAI:", cleanBase + "/chat/completions", "model:", m, "tools:", tools ? tools.length : 0, "stream:", wantStream);
    const body = { model: m, messages, max_tokens: 10000 };
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = false;
    }
    if (wantStream) body.stream = true;
    const resp = await fetch(`${cleanBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenAI ${resp.status}: ${errText.substring(0, 300)}`);
    }
    if (wantStream) {
      const drained = await _drainOpenAiSse(resp, onDelta);
      const assistantMsg = {
        role: "assistant",
        content: drained.content || "",
        ...(drained.tool_calls.length > 0 ? { tool_calls: drained.tool_calls } : {}),
      };
      return {
        response: drained.content || "",
        assistantMessage: assistantMsg,
        toolCalls: drained.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        })),
        stopReason: drained.finish_reason || "stop",
        providerMeta: { tool: "_direct_provider", via: "openai", model: m, streamed: true },
      };
    }
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const content = msg.content || "";
    const finishReason = choice?.finish_reason || "stop";
    return {
      response: content,
      assistantMessage: msg, // pass back so caller can append to transcript
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      })),
      stopReason: finishReason,
      providerMeta: { tool: "_direct_provider", via: "openai", model: m },
    };
  }

  async function callAnthropic({
    apiKey,
    baseUrl,
    model,
    text,
    context,
    conversationHistory,
    debug,
    tools, // Anthropic tool schema array (optional)
    messagesOverride, // pre-built `messages` array (for multi-turn loops)
    signal,
    providerInfo, // { model, provider } — used by buildSystemPrompt for identity
    systemPromptOverride, // when provided, used verbatim instead of buildSystemPrompt
    responseStyle, // "concise" | "jetbrains" | "chatbar"
    onDelta, // (chunk) => void — when present, request streams via SSE
  }) {
    if (!apiKey) throw new Error("No Anthropic API key configured");
    const m = model || "claude-3-5-sonnet-latest";
    const cleanBase = (baseUrl || "https://api.anthropic.com").replace(
      /\/+$/,
      "",
    );
    const systemPrompt =
      systemPromptOverride ||
      buildSystemPrompt(context, providerInfo || { model: m, provider: "anthropic" }, { responseStyle });
    let msgs;
    if (messagesOverride) {
      msgs = messagesOverride;
    } else {
      msgs = [];
      if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
        conversationHistory.slice(-12).forEach((mm) => {
          if (mm && mm.role && mm.content) {
            msgs.push({
              role: mm.role === "assistant" ? "assistant" : "user",
              content: String(mm.content),
            });
          }
        });
      }
      msgs.push({ role: "user", content: text });
    }
    const wantStream = typeof onDelta === "function";
    debug && debug("[AutoDOM SW] Calling Anthropic, model:", m, "tools:", tools ? tools.length : 0, "stream:", wantStream);
    const body = {
      model: m,
      max_tokens: 10000,
      system: systemPrompt,
      messages: msgs,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
    }
    if (wantStream) body.stream = true;
    const resp = await fetch(`${cleanBase}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Anthropic ${resp.status}: ${errText.substring(0, 300)}`);
    }
    if (wantStream) {
      const drained = await _drainAnthropicSse(resp, onDelta);
      const blocks = drained.blocks;
      const textBlocks = blocks
        .filter((p) => p?.type === "text" && p?.text)
        .map((p) => p.text)
        .join("\n")
        .trim();
      const toolUseBlocks = blocks.filter((p) => p?.type === "tool_use");
      return {
        response: textBlocks,
        assistantContent: blocks,
        toolCalls: toolUseBlocks.map((tu) => ({
          id: tu.id,
          name: tu.name,
          arguments:
            typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input || {}),
        })),
        stopReason: drained.stop_reason || "end_turn",
        providerMeta: { tool: "_direct_provider", via: "anthropic", model: m, streamed: true },
      };
    }
    const data = await resp.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const textBlocks = blocks
      .filter((p) => p?.type === "text" && p?.text)
      .map((p) => p.text)
      .join("\n")
      .trim();
    const toolUseBlocks = blocks.filter((p) => p?.type === "tool_use");
    return {
      response: textBlocks,
      assistantContent: blocks, // raw blocks for tool_result threading
      toolCalls: toolUseBlocks.map((tu) => ({
        id: tu.id,
        name: tu.name,
        arguments:
          typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input || {}),
      })),
      stopReason: data?.stop_reason || "end_turn",
      providerMeta: { tool: "_direct_provider", via: "anthropic", model: m },
    };
  }

  async function callOllama({
    baseUrl,
    model,
    text,
    context,
    conversationHistory,
    debug,
    tools,
    messagesOverride,
    requireTools, // when true, throw if model didn't return tool_calls
    signal,
    providerInfo, // { model, provider } — used by buildSystemPrompt for identity
    responseStyle, // "concise" | "jetbrains" | "chatbar"
    onDelta, // (chunk) => void — when present, request streams via NDJSON
  }) {
    const cleanBase = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    const m = model || "llama3.2";
    const messages =
      messagesOverride ||
      buildMessages(text, context, conversationHistory, providerInfo || { model: m, provider: "ollama" }, { responseStyle });
    const wantStream = typeof onDelta === "function";
    debug && debug("[AutoDOM SW] Calling Ollama:", cleanBase + "/api/chat", "model:", m, "tools:", tools ? tools.length : 0, "stream:", wantStream);
    const body = { model: m, messages, stream: !!wantStream };
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
    }
    const resp = await fetch(`${cleanBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Ollama ${resp.status}: ${errText.substring(0, 300)}`);
    }
    let msg;
    if (wantStream) {
      // Ollama /api/chat streaming = one JSON object per line, with a
      // `done: true` terminator. Each frame's `message.content` is a
      // delta. tool_calls only appear in the terminal frame typically.
      let acc = { role: "assistant", content: "" };
      let toolCalls = [];
      await _readSseFrames(resp, (line) => {
        let evt;
        try { evt = JSON.parse(line); } catch (_) { return; }
        const piece = evt?.message?.content;
        if (typeof piece === "string" && piece.length > 0) {
          acc.content += piece;
          try { onDelta(piece); } catch (_) {}
        }
        if (Array.isArray(evt?.message?.tool_calls) && evt.message.tool_calls.length > 0) {
          toolCalls = evt.message.tool_calls;
        }
      });
      msg = { ...acc, tool_calls: toolCalls };
    } else {
      const data = await resp.json();
      msg = data?.message || {};
    }
    const content = msg?.content || "";
    const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (requireTools && rawToolCalls.length === 0 && Array.isArray(tools)) {
      throw new Error(
        `Ollama model "${m}" did not return any tool_calls. Use a model with native tool support (e.g. llama3.1, qwen2.5, mistral-nemo) or switch to OpenAI / Anthropic.`,
      );
    }
    return {
      response: content,
      assistantMessage: msg,
      toolCalls: rawToolCalls.map((tc, i) => ({
        id: tc.id || `ollama_${Date.now()}_${i}`,
        name: tc.function?.name,
        arguments:
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {}),
      })),
      stopReason: rawToolCalls.length > 0 ? "tool_calls" : "stop",
      providerMeta: { tool: "_direct_provider", via: "ollama", model: m, streamed: wantStream },
    };
  }

  async function callDirectProvider(providerType, opts) {
    const normalized =
      providerType === "gpt" || providerType === "chatgpt"
        ? "openai"
        : providerType === "claude"
          ? "anthropic"
          : providerType;
    if (normalized === "openai") return callOpenAI(opts);
    if (normalized === "anthropic") return callAnthropic(opts);
    if (normalized === "ollama") return callOllama(opts);
    throw new Error(`Unknown direct provider: ${providerType}`);
  }

  globalThis.AutoDOMProviders = {
    callDirectProvider,
    callOpenAI,
    callAnthropic,
    callOllama,
    buildSystemPrompt,
    buildMessages,
  };
})();
