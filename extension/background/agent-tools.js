/**
 * AutoDOM — Agent tool catalog
 *
 * A curated subset of TOOL_HANDLERS exposed to the AI as a function-calling
 * toolset, with JSON-Schema definitions and per-provider formatters.
 *
 * Loaded via importScripts() from service-worker.js. Exposes
 * `globalThis.AutoDOMAgent` with:
 *   - TOOL_CATALOG: array of { name, description, parameters, danger }
 *   - formatToolsForOpenAI(catalog)
 *   - formatToolsForAnthropic(catalog)
 *   - formatToolsForOllama(catalog)
 *   - truncateToolResult(toolName, result) — caps oversized tool output
 *
 * NOTE: tool execution happens through the SW's `executeAgentTool()` which
 * keeps rate limiting + per-tab pinning but bypasses the
 * sensitive-action confirmation gate (per user request: "auto-run all").
 */
(function () {
  // ─── Catalog ─────────────────────────────────────────────
  // Only tools that make sense for an autonomous browser agent.
  // Big/dangerous/admin tools (eval, set_cookie, recording, perf, etc.)
  // are deliberately excluded for safety + token efficiency.
  const TOOL_CATALOG = [
    // ── Reads ──
    {
      name: "get_page_info",
      description:
        "Return URL, title, and basic info about the currently focused page.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "get_dom_state",
      description:
        "Snapshot interactive elements on the current page with stable indexes. " +
        "Use the returned indexes with click_by_index / type_by_index. Fast and token-efficient. " +
        "Call this before any click/type if you don't already have a fresh snapshot.",
      parameters: {
        type: "object",
        properties: {
          maxElements: { type: "integer", description: "Cap (default 60)" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "query_elements",
      description:
        "Find elements by CSS selector and return their text/attributes (no indexes).",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          limit: { type: "integer" },
        },
        required: ["selector"],
      },
    },
    {
      name: "extract_text",
      description:
        "Extract visible text content from the page or a region. Truncated to ~6KB.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "Optional CSS selector (defaults to body)",
          },
        },
      },
    },
    {
      name: "extract_data",
      description:
        "Extract structured data from a list/table by selector. Returns an array of rows.",
      parameters: {
        type: "object",
        properties: {
          containerSelector: { type: "string" },
          fields: {
            type: "object",
            description:
              "Map of fieldName → CSS selector relative to each container element",
          },
        },
        required: ["containerSelector", "fields"],
      },
    },
    {
      name: "get_html",
      description:
        "Get outerHTML of an element (or whole body if no selector). Truncated to ~8KB.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
      },
    },
    {
      name: "take_screenshot",
      description:
        "Capture a PNG screenshot of the current viewport. Returns a small reference id; the bytes are not fed back to you.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "take_snapshot",
      description:
        "Capture a structured DOM/accessibility snapshot of the page (tag, role, aria-label, key attributes, text). " +
        "More structural than get_dom_state; better for navigation/aria-driven layouts (Playwright-style snapshot).",
      parameters: {
        type: "object",
        properties: {
          maxDepth: { type: "integer", description: "Max recursion depth (default 10)" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "check_element_state",
      description:
        "Report exists/visible/inViewport/disabled/checked/value for a single element. Use to verify state before/after an action.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    },

    // ── Actions ──
    {
      name: "click",
      description: "Click an element by CSS selector.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      danger: "write",
    },
    {
      name: "click_by_index",
      description:
        "Click element by its index from the most recent get_dom_state snapshot. Faster + more reliable than CSS for messy pages.",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" } },
        required: ["index"],
      },
      danger: "write",
    },
    {
      name: "type_text",
      description: "Type text into an input/textarea by CSS selector.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
          clear: {
            type: "boolean",
            description: "Clear field first (default true)",
          },
        },
        required: ["selector", "text"],
      },
      danger: "write",
    },
    {
      name: "type_by_index",
      description:
        "Type into element by index from most recent get_dom_state snapshot.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer" },
          text: { type: "string" },
          clear: { type: "boolean" },
        },
        required: ["index", "text"],
      },
      danger: "write",
    },
    {
      name: "fill_form",
      description:
        "Fill multiple form fields in one call. fields = map of selector → value.",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "object",
            description: "Map of CSS selector → value",
          },
        },
        required: ["fields"],
      },
      danger: "write",
    },
    {
      name: "batch_actions",
      description:
        "Execute up to 8 known browser steps sequentially in one tool call. Use this after get_dom_state when you can chain click/type/wait/scroll actions to avoid slow model round-trips.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                tool: {
                  type: "string",
                  enum: [
                    "get_dom_state",
                    "click_by_index",
                    "type_by_index",
                    "click",
                    "type_text",
                    "fill_form",
                    "select_option",
                    "press_key",
                    "scroll",
                    "navigate",
                    "wait_for_element",
                    "wait_for_text",
                    "wait_for_navigation",
                    "wait_for_network_idle",
                    "check_element_state",
                    "handle_dialog",
                    "wait_for_new_tab",
                    "list_popups",
                    "switch_to_popup",
                    "wait_for_popup",
                    "list_tabs",
                    "switch_tab",
                    "open_new_tab",
                    "close_tab",
                    "canvas_interact",
                    "iframe_interact",
                    "shadow_interact",
                  ],
                },
                args: { type: "object", additionalProperties: true },
                params: { type: "object", additionalProperties: true },
              },
              required: ["tool"],
              additionalProperties: false,
            },
          },
          stopOnError: { type: "boolean", description: "Default true" },
        },
        required: ["actions"],
        additionalProperties: false,
      },
      danger: "write",
    },
    {
      name: "select_option",
      description: "Choose an option in a <select> by value or visible text.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          value: { type: "string" },
        },
        required: ["selector", "value"],
      },
      danger: "write",
    },
    {
      name: "press_key",
      description:
        "Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape') optionally on a focused selector.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          selector: { type: "string" },
        },
        required: ["key"],
      },
      danger: "write",
    },
    {
      name: "scroll",
      description:
        "Scroll the page or an element. direction = up/down/top/bottom or pixels.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string" },
          selector: { type: "string" },
          pixels: { type: "integer" },
        },
      },
    },
    {
      name: "hover",
      description: "Hover over an element by selector (triggers mouseenter).",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    },
    {
      name: "right_click",
      description: "Right-click an element by selector (dispatches a contextmenu event).",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      danger: "write",
    },
    {
      name: "drag_and_drop",
      description:
        "Drag a source element onto a target element using HTML5 drag events plus pointer events. " +
        "Works for kanban boards, sliders, file reorder, etc.",
      parameters: {
        type: "object",
        properties: {
          sourceSelector: { type: "string" },
          targetSelector: { type: "string" },
        },
        required: ["sourceSelector", "targetSelector"],
      },
      danger: "write",
    },
    {
      name: "set_attribute",
      description:
        "Set or remove an attribute on the first element matching selector. Pass value=null to remove. " +
        "Use to toggle aria-expanded, hidden, disabled, data-*, etc.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          attribute: { type: "string" },
          value: { type: ["string", "null"], description: "null removes the attribute" },
        },
        required: ["selector", "attribute"],
      },
      danger: "write",
    },
    {
      name: "upload_file",
      description:
        "Attach a local file to an <input type=\"file\">. uid is a CSS selector for the input. " +
        "filePath must be an absolute path on the user's machine (ask the user if you don't have it). " +
        "Uses CDP DOM.setFileInputFiles — the only reliable way to drive file inputs.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string", description: "CSS selector for the file input" },
          filePath: { type: "string", description: "Absolute local file path" },
        },
        required: ["uid", "filePath"],
      },
      danger: "write",
    },
    {
      name: "handle_dialog",
      description:
        "Accept or dismiss a JS dialog (alert/confirm/prompt/beforeunload). Call this proactively when " +
        "an action might trigger a confirm/alert — otherwise the page hangs.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["accept", "dismiss"] },
          promptText: { type: "string", description: "For prompt() — text to type before accept" },
        },
        required: ["action"],
      },
      danger: "write",
    },

    // ── Nav / waits ──
    {
      name: "navigate",
      description:
        "Navigate the current tab. Provide either url (absolute) OR action (back/forward/reload).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL to load" },
          action: {
            type: "string",
            enum: ["back", "forward", "reload"],
            description: "History navigation instead of url",
          },
        },
      },
      danger: "write",
    },
    {
      name: "wait_for_network_idle",
      description:
        "Wait until no new XHR/fetch resources have started for `idleTime` ms (default 500ms, max wait `timeout` default 10s). " +
        "Use this for SPA readiness instead of fixed sleeps.",
      parameters: {
        type: "object",
        properties: {
          timeout: { type: "integer", description: "Max wait in ms (default 10000)" },
          idleTime: { type: "integer", description: "Quiescence window in ms (default 500)" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "wait_for_element",
      description: "Wait until a CSS selector exists in the DOM (max 10s).",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          timeout: { type: "integer" },
        },
        required: ["selector"],
      },
    },
    {
      name: "wait_for_text",
      description: "Wait until specified text appears anywhere on the page.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          timeout: { type: "integer" },
        },
        required: ["text"],
      },
    },
    {
      name: "wait_for_navigation",
      description:
        "Wait until the current tab finishes navigating (after a click/submit).",
      parameters: {
        type: "object",
        properties: { timeout: { type: "integer" } },
      },
    },
    {
      name: "wait_for_new_tab",
      description:
        "Wait for a new tab to open (e.g. after clicking a target=_blank link). Returns the new tab id.",
      parameters: {
        type: "object",
        properties: { timeout: { type: "integer" } },
      },
    },
    {
      name: "list_popups",
      description:
        "List browser windows, including popup windows opened with window.open. Use when page content appears in a separate popup/window.",
      parameters: {
        type: "object",
        properties: {
          popupsOnly: { type: "boolean", description: "Return only popup windows" },
        },
      },
    },
    {
      name: "switch_to_popup",
      description:
        "Focus a popup/window and pin subsequent tool calls to its active tab.",
      parameters: {
        type: "object",
        properties: {
          windowId: { type: "integer" },
          tabId: { type: "integer" },
        },
        required: ["windowId"],
      },
    },
    {
      name: "wait_for_popup",
      description:
        "Wait for a new popup/window to appear after an action, then optionally switch to it.",
      parameters: {
        type: "object",
        properties: {
          timeout: { type: "integer" },
          switchTo: { type: "boolean" },
        },
      },
    },
    {
      name: "close_popup",
      description: "Close a popup/window by windowId.",
      parameters: {
        type: "object",
        properties: { windowId: { type: "integer" } },
        required: ["windowId"],
      },
      danger: "write",
    },

    // ── Tabs ──
    {
      name: "list_tabs",
      description: "List all open tabs in the current window.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "switch_tab",
      description: "Activate a tab and pin subsequent tool calls to it.",
      parameters: {
        type: "object",
        properties: { tabId: { type: "integer" } },
        required: ["tabId"],
      },
    },
    {
      name: "open_new_tab",
      description:
        "Open a new tab with the given URL and pin subsequent tool calls to it.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          active: { type: "boolean" },
        },
        required: ["url"],
      },
      danger: "write",
    },
    {
      name: "close_tab",
      description: "Close a tab by id.",
      parameters: {
        type: "object",
        properties: { tabId: { type: "integer" } },
        required: ["tabId"],
      },
      danger: "write",
    },

    // ── iframes ──
    // Cross-origin iframes (e.g. mail.zoho.in inside workplace.zoho.in) are
    // unreachable from page-world JS, but the extension can pierce them via
    // chrome.scripting.executeScript with a frameId thanks to <all_urls>
    // host permission. Expose these to the chat agent so it stops claiming
    // "I can't read cross-origin iframes" — it can.
    {
      name: "list_iframes",
      description:
        "List every iframe on the active tab (including cross-origin) with its frameId, src, size, and visibility. " +
        "Use this BEFORE saying an iframe is unreachable — the extension can pierce cross-origin iframes via frameId.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "iframe_interact",
      description:
        "Execute an action inside a specific iframe (works across origins). " +
        "Actions: 'extract_text', 'query', 'click', 'type', 'fill_form', 'get_dom_state', " +
        "'select_option', 'scroll', 'hover', 'check_element_state'. " +
        "Resolve the target with frameId from list_iframes (preferred) or iframeSelector. " +
        "list_iframes shows nesting depth — nested iframes (iframe inside iframe) each have their own frameId.",
      parameters: {
        type: "object",
        properties: {
          frameId: { type: "integer", description: "frameId from list_iframes (preferred)" },
          iframeSelector: { type: "string", description: "CSS selector for the <iframe> element on the parent page (fallback)" },
          action: {
            type: "string",
            enum: ["extract_text", "query", "click", "type", "fill_form", "get_dom_state", "select_option", "scroll", "hover", "check_element_state"],
          },
          selector: { type: "string", description: "CSS selector inside the iframe" },
          text: { type: "string", description: "Text to match (for click)" },
          value: { type: "string", description: "Value to type or option value for select_option" },
          fields: {
            type: "array",
            description: "For fill_form: array of { selector, value }",
            items: { type: "object" },
          },
          clearFirst: { type: "boolean" },
          direction: { type: "string", description: "For scroll: up/down/top/bottom" },
          pixels: { type: "integer", description: "For scroll: pixel amount" },
        },
        required: ["action"],
      },
      danger: "write",
    },

    // ── Shadow DOM ──
    {
      name: "list_shadow_roots",
      description:
        "Enumerate open shadow roots on the page (host tag, id, child counts, suggested piercing path). " +
        "Use before shadow_interact to discover hosts inside web components.",
      parameters: {
        type: "object",
        properties: {
          maxDepth: { type: "integer", description: "How deep to recurse (default 5)" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "shadow_interact",
      description:
        "Interact with elements inside open shadow DOMs using a piercing selector " +
        "('host >>> inner' or nested 'host1 >>> host2 >>> target'). " +
        "Actions: 'query' (default), 'click', 'type', 'extract_text', 'query_all', 'fill_form', 'get_dom_state', " +
        "'select_option', 'scroll', 'hover'. " +
        "Closed shadow roots are not accessible — fall back to deep_query if this fails.",
      parameters: {
        type: "object",
        properties: {
          piercingSelector: {
            type: "string",
            description: "e.g. 'my-component >>> .inner-button'",
          },
          action: {
            type: "string",
            enum: ["query", "click", "type", "extract_text", "query_all", "fill_form", "get_dom_state", "select_option", "scroll", "hover"],
          },
          value: { type: "string" },
          clearFirst: { type: "boolean" },
          fields: {
            type: "array",
            description: "For fill_form: array of { selector, value } resolved inside the deepest shadow root",
            items: { type: "object" },
          },
          direction: { type: "string", description: "For scroll: up/down/top/bottom" },
          pixels: { type: "integer", description: "For scroll: pixel amount" },
        },
        required: ["piercingSelector"],
      },
      danger: "write",
    },
    {
      name: "deep_query",
      description:
        "One-shot search across the main document, every iframe (including cross-origin), shadow roots, " +
        "and shadow roots nested inside iframes. " +
        "Use when you don't know whether the target lives in the main DOM, an iframe, or a shadow root. " +
        "Provide either a CSS selector or text to match.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to match" },
          text: { type: "string", description: "Text substring to match" },
          limit: { type: "integer", description: "Max results (default 30)" },
        },
      },
    },

    // ── Canvas ──
    {
      name: "canvas_interact",
      description:
        "Interact with an HTML5 <canvas> element. " +
        "Actions: 'get_size' (width/height), 'get_image_data' (returns small PNG data-URL, downscaled if large), " +
        "'read_pixel' (RGBA at x,y), 'click' (dispatch MouseEvent at canvas x,y coordinates), " +
        "'draw_path' (draw lines/shapes via 2D context — provide pathCommands array). " +
        "Use selector to target a specific canvas (default: first canvas on page).",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the canvas element (default: 'canvas')" },
          action: {
            type: "string",
            enum: ["get_size", "get_image_data", "read_pixel", "click", "draw_path"],
          },
          x: { type: "number", description: "X coordinate (for click/read_pixel)" },
          y: { type: "number", description: "Y coordinate (for click/read_pixel)" },
          maxSize: { type: "integer", description: "For get_image_data: max dimension for downscaling (default 256)" },
          pathCommands: {
            type: "array",
            description: "For draw_path: array of { cmd, args } e.g. [{ cmd: 'moveTo', args: [10,10] }, { cmd: 'lineTo', args: [100,100] }, { cmd: 'stroke' }]",
            items: { type: "object" },
          },
          strokeStyle: { type: "string", description: "For draw_path: stroke color (default '#000')" },
          fillStyle: { type: "string", description: "For draw_path: fill color" },
          lineWidth: { type: "number", description: "For draw_path: line width (default 2)" },
        },
        required: ["action"],
      },
      danger: "write",
    },

    // ── Downloads ──
    {
      name: "list_downloads",
      description:
        "List recent browser downloads (filename, URL, state, bytesReceived, totalBytes). " +
        "Use to check what was downloaded after triggering a download action.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Max results (default 10)" },
          state: {
            type: "string",
            enum: ["in_progress", "interrupted", "complete"],
            description: "Filter by download state",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "wait_for_download",
      description:
        "Wait for a new download to start and optionally complete. Returns filename, URL, and final state. " +
        "Call this BEFORE triggering the download action when you know a file download is coming.",
      parameters: {
        type: "object",
        properties: {
          timeout: { type: "integer", description: "Max wait in ms (default 15000)" },
          waitForComplete: { type: "boolean", description: "Also wait until download finishes (default false)" },
          filenameFilter: { type: "string", description: "Substring the filename must contain" },
        },
        additionalProperties: false,
      },
    },

    // ── Final answer ──
    {
      name: "respond_to_user",
      description:
        "Send your final, user-facing markdown reply. Call this when you have finished the user's task or have a complete answer. " +
        "After calling this, do not invoke any more tools.",
      parameters: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description: "Markdown text shown to the user.",
          },
        },
        required: ["markdown"],
      },
    },
  ];

  // ─── Per-provider formatters ────────────────────────────

  function formatToolsForOpenAI(catalog) {
    return catalog.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    }));
  }

  function formatToolsForAnthropic(catalog) {
    return catalog.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }));
  }

  function formatToolsForOllama(catalog) {
    // Ollama uses an OpenAI-compatible tool schema
    return formatToolsForOpenAI(catalog);
  }

  // ─── Result truncation ──────────────────────────────────
  // Keep what's fed back to the model under control.
  const MAX_TEXT_RESULT = 6000;
  const MAX_HTML_RESULT = 8000;
  const MAX_LIST_ITEMS = 60;

  function truncateString(str, max, label) {
    if (typeof str !== "string") return str;
    if (str.length <= max) return str;
    return (
      str.substring(0, max) +
      `\n…[truncated ${str.length - max} chars of ${label || "output"}]`
    );
  }

  function truncateToolResult(toolName, result) {
    if (result == null) return result;
    // Wholesale strip screenshot bytes — never feed base64 images back to text models.
    if (toolName === "take_screenshot") {
      return {
        ok: true,
        message:
          "Screenshot captured. (Image data not included in tool output to save tokens.)",
        ref: result?.ref || result?.id || null,
      };
    }
    // Clone shallowly and truncate known oversized fields
    const out = typeof result === "object" ? { ...result } : { value: result };
    if (typeof out.html === "string")
      out.html = truncateString(out.html, MAX_HTML_RESULT, "html");
    if (typeof out.text === "string")
      out.text = truncateString(out.text, MAX_TEXT_RESULT, "text");
    if (typeof out.content === "string")
      out.content = truncateString(out.content, MAX_TEXT_RESULT, "content");
    if (Array.isArray(out.elements) && out.elements.length > MAX_LIST_ITEMS) {
      out.elements = out.elements.slice(0, MAX_LIST_ITEMS);
      out.truncated = `Showing first ${MAX_LIST_ITEMS} elements`;
    }
    if (Array.isArray(out.results) && out.results.length > MAX_LIST_ITEMS) {
      out.results = out.results.slice(0, MAX_LIST_ITEMS);
      out.truncated = `Showing first ${MAX_LIST_ITEMS} results`;
    }
    if (Array.isArray(out.rows) && out.rows.length > MAX_LIST_ITEMS) {
      out.rows = out.rows.slice(0, MAX_LIST_ITEMS);
      out.truncated = `Showing first ${MAX_LIST_ITEMS} rows`;
    }
    // Final stringified safety cap
    try {
      const json = JSON.stringify(out);
      if (json.length > 12000) {
        return {
          ok: true,
          truncated: true,
          summary: truncateString(json, 12000, "result"),
        };
      }
    } catch (_) {
      // Non-serializable result — coerce to string
      return { ok: true, summary: String(out).substring(0, 4000) };
    }
    return out;
  }

  globalThis.AutoDOMAgent = {
    TOOL_CATALOG,
    formatToolsForOpenAI,
    formatToolsForAnthropic,
    formatToolsForOllama,
    truncateToolResult,
  };
})();
