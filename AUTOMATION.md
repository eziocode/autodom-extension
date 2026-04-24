# Local Automation Scripts

AutoDOM can run user-provided automation scripts locally without AI or external
cloud services.

## Backends

- `browser-extension`: runs JavaScript in the active browser tab through the
  extension. Use this from the popup Scripts tab or the MCP `run_browser_script`
  tool.
- `playwright`: runs a local Playwright script from the MCP bridge process. Use
  this from an IDE through MCP or from the popup Scripts tab after connecting
  MCP.
- `node`: runs a local Node.js script from the MCP bridge process. Parameters are
  available in `process.env.AUTODOM_AUTOMATION_PARAMS`.

The backend registry lives in `server/automation/backends.js`; add another
backend there to extend the system.

## Setup

Install the normal server dependencies:

```bash
cd server
npm install
```

For Playwright scripts, install Playwright in the server environment:

```bash
cd server
npm install playwright
npx playwright install chromium
```

Load the browser extension as usual, then connect the popup to the MCP bridge if
you want to run `playwright` or `node` scripts from the popup.

## Browser Extension Execution

Open the extension popup, select the `Scripts` tab, choose
`Browser extension`, then upload or paste a script.

Example:

```js
log("Running in the active tab:", location.href);

return {
  title: document.title,
  url: location.href,
  links: document.links.length,
};
```

The script runs in the active page context and can use:

- `document`, `window`, `location`
- `params`: JSON parameters
- `log(...)`: execution log output

You can also use the MCP tool:

```json
{
  "source": "log(document.title); return { title: document.title };",
  "timeoutMs": 15000
}
```

with tool name `run_browser_script`.

## MCP / IDE Playwright Execution

Use the MCP tool `run_automation_script`.

Example local script: `examples/playwright-script.mjs`

```js
export default async function ({ page, params, log }) {
  const url = params.url || "https://example.com";
  log("Opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { title: await page.title(), url: page.url() };
}
```

Example MCP tool arguments:

```json
{
  "backend": "playwright",
  "scriptPath": "/absolute/path/to/autodom-extension/examples/playwright-script.mjs",
  "params": { "url": "https://example.com" },
  "browser": "chromium",
  "headless": true,
  "timeoutMs": 60000
}
```

Useful MCP tools:

- `list_automation_backends`
- `validate_automation_script`
- `run_automation_script`
- `run_browser_script`

## Error Handling And Logs

Each run returns:

- `ok`: boolean success flag
- `status`: `completed`, `failed`, `timeout`, or `validation_error`
- `stdout` / `stderr`: server-side process output
- `logs`: structured log lines emitted by `log(...)`
- `elapsedMs`: runtime duration
- `error`: failure detail when available

The popup Scripts tab shows the latest run output. The Logs tab still shows
bridge/tool errors.
