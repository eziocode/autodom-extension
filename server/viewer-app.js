// AutoDOM — MCP App viewer (SEP-1865 / MCP Apps, protocol 2026-01-26).
//
// One self-contained HTML page, served as ui://autodom/viewer.html, that hosts
// render in a sandboxed iframe next to the tool result. It shows:
//   kind "run"      a workflow run report (steps, strategy, heals, diffs,
//                   undo options, failure screenshot)
//   kind "batch"    a workflow_run_many batch
//   kind "workflow" a saved workflow as a readable timeline
//
// Hosts that do not render MCP Apps simply show the tool's text content, so
// the viewer tools are useful everywhere. The page speaks the View side of the
// protocol over postMessage (ui/initialize, ui/notifications/tool-result) and
// can call back into the server (tools/call) for "Preview undo" / "Dry check".
// All data is rendered with textContent, never innerHTML.

export const VIEWER_URI = "ui://autodom/viewer.html";
export const VIEWER_MIME = "text/html;profile=mcp-app";

export const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<title>AutoDOM viewer</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #ffffff);
    --fg: var(--color-text-primary, #1f2328);
    --muted: var(--color-text-secondary, #656d76);
    --line: var(--color-border-primary, #d0d7de);
    --card: var(--color-background-secondary, #f6f8fa);
    --ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; --info: #0969da;
    --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme]) { --bg: var(--color-background-primary, #0d1117); --fg: var(--color-text-primary, #e6edf3); --muted: var(--color-text-secondary, #8b949e); --line: var(--color-border-primary, #30363d); --card: var(--color-background-secondary, #161b22); --ok: #3fb950; --bad: #f85149; --warn: #d29922; --info: #58a6ff; } }
  :root[data-theme="dark"] { --bg: var(--color-background-primary, #0d1117); --fg: var(--color-text-primary, #e6edf3); --muted: var(--color-text-secondary, #8b949e); --line: var(--color-border-primary, #30363d); --card: var(--color-background-secondary, #161b22); --ok: #3fb950; --bad: #f85149; --warn: #d29922; --info: #58a6ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--font); }
  h1 { font-size: 15px; margin: 0 0 2px; }
  .sub { color: var(--muted); margin-bottom: 10px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-weight: 600; font-size: 11px; border: 1px solid currentColor; margin-right: 6px; }
  .passed, .dry_ok, .undone { color: var(--ok); } .failed, .dry_broken { color: var(--bad); }
  .running, .queued, .dry_needs_heal, .cancelled, .would_undo, .skipped { color: var(--warn); }
  .chips { margin: 6px 0 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; font-size: 11px; color: var(--muted); }
  .chip.heal { color: var(--info); border-color: var(--info); }
  ol.steps { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  ol.steps > li { padding: 7px 10px; border-top: 1px solid var(--line); display: grid; grid-template-columns: 22px 1fr auto; gap: 8px; align-items: start; }
  ol.steps > li:first-child { border-top: 0; }
  .ico { font-weight: 700; text-align: center; }
  .ok .ico { color: var(--ok); } .bad .ico { color: var(--bad); } .skip .ico { color: var(--muted); }
  .what b { font-weight: 600; } .what .t { color: var(--muted); font-family: var(--mono); font-size: 12px; word-break: break-all; }
  .err { color: var(--bad); margin-top: 3px; }
  .dur { color: var(--muted); font-size: 11px; white-space: nowrap; }
  details { margin-top: 4px; } summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  pre { margin: 4px 0 0; padding: 6px 8px; background: var(--card); border: 1px solid var(--line); border-radius: 6px; font: 11px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; }
  img.shot { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-top: 6px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 4px; }
  button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--info); } button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 6px 10px; border-top: 1px solid var(--line); font-size: 12px; vertical-align: top; } th { background: var(--card); border-top: 0; color: var(--muted); font-weight: 600; }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .empty { color: var(--muted); padding: 24px 0; text-align: center; }
</style>
</head>
<body>
<div id="app"><div class="empty">Waiting for data from the host…</div></div>
<script>
(function () {
  "use strict";
  var app = document.getElementById("app");
  var nextId = 0, pending = {};
  var inHost = window.parent && window.parent !== window;

  function post(msg) { if (inHost) window.parent.postMessage(msg, "*"); }
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++nextId;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error(method + " timed out")); } }, 60000);
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "class") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k === "onclick") n.addEventListener("click", props[k]);
      else if (k === "src") n.src = props[k];
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function badge(status) { return el("span", { class: "badge " + status, text: String(status).replace(/_/g, " ") }); }
  function chip(text, cls) { return el("span", { class: "chip" + (cls ? " " + cls : ""), text: text }); }
  function secs(ms) { return ms == null ? "" : (ms / 1000).toFixed(1) + "s"; }

  function callTool(name, args) {
    return rpc("tools/call", { name: name, arguments: args }).then(function (res) {
      var t = res && res.content && res.content[0] && res.content[0].text;
      try { return JSON.parse(t); } catch (e) { return { text: t, isError: res && res.isError }; }
    });
  }

  function diffText(d) {
    if (!d) return "";
    var out = [];
    if (d.url) out.push("URL: " + d.url.from + "  →  " + d.url.to);
    if (d.title) out.push("Title: " + d.title.from + "  →  " + d.title.to);
    if (d.contentChanged) out.push("Page content changed (" + (d.elementDelta >= 0 ? "+" : "") + d.elementDelta + " elements)");
    ["localStorage", "sessionStorage", "cookies"].forEach(function (k) {
      if (!d[k]) return;
      if (d[k].added.length) out.push(k + " added: " + d[k].added.join(", "));
      if (d[k].removed.length) out.push(k + " removed: " + d[k].removed.join(", "));
    });
    return out.join("\n");
  }

  function renderSteps(steps) {
    var ol = el("ol", { class: "steps" });
    (steps || []).forEach(function (s) {
      var cls = s.unchecked || s.skipped ? "skip" : s.ok ? "ok" : "bad";
      var ico = s.unchecked ? "·" : s.skipped ? "↷" : s.ok ? "✓" : "✗";
      var what = el("div", { class: "what" }, [
        el("b", { text: (s.index + 1) + ". " + s.action }), " ",
        el("span", { class: "t", text: s.target || "" })
      ]);
      var chips = el("div", { class: "chips", style: "margin:4px 0 0" });
      if (s.strategy) chips.appendChild(chip("via " + s.strategy));
      if (s.healed) chips.appendChild(chip("healed: " + s.healed, "heal"));
      if (s.wouldHealTo) chips.appendChild(chip("would heal to " + s.wouldHealTo + (s.healScore ? " (" + s.healScore + ")" : ""), "heal"));
      if (s.ambiguous) chips.appendChild(chip("ambiguous match"));
      if (s.unchecked) chips.appendChild(chip("not checked"));
      if (s.undoable) chips.appendChild(chip("undo: " + s.undoable.join(", ")));
      if (s.irreversible) chips.appendChild(chip("cannot undo"));
      if (chips.childNodes.length) what.appendChild(chips);
      if (s.note) what.appendChild(el("div", { class: "sub", text: s.note }));
      if (s.error) what.appendChild(el("div", { class: "err", text: s.error }));
      var d = diffText(s.diff);
      if (d) what.appendChild(el("details", null, [el("summary", { text: "What changed" }), el("pre", { text: d })]));
      if (s.screenshot) what.appendChild(el("img", { class: "shot", src: s.screenshot, alt: "Page at the point of failure" }));
      ol.appendChild(el("li", { class: cls }, [el("div", { class: "ico", text: ico }), what, el("div", { class: "dur", text: secs(s.durationMs) })]));
    });
    return ol;
  }

  function actionButton(label, fn) {
    var b = el("button", { type: "button", text: label });
    b.addEventListener("click", function () {
      b.disabled = true;
      var old = b.textContent;
      b.textContent = "Working…";
      Promise.resolve().then(fn).catch(function (e) { out.textContent = "Error: " + (e && e.message || e); out.style.display = ""; })
        .then(function () { b.disabled = false; b.textContent = old; });
    });
    return b;
  }
  var out = el("pre", { style: "display:none" });

  function describeResult(r) {
    if (typeof r === "string") return r;
    if (r && Array.isArray(r.results)) {
      var lines = [];
      lines.push(r.dryRun ? "Undo preview (nothing was changed):" : "Undo finished: " + r.undone + " change(s) reversed.");
      r.results.forEach(function (x) {
        lines.push("  " + (x.status === "undone" ? "✓" : x.status === "failed" ? "✗" : "•") + " step " + x.step + " — " + x.type + ": " + String(x.status).replace(/_/g, " ") + (x.detail ? " (" + x.detail + ")" : "") + (x.reason ? " — " + x.reason : ""));
      });
      if (!r.results.length) lines.push("  Nothing to undo.");
      if (r.irreversible && r.irreversible.length) {
        lines.push("Cannot be undone:");
        r.irreversible.forEach(function (x) { lines.push("  • step " + x.step + " — " + x.what + (x.why ? " (" + x.why + ")" : "")); });
      }
      return lines.join("\n");
    }
    if (r && r.steps && r.status) {
      var l2 = ["Dry check: " + String(r.status).replace(/_/g, " ") + (r.error ? " — " + r.error : "")];
      r.steps.forEach(function (x) { if (!x.ok || x.unchecked) l2.push("  " + (x.unchecked ? "·" : "✗") + " " + (x.index + 1) + ". " + x.action + " " + x.target + (x.wouldHealTo ? " → would heal to " + x.wouldHealTo : "") + (x.unchecked ? " (not checked)" : "")); });
      return l2.join("\n");
    }
    return JSON.stringify(r, null, 2);
  }

  function showResult(r) {
    out.textContent = describeResult(r);
    out.style.display = "";
    size();
  }

  function renderRun(r) {
    var root = el("div");
    root.appendChild(el("h1", { text: r.workflowName || "Workflow run" }));
    root.appendChild(el("div", { class: "sub" }, [badge(r.status), (r.mode || "") + " · " + (r.trigger || "") + (r.durationMs != null ? " · " + secs(r.durationMs) : "")]));
    var chips = el("div", { class: "chips" });
    if (r.healed) chips.appendChild(chip(r.healed + " step(s) self-healed", "heal"));
    if (r.summary) chips.appendChild(chip(r.summary.found + "/" + r.summary.checked + " targets found"));
    if (r.summary && r.summary.unchecked) chips.appendChild(chip(r.summary.unchecked + " not checked"));
    if (chips.childNodes.length) root.appendChild(chips);
    if (r.error) root.appendChild(el("div", { class: "err", text: r.error }));
    root.appendChild(renderSteps(r.steps));
    var bar = el("div", { class: "bar" });
    if (inHost && r.mode !== "dry" && (r.steps || []).some(function (s) { return s.undoable; })) {
      bar.appendChild(actionButton("Preview undo", function () {
        return callTool("run_undo", { runId: r.runId, dryRun: true }).then(showResult);
      }));
    }
    if (inHost && r.workflowId && r.mode !== "dry") {
      bar.appendChild(actionButton("Dry check now", function () {
        return callTool("workflow_run", { id: r.workflowId, mode: "dry", variables: {} }).then(showResult);
      }));
    }
    if (bar.childNodes.length) { root.appendChild(bar); root.appendChild(out); }
    if (r.note) root.appendChild(el("div", { class: "note", text: r.note }));
    return root;
  }

  function renderBatch(b) {
    var root = el("div");
    root.appendChild(el("h1", { text: "Batch of " + b.total + " run(s)" }));
    root.appendChild(el("div", { class: "sub" }, [badge(b.status), b.passed + " passed · " + b.failed + " failed · " + b.running + " running · " + b.concurrency + " at a time"]));
    var tbody = el("tbody");
    (b.runs || []).forEach(function (r) {
      tbody.appendChild(el("tr", null, [
        el("td", { text: String((r.index || 0) + 1) }), el("td", { text: r.workflow || "" }),
        el("td", null, [badge(r.status)]), el("td", { text: secs(r.durationMs) }),
        el("td", { text: (r.healed ? "healed " + r.healed + (r.error ? " · " : "") : "") + (r.error || "") })
      ]));
    });
    root.appendChild(el("table", null, [el("thead", null, [el("tr", null, ["#", "Workflow", "Status", "Time", "Notes"].map(function (h) { return el("th", { text: h }); }))]), tbody]));
    return root;
  }

  function renderWorkflow(w) {
    var root = el("div");
    root.appendChild(el("h1", { text: w.name || "Workflow" }));
    root.appendChild(el("div", { class: "sub", text: (w.description ? w.description + " · " : "") + (w.steps || []).length + " steps" + (w.startUrl ? " · starts at " + w.startUrl : "") }));
    var vars = w.variables || [];
    if (vars.length) {
      var tb = el("tbody");
      vars.forEach(function (v) { tb.appendChild(el("tr", null, [el("td", { text: v.name }), el("td", { text: v.secret ? "secret — supplied at run time" : String(v.default == null ? "" : v.default) }), el("td", { text: v.description || "" })])); });
      root.appendChild(el("table", { style: "margin-bottom:12px" }, [el("thead", null, [el("tr", null, ["Variable", "Default", "Used for"].map(function (h) { return el("th", { text: h }); }))]), tb]));
    }
    var ol = el("ol", { class: "steps" });
    (w.steps || []).forEach(function (s, i) {
      var loc = s.locator || {};
      var target = s.action === "navigate" ? s.url : (loc.role ? loc.role + " " : "") + (loc.accessibleName || loc.label || loc.placeholder || loc.text || loc.testid || loc.css || "");
      var what = el("div", { class: "what" }, [el("b", { text: (i + 1) + ". " + s.action }), " ", el("span", { class: "t", text: target || "" })]);
      if (s.value != null && s.value !== "") what.appendChild(el("div", { class: "sub", text: "value: " + (s.secret ? "<secret>" : s.value) }));
      if (loc.healedAt) what.appendChild(chip("healed " + new Date(loc.healedAt).toLocaleDateString(), "heal"));
      ol.appendChild(el("li", { class: "ok" }, [el("div", { class: "ico", text: String(i + 1) }), what, el("div")]));
    });
    root.appendChild(ol);
    return root;
  }

  function size() {
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }

  function render(result) {
    var data = result && result.structuredContent;
    if (!data) {
      var t = result && result.content && result.content[0] && result.content[0].text;
      try { data = JSON.parse(t); } catch (e) {}
    }
    app.textContent = "";
    if (!data || !data.kind) { app.appendChild(el("div", { class: "empty", text: "Nothing to show yet." })); return size(); }
    var node = data.kind === "run" ? renderRun(data.report) : data.kind === "batch" ? renderBatch(data.batch) : data.kind === "workflow" ? renderWorkflow(data.workflow) : el("div", { class: "empty", text: "Unknown view: " + data.kind });
    app.appendChild(node);
    size();
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === "light" || ctx.theme === "dark") {
      document.documentElement.setAttribute("data-theme", ctx.theme);
      document.documentElement.style.colorScheme = ctx.theme;
    }
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && m.method == null) {
      var p = pending[m.id];
      if (p) { delete pending[m.id]; m.error ? p.reject(new Error(m.error.message || "request failed")) : p.resolve(m.result); }
      return;
    }
    if (m.method === "ui/notifications/tool-result") render(m.params);
    else if (m.method === "ui/notifications/host-context-changed") applyContext(m.params);
    else if (m.method === "ping" && m.id != null) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });

  if (window.ResizeObserver && document.body) new ResizeObserver(size).observe(document.body);

  if (!inHost) {
    app.textContent = "";
    app.appendChild(el("div", { class: "empty", text: "This view is shown inside an MCP host that supports MCP Apps." }));
    return;
  }
  rpc("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "AutoDOM viewer", version: "1" },
    clientInfo: { name: "AutoDOM viewer", version: "1" },
    appCapabilities: {},
    capabilities: { appCapabilities: {} }
  }).then(function (res) {
    applyContext(res && res.hostContext);
    notify("ui/notifications/initialized", {});
  }).catch(function () { notify("ui/notifications/initialized", {}); });
})();
</script>
</body>
</html>
`;
