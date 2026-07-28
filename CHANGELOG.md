# Changelog

All notable changes to AutoDOM are documented in this file.

---

## 4.3.0

### Added
- Added sticky-tab restriction and the public tools `double_click`,
  `middle_click`, `force_click`, `click_at_coordinates`, `key_down`, `key_up`,
  `get_bounding_box`, `get_computed_style`, `set_geolocation`,
  `delete_cookie`, `clear_cookies`, `print_to_pdf`, and `emulate_media`.
- Added explicit update lifecycle diagnostics covering discovery, runtime
  availability, pending-package receipt, apply attempts, install type, browser
  family, bridge state, and bounded blocked/failure reasons.
- Added canonical public tool-contract tests covering all 106 registrations,
  descriptions, schemas, handlers, uniqueness, and stale count copy.

### Fixed
- Separated published-manifest discovery from Chromium's downloaded
  `onUpdateAvailable` signal. Reload attempts are persisted and bounded; an
  ineffective reload becomes a truthful `blocked` state instead of an endless
  update/restart loop.
- Preserved unpacked share-bundle updates through the bridge while refusing to
  overwrite Git worktrees, which now receive exact `git pull` + Reload steps.
- Replaced `update.sh`'s unchecked in-place unzip with checksummed
  `updates.json`, a 50 MiB limit, staged validation, atomic replacement, and
  rollback.
- Propagated elevated Windows policy-installer failures and verified generated
  plist, JSON, and registry values after writing.

### Improved
- Upgraded FastMCP from 4.5.0 to 4.12.1 and resolved patched Hono, MCP SDK,
  `body-parser`, and `fast-uri` versions; `npm audit` reports zero
  vulnerabilities.
- Corrected managed-browser claims: Chrome/Edge require active vendor policy,
  Brave remains best-effort, and Arc/Ulaa/other Chromium browsers use the
  unpacked/manual path unless vendor support is verified separately.
- Pinned GitHub Actions and CRX release tooling to reviewed immutable versions.
- Split update-check orchestration into focused helpers, reducing measured
  `runUpdateCheck` cyclomatic complexity from 79 to 31 without changing test
  behavior.
- Removed hardcoded `70`/`70+` tool-count copy and corrected stale Node 18
  updater guidance.
- Hardened direct-provider context, WebSocket origin/auth handling, debugger
  tracking, destructive-tool tiers, cache feedback, and Security-tab escaping.

### Tests
- Added update lifecycle, policy installer, release workflow, updater
  integrity, and public tool-contract regression coverage.
- Verified FastMCP stdio, WebSocket auth, reconnect, proxy reconnect,
  concurrent multi-IDE traffic, and end-to-end tool calls.

---

## 4.2.1

### Fixed — update channel and updater integrity
- Release publishing now uploads and verifies CRX/ZIP assets before changing
  `updates.xml`, preventing manifests from pointing at missing release files.
- Added checksummed-channel `updates.json` metadata with SHA-256 artifact pins.
- Unpacked share updates now stream to disk, enforce a size limit, verify the
  digest and manifest, stage cross-platform extraction, and install atomically
  with rollback. Git worktrees are never overwritten.
- Periodic-update preference now remains respected after extension updates,
  and automatic reload waits until active agent work finishes.

### Improved — runtime speed and MCP compatibility
- Upgraded FastMCP 4, Zod 4, and ws 8; MCP server version now matches package
  version and unused roots negotiation is disabled.
- Raised bridge runtime floor to Node 20.19+, Node 22.12+, or Node 23+ because
  FastMCP 4 dependencies no longer support Node 18 or Node 21.
- Reduced `get_dom_state` subtree scans and repeated layout reads, standardized
  its 60-element default, clamped expensive inputs, and added opt-in scan
  diagnostics.

### Fixed — Multi-IDE bridge reliability ("secondary server can't reach primary")
- **Pre-startup cleanup no longer kills healthy sibling bridges.** During concurrent startup or an MCP restart, a newly launched instance could terminate another IDE's running bridge, orphaning every secondary that proxied through it. Root causes removed:
  - `phase1` only reclaimed the port from a listener whose **parent process name** matched a hardcoded IDE regex; bridges launched from terminals, `npx`, wrappers, or unrecognized IDEs were SIGKILLed. It now keeps any bridge whose **launching parent is still alive** (proxy mode) and only stops genuinely orphaned ones.
  - `phase1` also SIGKILLed any port holder it could not positively identify as its own bridge. It now never kills unidentified processes — it falls through to proxy mode / `EADDRINUSE` instead, so a false identification can no longer take down a user's process.
  - `phase3` zombie scan dropped the `CPU>50%` heuristic (startup spikes were false positives) and the "parent is not an IDE → kill" heuristic; it now reaps only truly orphaned bridges (parent dead / `PPID=1`) and never the lock-file owner.
  - `isBridgeProcess` now recognizes siblings launched with a **relative** script path (`node index.js`) by resolving the script argument against the process's working directory, instead of only matching the absolute server path.
