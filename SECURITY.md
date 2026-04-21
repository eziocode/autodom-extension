# AutoDOM — Security Model

This document describes how AutoDOM protects the local WebSocket bridge,
where API keys live, and which extension permissions are granted and why.

## WebSocket bridge authentication

The bridge process (`server/index.js`) listens on `ws://127.0.0.1:<port>`
(default `9876`). Two layers of authentication are enforced for every
incoming connection:

1. **Origin allowlist.** Browser-attached clients always include an
   `Origin` header. The AutoDOM extension's service worker sends
   `chrome-extension://<id>` (or `moz-extension://<id>` on Firefox) and
   is accepted. A malicious web page would send its own origin
   (`https://example.com`) and is rejected. This blocks **page-based
   attacks** — a hostile page that tries to drive the browser via
   `new WebSocket("ws://127.0.0.1:9876")`.

2. **Bearer token.** Non-browser local clients (the proxy-client mode,
   the `server/test/e2e.cjs` smoke test, and any future CLI) must
   present a token. The token is generated at server startup with
   `crypto.randomBytes(32)` (256 bits) and written to a lockfile in the
   OS temp directory with mode `0600` (owner read/write only). Clients
   pass the token via either `?token=<hex>` query string or
   `Authorization: Bearer <hex>` header. Comparison is constant-time
   (`crypto.timingSafeEqual`).

You can override the auto-generated token with the `AUTODOM_TOKEN`
environment variable if you need a deterministic value (CI, integration
tests).

Connections that satisfy neither layer receive **HTTP 401 Unauthorized**
and the rejection is logged to stderr.

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
| `host_permissions: ["<all_urls>"]` | Tools must operate on any page the user opens. |

Permissions that were previously requested but have been **removed** as
of this hardening pass: `nativeMessaging` and `sidePanel` (neither was
ever called from extension code).

## Tools that execute arbitrary JavaScript

Two tools intentionally accept arbitrary JS strings and run them with
extension privileges via `new Function(script)`:

- `evaluate_script`
- `execute_async_script`

These exist so AI agents can perform DOM operations the typed tools do
not cover. Combined with the WebSocket auth layers above, only the
authenticated extension (or a token-bearing local client) can submit
them. If you want to disable these tools entirely, remove them from
`TOOL_HANDLERS` in `extension/background/service-worker.js` — the
agent will simply lose those two capabilities.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or
email the maintainers — do **not** file a public issue.
