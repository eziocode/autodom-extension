# Changelog

All notable changes to AutoDOM are documented in this file.

---

## 5.2.0

### Added
- **Bridge check / Fix** in the popup's Status tab. Check reports the bridge
  helper, the primary server, stale AutoDOM processes, the extension ↔ bridge
  link, the port, the bridge's role and version, and the service-worker
  keepalive. Fix reaps stale servers, starts a fresh bridge when none owns the
  port, and reconnects. It runs on its own when the bridge drops.
- `com.autodom.bridge` native-messaging helper (`server/native-host.js`).
  `setup.sh` and `setup.ps1` register it per user, with no admin needed,
  through `scripts/native-host-install.mjs`. It is what lets Fix kill and
  start servers without a terminal. The extension asks for `nativeMessaging`
  as an optional permission on the first Fix click, so updating does not
  disable the extension over a new permission warning.
- `node server/index.js --bridge-only`: a detached primary with no stdio
  client. IDE-spawned instances join it as proxies. It exits after 10 minutes
  with neither an extension nor a proxy connected.
- The primary now knows its proxies. Proxies send `PROXY_HELLO`, and a
  `BRIDGE_STATUS` WebSocket message returns the pid, role, version and proxy
  list. `/health` now includes the role, pid and version.

### Fixed
- The bridge no longer stays down after Chrome suspends the MV3 service
  worker. Reconnect backoff lived on `setTimeout`, which dies with the worker.
  A 30 s `chrome.alarms` watchdog now re-kicks the connection. A Connect click
  also survives worker restarts, not just the auto-connect toggle. The
  offscreen keepalive is on by default while the bridge should run.
- Stale servers piled up. A `DEGRADED` instance with a live IDE parent was
  never reaped. The reaper (`server/bridge-reaper.js`) keeps the primary, the
  port owner and joined proxies. It kills orphans, and gives other instances a
  `SIGUSR2` nudge to rejoin before killing them.
- On macOS, `setup.sh` deleted `/tmp/autodom-bridge-<port>.json`, but the
  server writes the lock file under `$TMPDIR`. The stale lock was never
  cleared.
- `setup.sh` now uses `scripts/mcp-selftest.mjs` for its handshake check,
  like `setup.ps1`.

---

## 5.1.0

### Fixed
- The MCP server would not reliably auto-initiate, and restarting it from
  IntelliJ AI Assistant or GitHub Copilot MCP did nothing. Startup awaited
  stale-process cleanup *and* the WebSocket port election before attaching
  the stdio transport, so until both finished nothing read stdin and the
  client's `initialize` sat unread in the pipe. With the port free that was
  ~100ms — which is why Claude Code, usually the first client to start,
  always worked. With the port contended it was 5-11 seconds, past both
  hosts' handshake deadline. The stdio transport now comes up first and
  unconditionally; the bridge link is established in the background.
