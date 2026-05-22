# AutoDOM — Security Model

This document describes how AutoDOM protects the local WebSocket bridge,
where API keys live, and which extension permissions are granted and why.

## WebSocket bridge authentication

The bridge process (`server/index.js`) listens on `ws://127.0.0.1:<port>`
(default `9876`). Two layers of authentication are enforced for every
incoming connection:

1. **Origin allowlist.** Browser-attached clients always include an
   `Origin` header. The packaged AutoDOM extension sends the canonical
   origin `chrome-extension://kpjdffgogiajnkajnjneiboaincnaokf` and is
   accepted. Other `chrome-extension://` or `moz-extension://` origins are
   rejected unless explicitly configured, so another installed extension
   cannot borrow AutoDOM's browser permissions through the local bridge.

2. **Bearer token.** Non-browser local clients (the proxy-client mode,
   server regression tests, and any future CLI) must
   present a token. The token is generated at server startup with
   `crypto.randomBytes(32)` (256 bits) and written to a lockfile in the
   OS temp directory with mode `0600` (owner read/write only). Clients
   pass the token via either `?token=<hex>` query string or
   `Authorization: Bearer <hex>` header. Comparison is constant-time
   (`crypto.timingSafeEqual`).

You can override the auto-generated token with the `AUTODOM_TOKEN`
environment variable if you need a deterministic value (CI, integration
tests). For local forks or development builds with a different extension
ID, add exact IDs/origins with `AUTODOM_ALLOWED_EXTENSION_IDS` or
`AUTODOM_ALLOWED_EXTENSION_ORIGINS`.

Connections that satisfy neither layer receive **HTTP 401 Unauthorized**
and the rejection is logged to stderr.

WebSocket messages are also capped and minimally schema-checked before
dispatch. Unknown message types, malformed IDs, and oversized payloads are
ignored or rejected before they reach tool routing.

## API key storage

When the user configures a direct AI provider (OpenAI / Anthropic /
Ollama) in the extension popup, the API key is stored in
`chrome.storage.session`. This is **RAM-only** in MV3 — the key is
never persisted to disk and is cleared when the browser shuts down.

The extension also performs a one-shot migration on startup: any legacy
plaintext key found in `chrome.storage.local` is moved to
`chrome.storage.session` and removed from `local`.

The non-secret provider settings (provider type, model name, base URL)
remain in `chrome.storage.local` so the user's preferences survive a
browser restart — only the secret has to be re-entered.

## Browser-extension permissions

The Chrome manifest requests the following permissions. Each is paired
with the feature that needs it.

| Permission        | Why it's needed |
|-------------------|-----------------|
| `activeTab`       | Tool calls always operate against the current tab. |
| `scripting`       | `chrome.scripting.executeScript` is used by tools (`evaluate_script`, `query_elements`, …) and to lazy-inject the chat panel. |
| `tabs`            | Tab management tools (`list_tabs`, `switch_tab`, `close_tab`, etc.). |
| `storage`         | Persisting non-secret user preferences (port, auto-connect, provider choice). |
| `debugger`        | `handle_dialog` and other tools that need CDP-only commands. |
| `cookies`         | `get_cookies` / `set_cookie` tools. |
| `clipboardWrite`  | Copy-to-clipboard from the chat panel. |
| `webNavigation`   | `chrome.webNavigation.getAllFrames` for cross-frame tools. |
| `sidePanel`       | Opens the bundled side-panel UI. |
| `downloads`       | Saves user-requested artifacts such as generated exports. |
| `offscreen`       | Keeps MV3 service-worker state alive during active sessions. |
| `host_permissions: ["<all_urls>"]` | Tools must operate on any page the user opens. |

## Tools that execute arbitrary JavaScript

Some tools intentionally accept arbitrary JS strings and run them with
extension privileges via `eval` / `new Function(script)`:

- `execute_code`
- `evaluate_script`
- `execute_async_script`
- `browser_evaluate`

These exist so AI agents can perform DOM operations the typed tools do
not cover. Combined with the WebSocket auth layers above, only the
authenticated extension (or a token-bearing local client) can submit
them. They are classified as **destructive** in both the server tier map
and the in-extension ActionGate so site-level write approval is not enough
to run arbitrary code. If you want to disable these tools entirely, remove
them from
`TOOL_HANDLERS` in `extension/background/service-worker.js` — the
agent will simply lose those capabilities.

## Prompt-injection and context scrubbing

Direct-provider chat can include page-derived title, URL, outline, visible
text, and post-navigation tab context. These values are wrapped in
nonce-delimited `UNTRUSTED_PAGE_DATA` blocks and the system prompt
explicitly says they are observations, not instructions. Account-like
identifiers (`IC...`, `CB...`) and internal marker tags are scrubbed before
AI-facing prompts or user-facing chat output.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or
email the maintainers — do **not** file a public issue.