- **Secondary tool calls now absorb a transient extension drop.** `_handleInternalProxyCall` (the primary's handler for proxied calls) waited zero time for the Chrome extension: closing/reopening the browser or a service-worker recycle made a secondary IDE hard-fail with "Chrome extension is not connected," even though the primary's own tool path waited it out. It now awaits `_waitForExtensionReady()` (the `RECONNECT_GRACE_MS` window) before erroring, and guards the result send against a closed secondary socket.

### Tests
- New `server/test/test-proxy-reconnect.cjs` — a secondary's proxied call survives an extension drop + reconnect within the grace window.
- `server/test/test-concurrency.cjs` now passes deterministically (previously failed ~50% of runs due to siblings killing each other at startup).

## 4.1.0

### Added — Media, image and recorder tools
- **`media_list`** — Enumerate `<video>` and `<audio>` elements on the active page with state (currentTime, paused, duration, dimensions, mute/volume, indexes).
- **`media_control`** — Play / pause / toggle / seek (`seekTo`, `seekBy`), set `playbackRate`, volume, mute / unmute, enter fullscreen or picture-in-picture. Addresses the previous inability to drive HTML5 video players.
- **`media_get_captions`** — Read active `TextTrack` cues; falls back to scraping YouTube DOM caption segments when no programmatic tracks are exposed.
- **`media_capture_frame`** — Grab the current `<video>` frame as a base64 PNG/JPEG dataURL.
- **`media_sample_frames`** — Sample N evenly-spaced frames between two timestamps (pauses, seeks, captures, restores play state) for vision-model summarisation.
- **`image_list`** — Enumerate `<img>` elements with src, alt, natural dimensions and bounding box.
- **`image_get_data`** — Fetch a page image's bytes as a base64 dataURL (fetch with credentials, canvas fallback). Reports clear CORS errors for cross-origin images without CORS headers.
- **`macro_record_start` / `macro_record_stop` / `macro_replay`** — Record user-style interactions on the active tab (clicks, inputs, key presses, scroll) and replay them at adjustable speed.
- **`tab_recording_start` / `tab_recording_stop` / `tab_recording_status`** — Record the active tab to a WebM video via `chrome.tabCapture` + `MediaRecorder` running inside the offscreen document. Stop returns an `objectUrl` that the chat panel downloads via `chrome.downloads`.

### Added — Chat panel UI
- Toolbar quick-actions for **List media**, **Describe images** (auto-attaches up to 4 page images to the next vision-model turn), **Record tab** (toggling WebM capture with a pulsing red ring), and **Record macro** (toggling JSON capture saved to `chrome.storage.local`).

### Changed
- `extension/manifest.json` declares `tabCapture` as an **optional** permission (`optional_permissions`). It is requested at runtime — via the popup's "Enable tab recording" button — so adding the tab recorder never forces a disable-on-update re-authorization prompt for existing installs. `tab_recording_start` checks the grant with `chrome.permissions.contains` and returns an actionable error when it is missing.
- `extension/offscreen.html` / `offscreen.js` now host the MediaRecorder in addition to the existing keepalive heartbeat; the SW relays recorder messages tagged with `__autodom_recorder: true`.
- `action-gate.js` classifies the new tools: reads (`media_list`, `media_get_captions`, `media_capture_frame`, `media_sample_frames`, `image_list`, `image_get_data`, `macro_record_stop`, `tab_recording_status`) are safe-read; recorders (`macro_record_start`, `macro_replay`, `tab_recording_start`, `tab_recording_stop`) are destructive and always confirm. `media_control` falls through to mutating.

### Tests
- New `tests/media-tools.test.mjs` covering catalog/tiers shape, handler surface, and the macro install/stop helper.
- Extended `tests/action-gate.test.mjs` with classification assertions for every new tool.

---

## [4.0.3] — 2026-05-20

### Fixed
- Fixed Ollama model routing on MCP bridge path so selected popup model is forwarded as `ollamaModel` (prevents fallback to missing `llama3.2`).
- Fixed stale chat model override handling so incompatible/old overrides no longer bypass active provider model.
- Fixed Ollama base URL normalization across popup, service worker, and provider client (`/api/tags`/`/api/chat` suffixes are stripped safely).

### Improved
- Added clearer Ollama 4xx diagnostics in chat errors, including request context for faster debugging.
- Added explicit 403 guidance for browser-origin blocks and `OLLAMA_ORIGINS` setup.
- Preferred local Ollama models in model list and guarded against `:cloud` tags in direct local path.

---

## [3.0.8] — 2026-05-06

### Improved
- Removed the beta Scripts surface from popup settings and simplified popup initialization for lower UI overhead.
- Removed legacy script-runner message paths (`RUN_AUTOMATION_SCRIPT` / `VALIDATE_AUTOMATION_SCRIPT`) from the extension bridge and service worker.

### Fixed
- Cleaned stale script/beta references and related dead code in popup, service worker, and server bridge logic.

---

## [3.0.7] — 2025-05-05

### Fixed
- Improved visibility checks in `waitForElement` tool to handle edge cases more reliably.

---

## [3.0.6] — 2025-05-04

### Improved
- Optimized status polling and shadow DOM traversal for better performance.
- Added cancellable timer for MCP inactive auto-close.
- Added error handling and availability checks for Chrome built-in AI.

### Fixed
- Chat panel reliability improvements.

---

## [3.0.5] — 2025-05-02

### Added
- **Playwright compatibility tools** — 18 `browser_*` aliases (`browser_snapshot`, `browser_click`, `browser_type`, `browser_navigate`, etc.) so agents built for Playwright MCP work with AutoDOM out of the box.
- Chrome built-in AI summarization and prompt support.
- Offscreen keepalive toggle and status command for long-running sessions.

### Improved
- Enhanced tool classification and tiering with parameter awareness.
- CLI performance tuning with configurable limits for turns, results, and history size.

---

## [3.0.4] — 2025-04-30

### Added
- Prepare-release GitHub Actions workflow for version bumping and tagging.
- Deferred rendering and scroll handling improvements in the chat panel.

### Improved
- Externalized chat panel CSS for improved performance.

---

## [3.0.2] — 2025-04-29

### Added
- Completion sound setting for the chat panel.
- Side panel toggle support.

### Improved
- Settings overlay handling in the popup.

---

## [3.0.1] — 2025-04-29

### Improved
- Update check logic with manifest preflight validation.
- Provider status handling and composer resize logic.

---

## [3.0.0] — 2025-04-29

### Added
- New tools for **iframe**, **shadow DOM**, and **canvas** interactions (`list_iframes`, `iframe_interact`, `list_shadow_roots`, `shadow_interact`, `deep_query`).
- Popup and window management tools (`list_popups`, `switch_to_popup`, `close_popup`, `wait_for_popup`).
- Chat request/response tools (`get_pending_chat_requests`, `respond_to_chat`).

### Removed
- Playwright/Node automation backends — AutoDOM is now 100 % browser-extension-native.

### Changed
- Documentation updated for the extension-only architecture.

---

## [2.2.9] — 2025-04-28

### Improved
- Refactored quick action prompts and added rich page analysis intent handling.
- CLI package installation support.
- Removed unused automation tools.

---

## [2.2.8] — 2025-04-27

### Added
- Auto-update functionality for extension updates.

---

## [2.2.7] — 2025-04-27

### Improved
- Refactored storage handling and runtime error suppression.

---

## [2.2.6] — 2025-04-26

### Added
- "Clear Tool Logs" functionality across client and server.

### Improved
- Refactored chat suggestions and added AI page query handling.

---

## [2.2.5] — 2025-04-25

### Improved
- Simplified GitHub Pages deployment in the release workflow.
- Version bump script for AutoDOM.

---

## [2.2.4] — 2025-04-24

### Improved
- Chat input expand button styles and behavior.

---

## [2.2.3] — 2025-04-24

### Improved
- CSP handling with fallback for code execution.
- Added iframe and shadow DOM interaction tools to agent capabilities.
- New browser automation tools and updates to existing ones.
- Revamped README for clarity and conciseness.

---

## [2.2.2] — 2025-04-23

### Changed
- Dropped Firefox/AMO support — Chrome-only distribution going forward.
- Embedded Chrome extension key in source manifest.

---

## [2.2.1] — 2025-04-22

### Added
- Update banner and expand button in the chat panel.
- Auto-update support for the extension lifecycle.

---

## [2.0.0] — 2025-04-20

### Added
- Initial public release.
- MCP bridge server with 50+ browser tools.
- In-page AI chat panel and inline overlay.
- Bring-your-own-provider support (OpenAI, Anthropic, Ollama).
- Zero-touch installer for macOS, Linux, and Windows.
- Enterprise silent-install policy templates.
- Manual script runner in the popup Scripts tab.
