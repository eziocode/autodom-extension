# Manual Automation Scripts

AutoDOM runs user scripts **manually**, in the active browser tab, via the
extension popup. There is no server-side script runner, no Playwright or Node
child-process backend, and no MCP tool that triggers script execution. This
keeps script runs deterministic, isolated to a tab the user can see, and
prevents background script execution from interfering with regular MCP tool
calls.

## Backend

- `browser-extension` — the only backend. Scripts execute in the active tab's
  page context through the extension. Run them from the popup Scripts tab by
  clicking **Run**.

## Running A Script

1. Open the AutoDOM popup and switch to the **Scripts** tab.
2. Paste source into the editor or upload a `.js` / `.mjs` / `.cjs` file.
3. Optionally adjust the timeout (default 15000 ms).
4. Click **Validate** to check the source is non-empty, then **Run** to execute
   it against the current tab.

Example:

```js
log("Running in the active tab:", location.href);

return {
  title: document.title,
  url: location.href,
  links: document.links.length,
};
```

The script runs in the page's main world and can use:

- `document`, `window`, `location`
- `params`: JSON parameters provided by the popup form
- `log(...)`: appends to the execution log shown in the popup

## What Was Removed

Earlier builds shipped server-spawned `playwright` and `node` script backends
and an MCP-facing `run_automation_script` surface. These were removed to keep
AutoDOM single-purpose:

- AutoDOM is a Playwright alternative; it no longer depends on Playwright.
- IDE-driven MCP traffic cannot trigger script execution in the background.
- Script runs always require a deliberate click in the popup, gated to the
  popup origin in the service worker.

If a stale client still sends `RUN_AUTOMATION_SCRIPT` over the bridge, the
server replies with a clear `unsupported` error instead of spawning a process.
