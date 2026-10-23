# AutoDOM

AutoDOM lets an MCP client (an IDE agent or CLI) drive a real Chromium browser.
It is two programs that talk over a local WebSocket:

- `server/`: a Node.js MCP server. Speaks MCP over stdio (optionally HTTP) to
  the client, and runs a WebSocket bridge on `127.0.0.1`.
- `extension/`: a Manifest V3 extension. Executes the tool calls in the
  browser through `chrome.scripting`, `chrome.tabs` and the DevTools protocol.

Current release: **7.0.0** ([changelog](CHANGELOG.md)). License: MIT.

Targeted clients: GitHub Copilot, JetBrains AI Assistant, Claude (Desktop and
Code), Cursor and Gemini CLI. Anything that speaks MCP over stdio should work.

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install](#install)
- [Verify](#verify)
- [Client configuration](#client-configuration)
- [Tools](#tools)
- [Output compaction (ATK)](#output-compaction-atk)
- [Tab isolation](#tab-isolation)
- [Configuration reference](#configuration-reference)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Documentation](#documentation)

## Architecture

```
MCP client            AutoDOM server                    Extension (service worker)
(IDE / CLI)           server/index.js                   extension/background/
    |                        |                                  |
    |--- stdio, JSON-RPC --->|                                  |
    |                        |--- ws://127.0.0.1:9876 --------->|
    |                        |    origin pin + bearer token     |
    |                        |                                  |-- chrome.scripting  (DOM)
    |                        |                                  |-- chrome.tabs       (tabs)
    |<-- result (compacted) -|<-------------------------------- |-- chrome.debugger   (CDP)
```

Everything stays on loopback. The client never talks to the browser directly;
the server validates each frame, authenticates the extension, applies the
safety tier of the tool, and compacts the result before returning it.

Several clients can run at once. The first server instance owns the port and
writes a lock file (PID, port, token; mode `0600`) in the OS temp directory.
Later instances start in proxy mode and relay through the primary instead of
competing for the port. A bridge that finds a newer `server/` on disk restarts
itself in place (`AUTODOM_AUTO_RESTART=0` disables this).

## Requirements

| Item | Requirement |
|---|---|
| Node.js | 20.19+, 22.12+ or 23+ (`node -v`) |
| Browser | Chrome or Edge for managed install; Brave best effort; other MV3 browsers use the unpacked extension |
| Client | Any MCP client; the installer configures IntelliJ-family IDEs, VS Code, Cursor, Claude Desktop and Gemini CLI |
| Port | `9876` on `127.0.0.1`, changeable with `--port` |
| Privileges | One-time admin prompt for managed browser policy (skippable) |

## Install

```bash
git clone https://github.com/eziocode/autodom-extension.git
cd autodom-extension

./setup.sh                                               # macOS / Linux / WSL / Git Bash
powershell -ExecutionPolicy Bypass -File .\setup.ps1     # Windows
```

The installer:

1. checks the Node.js version and runs `npm install` in `server/`;
2. detects installed IDEs and writes the MCP entry for each;
3. enables AutoDOM for GitHub Copilot and JetBrains AI Assistant;
4. writes and verifies managed-policy files for Chrome and Edge (and Brave on
   a best-effort basis), which needs one `sudo` or UAC prompt.

Afterwards restart the browser and check that `ExtensionSettings` is active on
its policy page (`chrome://policy`, `edge://policy`). Managed install and
updates only work once the browser has accepted the policy. Then restart the
IDE so it reloads its MCP config. The extension popup should show Connected.

Options: `--no-auto-update` (`-NoAutoUpdate` on PowerShell) skips the update
channel; `--name autodom-edge --port 9877` registers a second instance for a
second browser profile. Manual steps for each IDE are in
[INSTALL.md](INSTALL.md).

## Verify

`scripts/mcp-selftest.mjs` starts a server, performs the MCP handshake and
checks the tool list. Pass the server path as an absolute path.

```bash
node scripts/mcp-selftest.mjs "$PWD/server/index.js" --port 9945
```

Expected: every line prefixed with a check mark, ending with
`autodom_diagnostics reports a bridge role`. Stop a running bridge with
`node server/index.js --stop [--port N]`.

## Client configuration

Any stdio MCP client needs the same entry. The path must be absolute, because
IDE working directories are unpredictable.

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/absolute/path/to/autodom-extension/server/index.js"]
    }
  }
}
```

| Client | Config location |
|---|---|
| IntelliJ family | Settings, Tools, MCP Servers |
| VS Code, Cursor | `.vscode/mcp.json` in the workspace |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

Environment variables go in an `env` block of the same entry. See the
[configuration reference](#configuration-reference).

Optional transports, both off by default:

- `--mcp-http-port N` (or `AUTODOM_MCP_HTTP_PORT`): stateless Streamable HTTP
  at `/mcp`.
- `--http-port N` (or `AUTODOM_HTTP_PORT`): a plain REST API,
  `POST /tools/<name>` with a JSON body. Set `AUTODOM_HTTP_TOKEN` to require a
  bearer token. Useful for scripts and CI without an MCP client.

## Tools

138 tools are registered. 117 are listed to clients by default; the 19
Playwright-compatible aliases (`browser_click`, `browser_snapshot`, ...) stay
callable by name but are only listed with `AUTODOM_PLAYWRIGHT_COMPAT=1`, and
the two Code Mode tools (`run_code`, `code_api`, below) are only listed with
`AUTODOM_CODE_MODE=1`.

| Area | Tools |
|---|---|
| Observe | `take_snapshot`, `get_dom_state`, `query_elements`, `deep_query`, `extract_text`, `extract_data`, `get_html`, `get_page_info`, `take_screenshot`, `get_bounding_box`, `get_computed_style`, `check_element_state` |
| Act | `click`, `type_text`, `fill_form`, `select_option`, `hover`, `press_key`, `scroll`, `drag_and_drop`, `double_click`, `right_click`, `middle_click`, `force_click`, `click_at_coordinates`, `key_down`, `key_up`, `click_by_index`, `type_by_index`, `upload_file` |
| Navigate and wait | `navigate`, `wait_for_text`, `wait_for_element`, `wait_for_navigation`, `wait_for_network_idle`, `handle_dialog` |
| Tabs and frames | `list_tabs`, `open_new_tab`, `switch_tab`, `close_tab`, `pin_tab`, `unpin_tab`, `get_pinned_tab`, `finish_session`, popups (`list_popups`, `switch_to_popup`, `close_popup`, `wait_for_popup`), `list_iframes`, `iframe_interact`, `list_shadow_roots`, `shadow_interact` |
| Scripting | `execute_code`, `evaluate_script`, `execute_async_script` (deprecated), `batch_actions` |
| Debugging | `get_console_logs`, `get_network_requests`, `har_start`, `har_status`, `har_stop`, `performance_start_trace`, `performance_stop_trace`, `emulate`, `emulate_media`, `set_viewport`, `set_geolocation`, `print_to_pdf` |
| Storage | `get_cookies`, `set_cookie`, `delete_cookie`, `clear_cookies`, `get_storage`, `set_storage`, `set_attribute` |
| Workflows | `workflow_record_start`, `workflow_record_stop`, `workflow_save`, `workflow_list`, `workflow_get`, `workflow_run`, `workflow_run_many`, `workflow_export`, `run_list`, `run_get`, `run_cancel`, `run_undo`, `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete` |
| Control and audit | `approval_rules`, `audit_query`, `get_tool_tiers`, `confirm_action`, `cancel_action`, `autodom_diagnostics`, `get_session_summary` |
| Output | `recall`, `token_stats` |
| Page-provided | `webmcp_list_tools`, `webmcp_call_tool` (tools a page registers through WebMCP) |

Every tool has a safety tier, returned by `get_tool_tiers`:

| Tier | Meaning | Examples |
|---|---|---|
| read | no side effects | `take_snapshot`, `get_html`, `get_console_logs`, `list_tabs` |
| write | changes page or browser state | `click`, `type_text`, `set_cookie`, `scroll`, `emulate` |
| destructive | navigation, data loss or arbitrary code | `navigate`, `fill_form`, `batch_actions`, `execute_code`, `evaluate_script`, `clear_cookies`, `workflow_run` |

Destructive calls are held for confirmation according to
`AUTODOM_CONFIRM_MODE`. Clients that support MCP elicitation get an inline
approval prompt; others use `confirm_action` / `cancel_action`. Per-site rules
(`approval_rules`) and domain allow/deny lists apply on top. Every write and
destructive call is recorded in the audit log (`audit_query`).

Workflows (record a task once, replay it without a model, self-heal when the
page changes, export to Playwright or Markdown, schedule it) are described in
[docs/WORKFLOWS.md](docs/WORKFLOWS.md).

### Code Mode (experimental)

Instead of one MCP call per browser step, the model writes one script against
a typed `autodom.*` API and `run_code` runs it in a QuickJS (wasm) sandbox.
Intermediate results stay in the sandbox; only the script's return value and
`console.log` output come back.

```js
await autodom.navigate({ url: "https://example.com" });
const links = await page.eval(() => [...document.links].map((a) => a.href));
return links.filter((h) => h.includes("/docs/")).slice(0, 10);
```

- `code_api` returns the API: no arguments gives one line per tool (about
  11 KB against about 63 KB for `tools/list`); `{tools: [...]}` or `{query}`
  gives exact TypeScript declarations.
- Globals: `autodom.<tool>(params)` for 104 tools, `page.eval(fn, ...args)`
  (runs `fn` in the active tab through `execute_code`), `emitImage(ref)`,
  `sleep(ms)`, `console`. No `fetch`, `require`, timers or filesystem.
- Every inner call is the same tool an MCP client would call: zod-validated,
  then run through domain guardrails, confirm mode, approval rules and the
  audit log. A call held for approval pauses the script and `run_code`
  returns the hold. Approving it (inline prompt or `confirm_action`) runs that
  call and resumes the script, and you get the script's result or its next
  hold. Declining (`cancel_action`) makes the call throw `ApprovalDenied`
  inside the script. Time spent waiting does not count toward `timeoutMs`. A
  paused script is discarded after 5 minutes, together with its hold; at most
  8 scripts can be paused at once. Meta tools (`batch_actions`,
  `confirm_action`, `approval_rules`, ...) are not reachable from a script.
- `allow: "read" | "write" | "destructive"` caps the tiers a script may use.
  Limits per run: 60 s by default (`timeoutMs` up to 300 s), 32 MB heap, 200
  tool calls.

## Output compaction (ATK)

Tool results are the largest part of an agent's token spend. ATK rewrites them
before they leave the server. It is on by default; each cut is stored so the
original is always recoverable.

| Tool | Default output |
|---|---|
| `get_console_logs` | Repeats grouped with counts (`ERR [x37] ...`), errors first, stacks capped at 4 frames, one-line summary when empty |
| `get_network_requests` | Grouped by method, endpoint pattern and status; failures first; static assets and known trackers hidden unless `urlPattern` is set |
| `get_html` | Scripts, styles, svg bodies, comments and noise attributes removed; about 8 KB budget |
| `extract_text` | Duplicate lines and whitespace collapsed; about 6 KB budget |
| `evaluate_script`, `execute_code` | Large JSON shrunk level by level to a size budget |
| `take_snapshot` | Interactive mode by default: one line per actionable element, `@e12 button "Save"` |
| everything else | 24 KB cap |

Measured on one Wikipedia article: `get_html` 489 KB to 8.1 KB, an
`execute_code` link dump 101 KB to 4.7 KB, `extract_text` 20.7 KB to 6.1 KB.
Results vary by page.

Recovering what was cut:

```
[full output: 1833 lines · recall {id:"2eb8de"} · grep/from/lines to page]
```

`recall {id, from, lines}` pages through the original; `recall {id, grep}`
returns matching lines with line numbers. Entries live in bridge memory for 30
minutes (64 entries, 32 MB).

Other controls:

- `verbose: true` on a call, or `AUTODOM_OUTPUT=full` on the server, returns
  the raw result.
- `take_snapshot {mode: "diff"}` returns only the elements added, changed or
  removed since the last snapshot of the page. `click`, `type_text`,
  `select_option`, `press_key` and `navigate` accept `snapshot: "diff"` or
  `"full"` to append a snapshot to the action result.
- `token_stats` reports raw versus returned tokens per tool (estimated at 4
  bytes per token). `autodom_diagnostics` includes the same summary.
- Output rules in `~/.autodom/filters.json` strip or cap lines per tool and
  URL:

  ```json
  { "rules": [ {
      "tool": "get_console_logs",
      "match_url": "localhost:3000",
      "strip_lines_matching": "\\[HMR\\]|Download the React DevTools",
      "max_lines": 60,
      "on_empty": "console: clean"
  } ] }
  ```

  A `.autodom/filters.json` in the working directory is ignored unless
  `AUTODOM_TRUST_PROJECT_FILTERS=1`, because a project file can hide errors
  from the agent.

Source: [`server/atk/`](server/atk), tests in `tests/atk.test.mjs`.

## Tab isolation

On by default. Automation runs in its own tab group named AutoDOM, in
background tabs that are never activated, so the browser stays usable while an
agent works. A tab you own is only touched after the agent adopts it with
`pin_tab` (or `switch_tab`); it is restored to where it was when the session
ends. `finish_session`, an IDE disconnect, or the idle timeout
(`AUTODOM_ISOLATION_IDLE_MS`) closes the tabs AutoDOM opened.
`AUTODOM_ISOLATION=0` returns to following the active tab.

## Configuration reference

The server port is a flag, not an environment variable: `--port N`.

Bridge and runtime:

| Variable | Default | Purpose |
|---|---|---|
| `AUTODOM_TOKEN` | random | Override the generated bridge token |
| `AUTODOM_ALLOWED_EXTENSION_IDS`, `AUTODOM_ALLOWED_EXTENSION_ORIGINS` | canonical AutoDOM ID | Extra extension IDs or origins, comma separated, for fork or dev builds |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Per tool call, ms |
| `AUTODOM_RECONNECT_GRACE` | `8000` | How long a call waits for the extension to reconnect before failing, ms |
| `AUTODOM_BOOTSTRAP_WAIT` | `12000` | How long a call waits for the primary/proxy election, ms |
| `AUTODOM_HEARTBEAT_MS` | `3000` | Launcher liveness check, ms |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Idle shutdown, ms; `0` disables |
| `AUTODOM_AUTO_RESTART` | `1` | `0`: do not restart onto a newer `server/` found on disk |
| `AUTODOM_SERVER_SELF_UPDATE` | `1` | `0`: do not download and install server updates |
| `AUTODOM_ISOLATION` | `1` | `0`: disable tab-group isolation |
| `AUTODOM_ISOLATION_IDLE_MS` | `300000` | Idle time before an unfinished session's tabs are closed; `0` disables |
| `AUTODOM_HOME` | `~/.autodom` | Workflow mirrors, exports, audit log |
| `AUTODOM_AUDIT` | on | `0` disables the audit log; `all` also records read-only calls |
| `AUTODOM_DEBUG` | `0` | `1`: verbose stderr logging |
| `AUTODOM_WIRE_LOG` | `0` | `1`: log every wire frame |

Output and tool listing:

| Variable | Default | Purpose |
|---|---|---|
| `AUTODOM_OUTPUT` | compact | `full`: disable ATK compaction |
| `AUTODOM_TRUST_PROJECT_FILTERS` | `0` | `1`: honour a project-local `.autodom/filters.json` |
| `AUTODOM_PLAYWRIGHT_COMPAT` | `0` | `1`: list the Playwright-compatible aliases |
| `AUTODOM_CODE_MODE` | `0` | `1`: list `run_code` and `code_api` (Code Mode) |

Tool gating:

| Variable | Purpose |
|---|---|
| `AUTODOM_ALLOWED_DOMAINS` | Comma-separated allowlist |
| `AUTODOM_BLOCKED_DOMAINS` | Comma-separated denylist; wins over the allowlist |
| `AUTODOM_CONFIRM_MODE` | `auto`, `always` or `never` for destructive tools |

In-browser chat panel providers (not used by IDE agents):

| Variable | Default |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AUTODOM_OPENAI_MODEL` | unset, `https://api.openai.com/v1`, `gpt-4.1-mini` |
| `ANTHROPIC_API_KEY`, `AUTODOM_ANTHROPIC_MODEL` | unset, `claude-3-5-sonnet-latest` |
| `OLLAMA_BASE_URL`, `AUTODOM_OLLAMA_MODEL` | `http://localhost:11434`, `llama3.2` |

Keys entered in the popup are held in `chrome.storage.session` (memory only).

Keyboard shortcuts: Cmd/Ctrl+Shift+K toggles the chat sidebar,
Cmd/Ctrl+Shift+L the inline overlay.

## Security model

- Loopback only. The bridge binds `127.0.0.1`.
- Two checks on every WebSocket connection: an origin allowlist (the packaged
  extension's ID; other extension origins are rejected unless configured) and,
  for non-browser local clients, a 256-bit bearer token from the `0600` lock
  file, compared in constant time.
- Frame size is limited during receipt; messages are type- and id-checked
  before routing.
- Page content sent to direct AI providers is wrapped as untrusted data.
- Tools that run arbitrary code are in the destructive tier.
- Recall entries hold page content and live only in bridge memory. Nothing is
  sent off the machine except by the chat providers you configure.

Details and extension permissions: [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| IDE reports "Transport closed" | Kill stale processes on the bridge port, restart the IDE |
| Popup shows Disconnected | Click Connect; reload the extension; check the port matches the server's `--port` |
| Forked or dev extension cannot connect | Add its ID to `AUTODOM_ALLOWED_EXTENSION_IDS` |
| IDE lists no tools | Use an absolute path in the MCP config; run `node -v` (needs 20.19+); restart the IDE |
| Tool calls fail on `chrome://` or Web Store pages | Extensions cannot inject there |
| Console or network tools prompt for permission | They ask once per site, by design |
| Output looks truncated | Follow the `recall {id:"..."}` hint, or pass `verbose: true` |
| Port in use | `node server/index.js --stop`, or run a second instance with `--port 9877` |
| Chat panel: `Ollama 403` | Start Ollama with `OLLAMA_ORIGINS="chrome-extension://*,http://localhost,http://127.0.0.1"` |
| Chat panel: model not found | Pick an installed model in the provider settings |
| Update status looks stale | Popup, Updates, Clear extension cache |

More in [INSTALL.md](INSTALL.md#troubleshooting).

## Repository layout

```
extension/
  background/    service worker, tool handlers, workflow engine, action gate,
                 tab isolation, tool lanes, debug capture, HAR recorder, scheduler
  content/       chat panel, session border overlay
  popup/         connection and settings UI
  sidepanel/     side panel
  common/        shared helpers
  offscreen.js   keeps the MV3 service worker alive
  manifest.json
server/
  index.js       MCP server, WebSocket bridge, tool registry
  atk/           output compaction, recall store, snapshot diff, stats, rules
  self-restart.js, update-utils.js, bridge-reaper.js, native-host.js
  automation-store.js, viewer-app.js
  test/          bridge integration tests (reconnect, proxy, self-update, ...)
enterprise/      managed-policy templates (macOS plist, Windows registry, Linux JSON)
scripts/         build, pack, version bump, update manifests, mcp-selftest
tests/           unit tests (node:test)
docs/            workflow guide, release notes; also the update channel site
examples/        usage examples
setup.sh, setup.ps1, update.sh
```

Server tools are registered in `server/index.js` through `server.addTool`;
extension handlers live in the `TOOL_HANDLERS` map in
`extension/background/service-worker.js`.

## Development

```bash
cd server && npm ci

# unit tests (from the repo root)
node --test tests/*.test.mjs server/test/test-update-utils.mjs

# bridge integration tests (from server/), each on its own port
node test/test-reconnect.cjs
node test/test-concurrency.cjs
node test/e2e.cjs
# the full list is in .github/workflows/build.yml

# before a release or any dependency change
cd server && npm audit --audit-level=high
```

Adding a tool: define it in `server/index.js`, add its tier to `TOOL_TIERS`,
add the extension handler, and update the inventory count in
`tests/tool-contract.test.mjs`.

Releases: pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which
builds the CRX, the Chrome zip and the share bundle and attaches them to a
GitHub release. `scripts/bump-version.sh` updates every committed version
string; the Prepare Release workflow can do the bump, commit and tag for you.
Signing is described in [docs/RELEASE-SIGNING.md](docs/RELEASE-SIGNING.md).

## Documentation

| Document | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | Manual install, per-IDE setup, ports, uninstall |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Record, replay, self-heal, export, schedule; approvals, take-over, audit log |
| [AUTOMATION.md](AUTOMATION.md) | Running automation without an AI model |
| [UPDATES.md](UPDATES.md) | Update channel, popup controls, enterprise rollout |
| [SECURITY.md](SECURITY.md) | Authentication, secret storage, permissions |
| [enterprise/README.md](enterprise/README.md) | Force-install policy for managed fleets |

## License

MIT, as declared in `server/package.json`.