- A restart could hang the client forever. `setupProxyClient` and
  `tryRecoverSecondaryAsPrimary` called each other with no attempt cap and
  no backoff, and because the startup path awaited that promise chain, the
  stdio transport was never attached at all. The scenario was routine: the
  host SIGKILLs the launcher, the surviving grandchild keeps port 9876
  bound, and the replacement instance spins on it. Election is now a
  bounded state machine — a bind retry ladder (~4s, covering the departing
  instance's 3s hard-exit watchdog), at most three rounds, and recovery
  that is serialized and rate-capped instead of recursive.
- A failed election used to report success. `startWebSocketServer()`
  resolved through `.finally(resolve)` whether or not anything worked, so
  the server could come up owning neither the port nor a proxy link:
  `tools/list` answered normally and every single tool call returned
  "Chrome extension is not connected" — a bridge problem reported as a
  browser problem. There is now an explicit degraded state whose error
  names the port, the actual cause, and the `--stop` remedy, and
  `autodom_diagnostics` reports the real role.
- Tool calls arriving during startup took the primary path and produced the
  same misleading extension error, because the role defaulted to primary
  before anything had been decided. They now wait for the election to
  settle, and say so if it does not.
- A WebSocket server error after successful binding had no listener at all
  (`wss.once("error")` was consumed by the bind attempt). It fell through to
  the keep-alive `uncaughtException` hook, leaving a live process with a
  silently dead WebSocket server. A persistent handler now triggers recovery.
- `resources/list`, `resources/templates/list` and `prompts/list` answered
  `-32601`. That is spec-legal for an unadvertised capability, but some
  JetBrains AI Assistant builds treat a `-32601` on a startup probe as a
  fatal handshake error rather than "unsupported". Empty `resources` and
  `prompts` capabilities are now declared so those methods return empty
  lists, and `tools.listChanged` is advertised `false` to match reality —
  nothing ever emitted that notification.
- Every one of the 106 tool schemas shipped a top-level `$schema` keyword
  that zod stamps on conversion — ~5.8KB of dead weight, and some clients
  run incoming schemas through a sanitizer that rejects or mangles a draft
  it does not recognize. `tools/list` is now built without it.
- The pre-startup zombie scan matched every AutoDOM bridge on the machine
  and could SIGTERM/SIGKILL a healthy one serving a different port. It is
  now scoped to the port this instance is actually starting on.
- SIGHUP killed the bridge. The code deliberately left it unhandled on the
  belief that Node ignores SIGHUP when stdin is a pipe; it does not, the
  default action terminates — and `cli.js` forwarded SIGHUP into the child
  itself. macOS sends it on benign terminal and process-group changes, so a
  perfectly valid stdio pipe surfaced in the IDE as "Transport closed".
  SIGHUP is now explicitly ignored, and no longer forwarded.
- `--port=9877` was silently ignored by both entry points, which parsed only
  the space-separated form, so the server bound the default port instead and
  then collided with whatever already owned it. Both forms now work.
- `cli.js` could block for up to 60 seconds running `npm install` before the
  server process existed, which an MCP client sees as a dead server rather
  than a slow one. It now auto-installs only when a human is watching (stdin
  is a TTY) and otherwise fails immediately with the command to run.
- An orphaned bridge held the port for up to 15 seconds after its launcher
  died — exactly the window that forced the next client down the slow path.
  The liveness check now runs every 3 seconds, and because `cli.js` spawns
  the server rather than exec-replacing itself (Node cannot), the launcher's
  PID is passed down so the child notices a SIGKILLed launcher even after
  being reparented.
- `setup.ps1` had no JetBrains branch at all, so Windows IntelliJ AI
  Assistant users got zero configuration from the installer. The XML upsert
  now lives in `scripts/jetbrains-mcp-upsert.mjs`, shared with `setup.sh`,
  and the PowerShell installer registers every JetBrains IDE it finds.
- Both installers killed whatever held the target port without identifying
  it first, and `setup.sh` did it with a `kill` on a multi-line PID string
  that simply failed when there was more than one listener. Each holder is
  now identified, only AutoDOM processes are signalled, and the lock file is
  cleared only once the port is actually free — deleting a live primary's
  lock file stranded its auth token and broke every secondary's handshake.
- `setup.ps1` verified the server by feeding it invalid JSON-RPC and
  grepping its stderr banner, which passed even when the instance never
  became primary. Both installers now share `scripts/mcp-selftest.mjs`,
  which performs a real handshake and asserts the elected role.

---

## 5.0.2

### Fixed
- Copying the chat surface no longer picks up the UI. Select-all in the side
  panel (or on a host page with the panel open) swept in the header, status
  badge, page-context bar, welcome copy, suggestion chips, quick-action
  labels, keyboard hints, the footer legend, and the entire quick-prompt
  overlay, so a pasted conversation was mostly button text with the actual
  turns buried inside it. The panel and overlay roots now opt out of
  selection and only real content opts back in: message bodies, tool-result
  payloads, tool-card bodies, the page-context line, and form fields.
- The closed in-page panel and the dismissed quick-prompt overlay were hidden
  with `transform` / `opacity` alone, which leaves an element laid out — still
  selectable, still reachable with Tab, and still exposed to assistive tech as
  a live dialog. Both now leave the flow via `visibility`, with the flip
  delayed on the way out so the slide and fade still play. The side panel pins
  itself visible, since there the panel is the window.
- `closePanel()` is a no-op in the side panel. Esc and the MCP-disconnect
  auto-close both called it, which left the surface fully on screen (the
  side-panel overrides pin its transform) while the state machine believed it
  was shut: status polling stopped, the "chat panel will close" notice never
  came true, and the next toggle re-opened an already-visible panel.
- `/click` with no argument, and a bare `click ` in natural language, routed to
  `click_by_index` with `index: NaN` instead of falling through to the text
  matcher — `!isNaN("")` is true because `Number("")` is `0`. Both now require
  an explicit run of digits, and every `parseInt` in the command parsers passes
  radix 10.
- The chat and popup toasts stopped toggling `aria-hidden` on their
  `role="status"` live regions. Flipping a live region in and out of the
  accessibility tree announces unreliably — the text is set before the region
  re-enters it — and the faded-out string stayed parked in the DOM for the next
  select-all. They clear their text on hide instead.

---

## 5.0.1

### Fixed
- Unpacked installs can auto-update again. Since 4.3.0 the bridge refused any
  install root containing `.git`, which is every `git clone` install — the
  documented consumer path. It now classifies the root instead: a clean clone
  of the official repository is moved to the release tag with
  `git fetch --tags` + `git checkout v<X.Y.Z>` (updating `extension/` and
  `server/` together), a share bundle takes the existing verified-ZIP path, and
  a clone with uncommitted tracked changes or a different `origin` is refused
  with a specific reason. Untracked files no longer block an update and are
  never destroyed.
- The popup's ↻ button starts the bridge update on the first click for unpacked
  installs. It previously needed two: the first click only painted the
  "found" state.
- Updates now apply with no clicks at all when *Auto-apply updates* is on. The
  service worker starts the bridge update itself once a newer release is
  published, gated on a live bridge, a development install, no active agent
  run, and the existing retry cooldown. The toggle was previously inert for
  unpacked installs, which never receive a pending CRX.
- Unpacked installs no longer see managed-policy advice when an update needs
  attention; the notice reports what the bridge actually said.
- Replaced `extract-zip` with a dependency-free ZIP extractor. `extract-zip`
  2.0.1 (via unmaintained `fd-slicer`) hangs on Node >= 24 for any entry larger
  than one stream chunk, which silently broke share-bundle updates — the
  release archive stalls on `background/service-worker.js`. The replacement
  rejects path traversal, absolute names, symlinks, ZIP64, unsupported
  compression, and size/payload mismatches, and its output is byte-identical to
  system `unzip`.

### Tests
- Added coverage for install-root classification, tag checkout argv, the
  zero-click auto-update gates, first-click bridge start, and the ZIP
  extractor's adversarial cases.
- Verified all three update paths end to end against the live update channel:
  dirty-clone refusal, clean-clone Git update, and share-bundle ZIP update,
  each driven through the real bridge WebSocket.

---

## 5.0.0

### Changed
- Replaced FastMCP with the official Model Context Protocol TypeScript SDK v2.
- Added native MCP `2026-07-28` negotiation over stdio and an optional
  stateless Streamable HTTP endpoint at `/mcp`.
- Removed the legacy `/sse` and `/message` transport endpoints. The old
  `--sse-port` option remains as an alias for `--mcp-http-port`, but serves the
  new stateless `/mcp` endpoint.
- Replaced unsolicited IDE sampling with explicit `get_pending_chat_requests`
  and `respond_to_chat` tool handoff, matching the stateless protocol model.

### Improved
- Added public 60-second cache hints for `server/discover` and `tools/list`.
- Added localhost Host validation, extension/loopback Origin validation, and
  MCP `2026-07-28` CORS headers for the optional HTTP transport.
- Updated macOS/Linux and Windows setup dependency checks for official MCP SDK
  packages.

### Tests
- Migrated reconnect, proxy, concurrency, end-to-end, and setup verification
  flows to stateless per-request metadata.
- Verified modern stdio and Streamable HTTP negotiation at `2026-07-28`, all
  106 public tools, sessionless HTTP, cache hints, and the dependency audit.

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
