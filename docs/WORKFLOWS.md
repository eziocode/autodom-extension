# Workflows, schedules and approvals

AutoDOM can learn a task once and repeat it without an AI model. This guide
covers:

- recording a workflow
- replaying it, with self-healing when the page changes
- exporting it as a Playwright test or a readable routine
- running it on a schedule
- the controls that keep you in charge: approval rules, take-over and the
  audit log

Everything here works from both places:

- **the in-page chat panel**, using slash commands
- **your IDE agent**, using MCP tools

## 1. Teach a task

| Chat panel | MCP tool |
| --- | --- |
| `/teach` (or the record button) | `workflow_record_start { url? }` |
| *do the task on the page* | *the agent drives the page, or you do* |
| `/teach Weekly report` | `workflow_record_stop { name, save: true }` |

The recorder captures:

- clicks and double-clicks
- typing (one step per field, using the final value)
- selects and checkboxes
- Enter and Escape
- navigations you type, plus every `navigate` the agent makes

Link clicks and form submits are not recorded as separate navigations,
because the click that caused them replays them.

Each target is stored as a **locator bundle**: test id, id, `name`, role and
accessible name, label, placeholder, text, CSS path, XPath, position, and the
shadow-DOM host path. Auto-generated ids such as `email-1234` or `:r5:` are
skipped because they change between builds.

**Variables.** Every typed value becomes a `{{variable}}`. For example, typing
into an "Email address" field creates `{{email_address}}`, and the value you
typed becomes its default. Password-like fields are treated differently:
their values are never sent to the recorder or stored, and they become
**secret** variables that you supply at run time.

## 2. Replay

```text
/replay Weekly report {"email_address": "me@example.com", "password": "…"}
```

```json
workflow_run { "id": "Weekly report", "variables": { "password": "…" } }
```

Replay is deterministic and uses no LLM. For each step, AutoDOM tries the
locator strategies from most to least stable. If more than one element
matches, it prefers visible elements with the same tag, then the one closest
to the recorded position.

**Self-heal** (`mode: "heal"`, the default). If no strategy finds the target,
AutoDOM scores every interactive element on the page against the recorded
bundle. The score combines role, accessible name, label, text, attributes and
position.

- If one element is a clear winner, AutoDOM acts on it.
- If the winner is not clear, and a direct AI provider is configured in the
  popup, the model picks from a compact list of candidates.

A healed locator is **saved back to the workflow** (the previous one is kept
under `previous`), so the next run is deterministic again. Use
`mode: "strict"` to fail instead of healing.

**Run reports.** Each report lists every step with:

- the locator strategy that matched
- whether the step was healed
- a before/after diff: URL, title, content changed, element count delta,
  and localStorage / sessionStorage / cookie keys added or removed

On failure, the report also includes a screenshot.

Retrieving reports:

- `workflow_run` waits up to just under the bridge tool timeout. Longer runs
  return a `runId` that you can poll with `run_get`.
- `run_cancel` stops a run.
- `/runs` in the chat panel and `run_list` over MCP show recent reports.

> Stopping or cancelling a run does not undo the steps that already ran.

## 3. Export and import

```text
/export Weekly report playwright
```

```json
workflow_export { "id": "Weekly report", "format": "playwright", "save": true }
```

| Format | What you get |
| --- | --- |
| `playwright` | A `.spec.ts` file. Locators use `getByTestId`, `getByRole`, `getByLabel` and `getByPlaceholder`. Variables are read from `AUTODOM_<NAME>` environment variables. |
| `markdown` | A readable routine (numbered steps plus a variables table). The machine-readable workflow is embedded at the end. |
| `json` | The raw workflow. |

Where files go:

- Every saved workflow is mirrored to
  `~/.autodom/workflows/<id>.json`, so you can review and version it.
- `workflow_export { save: true }` writes to `~/.autodom/exports/`, or to an
  explicit `path` you give it.
- `workflow_save { path: "flow.md" }` imports a routine, either JSON or the
  Markdown export, so you can edit a routine in a pull request and load it
  back.
- `workflow_from_recording` turns an older `start_recording` session log into
  a workflow, using the agent's selectors.

