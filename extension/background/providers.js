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
  function buildSystemPrompt(context) {
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

  function buildMessages(text, context, conversationHistory) {
    const msgs = [{ role: "system", content: buildSystemPrompt(context) }];
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
  }) {
    if (!apiKey) throw new Error("No OpenAI API key configured");
    const cleanBase = (baseUrl || "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    const m = model || "gpt-4.1-mini";
    const messages = buildMessages(text, context, conversationHistory);
    debug && debug("[AutoDOM SW] Calling OpenAI:", cleanBase + "/chat/completions", "model:", m);
    const resp = await fetch(`${cleanBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: m, messages, max_tokens: 4096 }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`OpenAI ${resp.status}: ${errText.substring(0, 300)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return {
      response: content || "OpenAI returned an empty response.",
      toolCalls: [{ tool: "_direct_provider", via: "openai", model: m }],
    };
  }

  async function callAnthropic({
    apiKey,
    model,
    text,
    context,
    conversationHistory,
    debug,
  }) {
    if (!apiKey) throw new Error("No Anthropic API key configured");
    const m = model || "claude-3-5-sonnet-latest";
    const systemPrompt = buildSystemPrompt(context);
    const msgs = [];
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
    debug && debug("[AutoDOM SW] Calling Anthropic, model:", m);
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: m,
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
      toolCalls: [{ tool: "_direct_provider", via: "anthropic", model: m }],
    };
  }

  async function callOllama({
    baseUrl,
    model,
    text,
    context,
    conversationHistory,
    debug,
  }) {
    const cleanBase = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    const m = model || "llama3.2";
    const messages = buildMessages(text, context, conversationHistory);
    debug && debug("[AutoDOM SW] Calling Ollama:", cleanBase + "/api/chat", "model:", m);
    const resp = await fetch(`${cleanBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, messages, stream: false }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Ollama ${resp.status}: ${errText.substring(0, 300)}`);
    }
    const data = await resp.json();
    const content = data?.message?.content || "";
    return {
      response: content || "Ollama returned an empty response.",
      toolCalls: [{ tool: "_direct_provider", via: "ollama", model: m }],
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
