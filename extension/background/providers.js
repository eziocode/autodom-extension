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
  function buildSystemPrompt(context, providerInfo) {
    let p = "You are AutoDOM, an in-page browser assistant.\n";
    if (providerInfo && (providerInfo.model || providerInfo.provider)) {
      const m = String(providerInfo.model || "unknown").trim();
      const prov = String(providerInfo.provider || "unknown").trim();
      // Identity disclosure — needed so 'what model are you?' doesn't
      // hallucinate. One-liner; verbose framing was wasted tokens.
      p += `Identity: provider=${prov}, model=${m}. When asked, answer truthfully with this exact pair; don't invent another model.\n`;
    }
    if (context) {
      if (context.title) p += `Page: ${context.title}\n`;
      if (context.url) p += `URL: ${context.url}\n`;
      // Outline is dense and cheap (~150 tokens). Send it on every turn,
      // including unchanged ones, so the model has structural anchors
      // even after we drop the visible-text body for dedup.
      if (context.outline) {
        p += `Outline:\n${String(context.outline).substring(0, 800)}\n`;
      }
      if (context._pageUnchanged) {
        // Page-context dedup: SW detected this page is identical to the
        // previous turn's, so we skip re-pasting the visible-text block
        // (saves ~1k tokens/turn). The model already saw it earlier in
        // this same conversation and can call get_dom_state for fresh
        // detail if it needs more than headings.
        p += `[Page state unchanged from previous turn — visible text omitted to save tokens. Call get_dom_state if you need fresh content.]\n`;
        if (context.interactiveElements) {
          const ie = context.interactiveElements;
          p += `Interactive: ${ie.links || 0}L ${ie.buttons || 0}B ${ie.inputs || 0}I ${ie.forms || 0}F\n`;
        }
      } else {
        // Page-context truncation — heaviest per-turn cost. With the
        // outline doing structural duty above, the visible-text block
        // can be tighter still: 600/800 chars. Model can call
        // get_dom_state for full content when it needs detail.
        if (context.visibleOverlayText) {
          p += `Popup text:\n${String(context.visibleOverlayText).substring(0, 600)}\n`;
        }
        if (context.visibleTextPreview) {
          p += `Page text:\n${String(context.visibleTextPreview).substring(0, 800)}\n`;
        }
        if (context.interactiveElements) {
          const ie = context.interactiveElements;
          p += `Interactive: ${ie.links || 0}L ${ie.buttons || 0}B ${ie.inputs || 0}I ${ie.forms || 0}F\n`;
        }
      }
    }
    p +=
      "Be concise. For browser actions, use slash commands (/dom /click /screenshot /nav) or call tools directly.";
    return p;
  }

  function buildMessages(text, context, conversationHistory, providerInfo) {
    const msgs = [{ role: "system", content: buildSystemPrompt(context, providerInfo) }];
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
  }) {
    if (!apiKey) throw new Error("No OpenAI API key configured");
    const cleanBase = (baseUrl || "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    const m = model || "gpt-4.1-mini";
    const messages =
      messagesOverride ||
      buildMessages(text, context, conversationHistory, providerInfo || { model: m, provider: "openai" });
    debug && debug("[AutoDOM SW] Calling OpenAI:", cleanBase + "/chat/completions", "model:", m, "tools:", tools ? tools.length : 0);
    const body = { model: m, messages, max_tokens: 4096 };
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = false;
    }
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
  }) {
    if (!apiKey) throw new Error("No Anthropic API key configured");
    const m = model || "claude-3-5-sonnet-latest";
    const cleanBase = (baseUrl || "https://api.anthropic.com").replace(
      /\/+$/,
      "",
    );
    const systemPrompt =
      systemPromptOverride ||
      buildSystemPrompt(context, providerInfo || { model: m, provider: "anthropic" });
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
    debug && debug("[AutoDOM SW] Calling Anthropic, model:", m, "tools:", tools ? tools.length : 0);
    const body = {
      model: m,
      max_tokens: 4096,
      system: systemPrompt,
      messages: msgs,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
    }
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
  }) {
    const cleanBase = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    const m = model || "llama3.2";
    const messages =
      messagesOverride ||
      buildMessages(text, context, conversationHistory, providerInfo || { model: m, provider: "ollama" });
    debug && debug("[AutoDOM SW] Calling Ollama:", cleanBase + "/api/chat", "model:", m, "tools:", tools ? tools.length : 0);
    const body = { model: m, messages, stream: false };
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
    const data = await resp.json();
    const msg = data?.message || {};
    const content = msg?.content || "";
    const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (requireTools && rawToolCalls.length === 0 && Array.isArray(tools)) {
      // Explicit failure rather than silent degrade — agent loop relies on
      // structured tool calls to act on the page.
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
      providerMeta: { tool: "_direct_provider", via: "ollama", model: m },
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