## 4. Schedules and shortcuts

```json
schedule_create { "workflowId": "Weekly report", "weekly": { "days": [1], "time": "09:00" } }
schedule_create { "workflowId": "Health check", "every": 30, "notifyOn": "failure" }
```

**What a schedule can run:**

- A **workflow**, which needs no LLM.
- A **prompt**, which needs a direct OpenAI, Anthropic or Ollama provider in
  the popup.

**How often:** `every` N minutes, `daily` at a time, or `weekly` on chosen
days. Times are the browser's local time.

**How it runs:**

- Each run opens a background tab in the AutoDOM tab group and closes it
  afterwards (`keepTab: true` keeps it open).
- A failed run raises a desktop notification. `notifyOn: "always"` notifies
  on every run.

**Limits:**

- Schedules fire only while the browser is open.
- A run that was missed while the browser was closed fires once at the next
  start-up (`catchUp`, on by default).
- A run is skipped if the previous run of the same schedule is still going.

Pause a schedule with `schedule_update { id, enabled: false }`. To start one
right now, use `schedule_update { id, runNow: true }`. Use `/schedules` in the
chat panel to see what is scheduled.

**Shortcuts** are saved prompts that become their own slash commands:

```text
/shortcut add standup Summarise my open pull requests on this page
/standup
```

## 5. Compact snapshots and `@eN` refs

`take_snapshot { mode: "interactive" }` returns only the elements you can act
on, one line each:

```text
Page: Sign in — https://example.com/login
@e1 textbox "Email address" [email testid=email]
@e2 input "Password" [password]
@e5 button "Sign in"
```

Pass a ref to `click`, `type_text`, `hover`, `select_option` or `press_key`,
for example `click { ref: "@e5" }`.

- Refs stay valid until the page navigates or re-renders.
- A stale ref returns an error that tells the agent to take a new snapshot.
- `browser_snapshot` uses this mode by default when you give it no target.
  The `browser_click`, `browser_type`, `browser_hover` and
  `browser_select_option` aliases accept a Playwright-MCP-style `ref` too.

## 6. Site-defined tools (WebMCP)

Some sites register their own agent tools through WebMCP, using
`document.modelContext.registerTool()`. This is in a Chrome origin trial for
versions 149–156.

- `webmcp_list_tools` shows them.
- `webmcp_call_tool { name, arguments }` calls one.

Calling a site's own tool is usually faster and more reliable than driving
its UI. The compact snapshot header tells you when a page has WebMCP tools.

## 7. Staying in control

### Approval rules

Approval rules apply to IDE agent calls. Only you can edit them, from the
chat panel:

```text
/rules add deny *.mybank.com any
/rules add ask github.com destructive
/rules add allow localhost
/rules
```

How they work:

- The first matching rule wins.
- `deny` blocks the call.
- `ask` holds the call. Older MCP clients approve it with `confirm_action`.
  Clients on MCP 2026-07-28 that support elicitation instead get an inline
  "Allow this action?" prompt (`inputRequired`), and the retry carries a
  signed, single-use approval.
- Agents can read the rules with the `approval_rules` tool but cannot change
  them.

### Take over

While AutoDOM controls a tab, the session border shows a **Take over**
button.

- Clicking it pauses workflow runs on that tab. Agent calls that would change
  the tab return `USER_TAKEOVER`, so the agent waits instead of fighting you.
- Click **Hand back** to let AutoDOM continue from the page as it is now.

### Audit log

Every write or destructive tool call is appended to
`~/.autodom/audit/YYYY-MM-DD.jsonl`. Each entry records:

- the tool and its tier
- the site
- the decision: executed, blocked, held, deferred or error
- whether it was confirmed
- who made the call: the agent, or the user from the chat panel
- the parameters, with secrets redacted

Query it with `audit_query { decision: "blocked" }`. Two environment
variables control it:

- `AUTODOM_AUDIT=0` turns the log off.
- `AUTODOM_AUDIT=all` also records read-only calls.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTODOM_HOME` | `~/.autodom` | Where workflow mirrors, exports and the audit log live |
| `AUTODOM_AUDIT` | `on` | `0` disables the audit log; `all` also records read-only calls |
