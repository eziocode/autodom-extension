# Changelog

All notable changes to AutoDOM are documented in this file.

---

## Unreleased

### Improved
- Added a click-again confirmation and accessible popup toast feedback for **Clear extension cache**, including visible success and error states instead of only an activity log entry.

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
