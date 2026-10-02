/**
 * AutoDOM — Workflow engine ("teach a task")
 *
 * Record once, replay many times without an LLM, and self-heal when the
 * page changes. One recorder captures user and agent actions into a
 * workflow: an ordered list of steps whose targets are stored as a
 * *locator bundle* (testid, id, role + accessible name, label, placeholder,
 * text, css, xpath, bbox, shadow host path). Replay walks the bundle from
 * the most to the least stable strategy; if every strategy misses, a
 * heuristic matcher (and, when configured, the user's LLM) picks the
 * closest element and the healed locator is written back to the workflow,
 * so the next run is deterministic again.
 *
 * Exposed via globalThis.AutoDOMWorkflow = {
 *   makeEngine(ctx)  → { handlers, onRuntimeMessage, onNavigationCommitted,
 *                        onNavigationCompleted, noteAgentTool, hydrate,
 *                        runWorkflow, listWorkflows, ... }
 *   catalog, tiers   agent-surface catalog + action-gate tiers
 *   pure helpers     extractVariables, substitute, toPlaywright, toMarkdown,
 *                    parseRoutine, validateWorkflow, scoreCandidate, ...
 *   _page            page-side functions (exported for unit tests)
 * }
 *
 * Page-side code runs in the extension's ISOLATED world so recorder events
 * can reach the service worker with chrome.runtime.sendMessage and so
 * nothing leaks into the page's own globals. The ISOLATED world shares the
 * DOM with the page, so element lookups and dispatched events behave the
 * same as the MAIN-world tools.
 */
(function () {
  // ─── Page-side library ───────────────────────────────────────────────
  // Serialized into the tab. Must be self-contained. Installs
  // globalThis.__autodomWfLib once per document (idempotent).
  function _pageWfLib() {
    // Keep in sync with WF_LIB_VERSION checks in the entry points below.
    const VERSION = 5;
    if (globalThis.__autodomWfLib && globalThis.__autodomWfLib.v === VERSION) {
      return { ok: true, cached: true };
    }
    const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const TESTID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
    const SENSITIVE_RE = /pass|pwd|secret|token|otp|one.?time|\bpin\b|cvv|cvc|ssn|card.?num|cc-?num|security.?code/i;
    const INTERACTIVE_SEL = [
      "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
      "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]",
      "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
      "[role=option]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
      "[role=slider]", "[role=spinbutton]", "[contenteditable=''],[contenteditable=true]",
      "[tabindex]:not([tabindex='-1'])", "[onclick]",
    ].join(",");
    const ROLE_SEL = {
      button: "button,input[type=button],input[type=submit],input[type=reset],input[type=image],summary,[role=button]",
      link: "a[href],[role=link]",
      textbox: "input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],textarea,[role=textbox],[contenteditable=''],[contenteditable=true]",
      searchbox: "input[type=search],[role=searchbox]",
      checkbox: "input[type=checkbox],[role=checkbox]",
      radio: "input[type=radio],[role=radio]",
      combobox: "select,input[list],[role=combobox]",
      listbox: "select[multiple],select[size],[role=listbox]",
      spinbutton: "input[type=number],[role=spinbutton]",
      slider: "input[type=range],[role=slider]",
      option: "option,[role=option]",
      heading: "h1,h2,h3,h4,h5,h6,[role=heading]",
      img: "img,[role=img]",
    };

    const UI_SEL = '[id^="__autodom"],[id^="__bmcp"],[data-autodom-ui]';
    const looksDynamic = (s) =>
      /\d{3,}|[0-9a-f]{8,}|^:r[0-9a-z]*:?$|^(ember|ext-gen|mui-|radix-|headlessui-|react-select-)/i.test(
        String(s || ""),
      );
    const cssEsc = (s) =>
      globalThis.CSS && CSS.escape
        ? CSS.escape(String(s))
        : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
    const attrEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    const implicitRole = (el) => {
      const explicit = el.getAttribute && el.getAttribute("role");
      if (explicit) return explicit.split(/\s+/)[0];
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute("type") || "").toLowerCase();
      switch (tag) {
        case "button": case "summary": return "button";
        case "a": return el.hasAttribute("href") ? "link" : null;
        case "select": return el.multiple || el.size > 1 ? "listbox" : "combobox";
        case "textarea": return "textbox";
        case "option": return "option";
        case "img": return "img";
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
        case "input":
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "search") return "searchbox";
          if (type === "number") return "spinbutton";
          if (["", "text", "email", "tel", "url"].includes(type)) {
            return el.hasAttribute("list") ? "combobox" : "textbox";
          }
          return null;
        default:
          return el.isContentEditable ? "textbox" : null;
      }
    };

    const isField = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || tag === "select") return true;
      if (tag !== "input") return false;
      const type = String(el.type || "").toLowerCase();
      return !["button", "submit", "reset", "image", "hidden"].includes(type);
    };
    const isTextField = (el) => {
      if (el.isContentEditable) return true;
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea") return true;
      if (tag !== "input") return false;
      const type = String(el.type || "").toLowerCase();
      return !["button", "submit", "reset", "image", "hidden", "checkbox", "radio", "range", "color", "file"].includes(type);
    };

    const labelText = (el) => {
      try {
        if (el.labels && el.labels.length) {
          return norm(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(" "));
        }
      } catch (_) {}
      const lab = el.closest && el.closest("label");
      return lab ? norm(lab.innerText || lab.textContent) : "";
    };

    const accName = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria && norm(aria)) return norm(aria);
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const root = el.getRootNode();
        const t = lb
          .split(/\s+/)
          .map((id) => {
            const n = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
            return n ? n.innerText || n.textContent : "";
          })
          .join(" ");
        if (norm(t)) return norm(t);
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") {
        const type = String(el.type || "").toLowerCase();
        if (["button", "submit", "reset"].includes(type) && el.value) return norm(el.value);
        if (type === "image" && el.alt) return norm(el.alt);
        const l = labelText(el);
        if (l) return l;
        if (el.placeholder) return norm(el.placeholder);
        if (el.title) return norm(el.title);
        return "";
      }
      if (tag === "img") return norm(el.alt || el.title);
      const t = norm(el.innerText || el.textContent);
      if (t) return t.slice(0, 120);
      if (el.title) return norm(el.title);
      const img = el.querySelector && el.querySelector("img[alt]");
      return img ? norm(img.alt) : "";
    };

    // CSS path relative to the element's own root (document or shadow root).
    const cssPath = (el) => {
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 10) {
        if (cur.id && !looksDynamic(cur.id)) {
          parts.unshift("#" + cssEsc(cur.id));
          break;
        }
        let part = cur.nodeName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((n) => n.nodeName === cur.nodeName);
          if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
        }
        parts.unshift(part);
        cur = parent;
      }
      return parts.join(" > ");
    };

    const xpathOf = (el) => {
      if (el.getRootNode() !== document) return null;
      const segs = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
        const tag = cur.nodeName.toLowerCase();
        let i = 1;
        let sib = cur.previousElementSibling;
        while (sib) {
          if (sib.nodeName === cur.nodeName) i++;
          sib = sib.previousElementSibling;
        }
        segs.unshift(tag + "[" + i + "]");
        cur = cur.parentElement;
      }
      return "/html/" + segs.join("/");
    };

    const shadowHosts = (el) => {
      const hosts = [];
      let root = el.getRootNode();
      while (root && root.host) {
        hosts.unshift(cssPath(root.host));
        root = root.host.getRootNode();
      }
      return hosts;
    };

    const isSensitive = (el) => {
      if (String(el.type || "").toLowerCase() === "password") return true;
      const hay = [el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.placeholder]
        .filter(Boolean)
        .join(" ");
      return SENSITIVE_RE.test(hay);
    };

    const describe = (el, opts) => {
      const light = opts && opts.light;
      const tag = el.tagName.toLowerCase();
      const loc = { tag };
      for (const a of TESTID_ATTRS) {
        const v = el.getAttribute(a);
        if (v) { loc.testid = v; loc.testidAttr = a; break; }
      }
      if (el.id && !looksDynamic(el.id)) loc.id = el.id;
      const nameAttr = el.getAttribute("name");
      if (nameAttr && !looksDynamic(nameAttr)) loc.name = nameAttr;
      const role = implicitRole(el);
      if (role) loc.role = role;
      const an = accName(el);
      if (an) loc.accessibleName = an.slice(0, 120);
      if (isField(el)) {
        const l = labelText(el);
        if (l) loc.label = l.slice(0, 120);
        if (el.placeholder) loc.placeholder = el.placeholder;
        if (el.type) loc.inputType = String(el.type).toLowerCase();
      } else {
        const t = norm(el.innerText || el.textContent);
        if (t && t.length <= 80) loc.text = t;
      }
      loc.css = cssPath(el);
      if (!light) {
        const xp = xpathOf(el);
        if (xp) loc.xpath = xp;
      }
      const hosts = shadowHosts(el);
      if (hosts.length) loc.shadowHosts = hosts;
      const r = el.getBoundingClientRect();
      loc.bbox = {
        x: Math.round(r.x + (globalThis.scrollX || 0)),
        y: Math.round(r.y + (globalThis.scrollY || 0)),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      return loc;
    };

    const visible = (el) => {
      try {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
      } catch (_) {
        return false;
      }
    };

    const rootFor = (loc) => {
      let root = document;
      for (const h of loc.shadowHosts || []) {
        let host = null;
        try { host = root.querySelector(h); } catch (_) {}
        if (!host || !host.shadowRoot) return null;
        root = host.shadowRoot;
      }
      return root;
    };
    const all = (root, sel) => {
      try { return Array.from(root.querySelectorAll(sel)); } catch (_) { return []; }
    };
    const center = (b) => (b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null);
    const distTo = (el, bbox) => {
      const c = center(bbox);
      if (!c) return 0;
      const r = el.getBoundingClientRect();
      const x = r.x + (globalThis.scrollX || 0) + r.width / 2;
      const y = r.y + (globalThis.scrollY || 0) + r.height / 2;
      return Math.hypot(x - c.x, y - c.y);
    };

    // Strategy chain, most stable first. Each returns candidate elements.
    const STRATEGIES = [
      ["testid", (root, l) => (l.testid ? all(root, "[" + (l.testidAttr || "data-testid") + '="' + attrEsc(l.testid) + '"]') : [])],
      ["id", (root, l) => (l.id ? all(root, "#" + cssEsc(l.id)) : [])],
      ["name", (root, l) => (l.name ? all(root, (l.tag || "") + '[name="' + attrEsc(l.name) + '"]') : [])],
      ["role", (root, l) => {
        if (!l.role || !l.accessibleName) return [];
        const want = norm(l.accessibleName);
        const pool = all(root, ROLE_SEL[l.role] || "[role=" + l.role + "]");
        const exact = pool.filter((e) => accName(e) === want);
        if (exact.length) return exact;
        const lw = want.toLowerCase();
        return pool.filter((e) => accName(e).toLowerCase() === lw);
      }],
      ["label", (root, l) => {
        if (!l.label) return [];
        const want = norm(l.label);
        return all(root, "input,select,textarea").filter((e) => labelText(e) === want);
      }],
      ["placeholder", (root, l) => (l.placeholder ? all(root, '[placeholder="' + attrEsc(l.placeholder) + '"]') : [])],
      ["text", (root, l) => {
        if (!l.text) return [];
        const want = norm(l.text);
        return all(root, l.tag || "*").filter((e) => norm(e.innerText || e.textContent) === want);
      }],
      ["css", (root, l) => {
        if (!l.css) return [];
        const found = all(root, l.css);
        return l.tag ? found.filter((e) => e.tagName.toLowerCase() === l.tag) : found;
      }],
      ["xpath", (root, l) => {
        if (!l.xpath || root !== document) return [];
        try {
          const n = document.evaluate(l.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          return n && (!l.tag || n.tagName.toLowerCase() === l.tag) ? [n] : [];
        } catch (_) { return []; }
      }],
    ];

    const resolve = (loc) => {
      if (!loc) return null;
      const root = rootFor(loc);
      if (!root) return null;
      let fallback = null;
      for (const [strategy, fn] of STRATEGIES) {
        let found = fn(root, loc);
        if (!found.length) continue;
        if (found.length > 1 && loc.tag) {
          const sameTag = found.filter((e) => e.tagName.toLowerCase() === loc.tag);
          if (sameTag.length) found = sameTag;
        }
        if (found.length > 1) {
          const vis = found.filter(visible);
          if (vis.length) found = vis;
        }
        if (found.length === 1) return { el: found[0], strategy, count: 1 };
        if (!fallback) {
          const best = found.slice().sort((a, b) => distTo(a, loc.bbox) - distTo(b, loc.bbox))[0];
          fallback = { el: best, strategy, count: found.length, ambiguous: true };
        }
      }
      return fallback;
    };

    // Interactive elements across the document and open shadow roots.
    const collectInteractive = (limit) => {
      const out = [];
      const visit = (root, depth) => {
        if (depth > 6 || out.length >= limit) return;
        for (const el of all(root, INTERACTIVE_SEL)) {
          if (out.length >= limit) return;
          if (el.closest && el.closest(UI_SEL)) continue;
          if (!visible(el) && !isField(el)) continue;
          out.push(el);
        }
        for (const host of all(root, "*")) {
          if (host.shadowRoot) visit(host.shadowRoot, depth + 1);
        }
      };
      visit(document, 0);
      return out;
    };

    let refSeq = 0;
    const refMap = new Map();
    const refOf = (el) => {
      let ref = el.getAttribute("data-autodom-ref");
      if (!ref || refMap.get(ref) !== el) {
        ref = "e" + ++refSeq;
        try { el.setAttribute("data-autodom-ref", ref); } catch (_) {}
        refMap.set(ref, el);
      }
      return ref;
    };
    const byRef = (ref) => {
      const key = String(ref || "").replace(/^@/, "");
      const el = refMap.get(key);
      return el && el.isConnected ? el : null;
    };

    const candidates = (limit) =>
      collectInteractive(limit || 300).map((el) => ({ ref: refOf(el), ...describe(el, { light: true }), visible: visible(el) }));

    const setNativeValue = (el, value) => {
      const proto =
        el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : el.tagName === "SELECT"
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    };
    const fire = (el, type, init) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true, ...(init || {}) }));
    const mouse = (el, type) => {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      const Ctor = type.startsWith("pointer") && globalThis.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    };

    const act = (el, step) => {
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) {}
      const action = step.action;
      if (action === "click" || action === "dblclick") {
        for (const t of ["pointerover", "mouseover", "pointerdown", "mousedown"]) mouse(el, t);
        try { el.focus({ preventScroll: true }); } catch (_) {}
        for (const t of ["pointerup", "mouseup"]) mouse(el, t);
        el.click();
        if (action === "dblclick") mouse(el, "dblclick");
        return { ok: true };
      }
      if (action === "hover") {
        for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]) mouse(el, t);
        return { ok: true };
      }
      if (action === "fill") {
        const value = String(step.value == null ? "" : step.value);
        try { el.focus({ preventScroll: true }); } catch (_) {}
        if (el.isContentEditable && !isField(el)) {
          el.textContent = step.append ? (el.textContent || "") + value : value;
          fire(el, "input");
          return { ok: true };
        }
        if (!("value" in el)) return { ok: false, error: "target is not fillable" };
        setNativeValue(el, step.append ? String(el.value || "") + value : value);
        fire(el, "input");
        fire(el, "change");
        return { ok: true };
      }
      if (action === "select") {
        if (el.tagName !== "SELECT") {
          el.click();
          return { ok: true, note: "custom select clicked" };
        }
        const opts = Array.from(el.options);
        const want = step.value == null ? "" : String(step.value);
        const wantText = norm(step.optionText || "");
        const opt =
          (want !== "" && opts.find((o) => o.value === want)) ||
          (wantText && opts.find((o) => norm(o.text) === wantText)) ||
          (want !== "" && opts.find((o) => norm(o.text) === norm(want))) ||
          (want === "" && !wantText && opts.find((o) => o.value === ""));
        if (!opt) return { ok: false, error: "option not found: " + (step.optionText || want) };
        setNativeValue(el, opt.value);
        fire(el, "input");
        fire(el, "change");
        return { ok: true };
      }
      if (action === "check") {
        const want = step.value !== false && step.value !== "false";
        const cur = "checked" in el ? !!el.checked : el.getAttribute("aria-checked") === "true";
        if (cur !== want) el.click();
        return { ok: true };
      }
      if (action === "press") {
        const key = step.key || "Enter";
        const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
        try { el.focus({ preventScroll: true }); } catch (_) {}
        const down = new KeyboardEvent("keydown", init);
        const notCancelled = el.dispatchEvent(down);
        el.dispatchEvent(new KeyboardEvent("keypress", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
        // Synthetic Enter does not submit forms natively.
        if (key === "Enter" && notCancelled && el.form && el.tagName === "INPUT") {
          try { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } catch (_) {}
        }
        return { ok: true };
      }
      return { ok: false, error: "unsupported action: " + action };
    };

    const checkAssert = (a) => {
      if (!a) return { ok: true };
      const val = String(a.value == null ? "" : a.value);
      if (a.type === "url") return { ok: location.href.includes(val) };
      if (a.type === "text") return { ok: norm(document.body && document.body.innerText).includes(norm(val)) };
      if (a.type === "title") return { ok: document.title.includes(val) };
      if (a.type === "visible") {
        const hit = resolve(a.locator);
        return { ok: !!(hit && visible(hit.el)) };
      }
      if (a.type === "hidden") {
        const hit = resolve(a.locator);
        return { ok: !(hit && visible(hit.el)) };
      }
      return { ok: false, error: "unknown assert type: " + a.type };
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // What the field held before a step changed it, so a run can be undone.
    // Sensitive fields only record whether they were empty (never the value).
    const prevOf = (el, step) => {
      try {
        if (step.action === "fill") {
          const cur = el.isContentEditable && !isField(el) ? el.textContent || "" : String(el.value == null ? "" : el.value);
          if (isSensitive(el)) return cur === "" ? { kind: "value", value: "" } : { kind: "none", reason: "sensitive field had a value" };
          return { kind: "value", value: cur.slice(0, 2000) };
        }
        if (step.action === "select") return { kind: "value", value: String(el.value == null ? "" : el.value) };
        if (step.action === "check") {
          return { kind: "check", value: "checked" in el ? !!el.checked : el.getAttribute("aria-checked") === "true" };
        }
      } catch (_) {}
      return null;
    };

    // Resolve without acting (dry run). Reports what a run would do.
    const resolveOnly = (step) => {
      if (step.action === "assert") {
        const res = checkAssert(step.assert);
        return { ok: true, found: !!res.ok, note: res.ok ? "assertion holds now" : "assertion does not hold on the current page" };
      }
      if (!step.locator) return { ok: true, found: true, note: "no target" };
      const hit = resolve(step.locator);
      if (!hit) return { ok: true, found: false };
      return {
        ok: true,
        found: true,
        strategy: hit.strategy,
        ambiguous: !!hit.ambiguous,
        matches: hit.count,
        visible: visible(hit.el),
        target: describe(hit.el, { light: true }),
      };
    };

    // Vision fallback: number the on-screen interactive elements so a vision
    // model can name one. Boxes are removed again with clearMarks().
    const MARK_ID = "__autodom_wf_marks";
    const clearMarks = () => {
      const old = document.getElementById(MARK_ID);
      if (old) old.remove();
      return { ok: true };
    };
    const markCandidates = (limit, nearBbox) => {
      clearMarks();
      if (nearBbox && Number.isFinite(nearBbox.y)) {
        const top = Math.max(0, nearBbox.y - innerHeight / 2);
        if (Math.abs(top - (globalThis.scrollY || 0)) > innerHeight / 3) globalThis.scrollTo(0, top);
      }
      const layer = document.createElement("div");
      layer.id = MARK_ID;
      layer.setAttribute("data-autodom-ui", "");
      layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      const marks = [];
      for (const el of collectInteractive(limit || 120)) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
        const n = marks.length + 1;
        const box = document.createElement("div");
        box.style.cssText = "position:fixed;border:2px solid #e11d48;box-sizing:border-box;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;";
        const tag = document.createElement("span");
        tag.textContent = String(n);
        tag.style.cssText = "position:absolute;left:-2px;top:-14px;background:#e11d48;color:#fff;font:700 11px/12px system-ui,sans-serif;padding:0 3px;border-radius:2px;";
        box.appendChild(tag);
        layer.appendChild(box);
        marks.push({ n, ref: refOf(el), ...describe(el, { light: true }) });
        if (marks.length >= 60) break;
      }
      document.documentElement.appendChild(layer);
      return { ok: true, marks, viewport: { w: innerWidth, h: innerHeight } };
    };

    // Remove storage keys a step added (undo). Only for the recorded origin.
    const removeStorage = (origin, local, session) => {
      if (origin && location.origin !== origin) return { ok: false, error: "page origin changed (" + location.origin + ")" };
      let removed = 0;
      for (const k of local || []) { try { localStorage.removeItem(k); removed++; } catch (_) {} }
      for (const k of session || []) { try { sessionStorage.removeItem(k); removed++; } catch (_) {} }
      return { ok: true, removed };
    };

    // Resolve the step's target (polling until timeout) and act on it.
    const runStep = async (step, timeoutMs) => {
      const deadline = Date.now() + Math.max(200, timeoutMs || 5000);
      if (step.action === "assert") {
        let res;
        do {
          res = checkAssert(step.assert);
          if (res.ok || res.error) break;
          await sleep(150);
        } while (Date.now() < deadline);
        return res.ok ? { ok: true } : { ok: false, error: res.error || "assertion failed: " + JSON.stringify(step.assert) };
      }
      if (step.action === "scroll") {
        globalThis.scrollTo(step.x || 0, step.y || 0);
        return { ok: true };
      }
      let hit = null;
      do {
        if (step.ref) {
          const el = byRef(step.ref);
          hit = el ? { el, strategy: "ref", count: 1 } : null;
        } else {
          hit = resolve(step.locator);
        }
        if (hit && (visible(hit.el) || isField(hit.el))) break;
        await sleep(150);
      } while (Date.now() < deadline);
      if (!hit) return { ok: false, notFound: true, error: "element not found" };
      const prev = prevOf(hit.el, step);
      const res = act(hit.el, step);
      return {
        ...res,
        strategy: hit.strategy,
        ambiguous: !!hit.ambiguous,
        matches: hit.count,
        after: describe(hit.el),
        ...(prev ? { prev } : {}),
      };
    };

    const actOnRef = (ref, step) => {
      const el = byRef(ref);
      if (!el) return { ok: false, error: "stale or unknown ref: " + ref };
      const prev = prevOf(el, step);
      const res = act(el, step);
      return { ...res, strategy: "ref", after: describe(el), ...(prev ? { prev } : {}) };
    };

    // Cheap page digest for before/after step diffs.
    const digest = () => {
      let h = 0;
      const text = (document.body && document.body.innerText) || "";
      for (let i = 0; i < text.length; i += 7) h = (h * 31 + text.charCodeAt(i)) | 0;
      let storageKeys = [];
      try { storageKeys = Object.keys(localStorage).slice(0, 200); } catch (_) {}
      let sessionKeys = [];
      try { sessionKeys = Object.keys(sessionStorage).slice(0, 200); } catch (_) {}
      const cookieNames = document.cookie
        ? document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).slice(0, 200)
        : [];
      return {
        url: location.href,
        title: document.title,
        textHash: h,
        textLength: text.length,
        elementCount: document.getElementsByTagName("*").length,
        storageKeys,
        sessionKeys,
        cookieNames,
      };
    };

    // ── Recorder ──
    // Small non-interactive "● Recording workflow" chip (Features →
    // overlayRecordingIndicator). Closed shadow root so page CSS cannot
    // touch it, data-autodom-ui so the recorder and candidate scans skip
    // it, pointer-events:none so it never eats a click being recorded.
    const CHIP_ID = "__autodom_wf_rec_chip";
    const removeChip = () => {
      const old = document.getElementById(CHIP_ID);
      if (old) old.remove();
    };
    const showChip = () => {
      if (document.getElementById(CHIP_ID)) return;
      const host = document.createElement("div");
      host.id = CHIP_ID;
      host.setAttribute("data-autodom-ui", "");
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;pointer-events:none;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent =
        ".chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;" +
        "background:rgba(17,24,39,.88);color:#fff;font:600 12px/16px system-ui,-apple-system,sans-serif;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;user-select:none}" +
        ".dot{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:p 1.4s ease-in-out infinite}" +
        "@keyframes p{50%{opacity:.35}}" +
        "@media (prefers-reduced-motion:reduce){.dot{animation:none}}";
      const chip = document.createElement("div");
      chip.className = "chip";
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = "Recording workflow";
      chip.append(dot, label);
      root.append(style, chip);
      document.documentElement.appendChild(host);
    };
    let rec = null;
    const startRecording = (nonce, opts) => {
      const indicator = !opts || opts.indicator !== false;
      if (rec && rec.nonce === nonce) {
        if (indicator) showChip();
        else removeChip();
        return { ok: true, alreadyRunning: true };
      }
      if (rec) stopRecording();
      const lastFilled = new WeakMap();
      const send = (step) => {
        try {
          chrome.runtime.sendMessage({
            type: "AUTODOM_WF_STEP",
            nonce,
            step: { ...step, url: location.href, t: Date.now() },
          });
        } catch (_) {}
      };
      const deepTarget = (ev) => {
        const path = ev.composedPath ? ev.composedPath() : [];
        return path.find((n) => n && n.nodeType === 1) || ev.target;
      };
      const CLICKABLE =
        "button,a[href],[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=switch],[role=checkbox],[role=radio],input,select,textarea,label,summary,[data-testid],[onclick]";
      const fillStep = (el) => {
        const value = el.isContentEditable && !isField(el) ? norm(el.innerText) : String(el.value || "");
        if (lastFilled.get(el) === value) return null;
        lastFilled.set(el, value);
        const secret = isSensitive(el);
        return { action: "fill", locator: describe(el), ...(secret ? { secret: true, value: "" } : { value: value.slice(0, 4000) }) };
      };
      let lastClick = { el: null, at: 0 };
      const onClick = (ev) => {
        const raw = deepTarget(ev);
        if (!raw || !raw.closest) return;
        if (raw.closest(UI_SEL)) return;
        // Second click of a double-click is recorded by onDblClick.
        if (ev.detail === 2) return;
        const t = raw.closest(CLICKABLE) || raw;
        const tag = t.tagName.toLowerCase();
        // Fields are recorded from change/keydown; labels just forward focus/clicks.
        if (tag === "label" || tag === "option" || (isField(t) && tag !== "select" && !["checkbox", "radio"].includes(String(t.type).toLowerCase()))) return;
        if (tag === "select") return;
        if (tag === "input" && ["checkbox", "radio"].includes(String(t.type).toLowerCase())) return;
        // Tools often fire a synthetic click and then el.click(): keep one.
        const now = Date.now();
        if (lastClick.el === t && now - lastClick.at < 400) return;
        lastClick = { el: t, at: now };
        send({ action: "click", locator: describe(t) });
      };
      const onDblClick = (ev) => {
        const raw = deepTarget(ev);
        if (!raw || !raw.closest || raw.closest(UI_SEL)) return;
        const t = raw.closest(CLICKABLE) || raw;
        send({ action: "dblclick", locator: describe(t), replacesPrevious: true });
      };
      const onChange = (ev) => {
        const t = deepTarget(ev);
        if (!t || !t.tagName || (t.closest && t.closest(UI_SEL))) return;
        const tag = t.tagName.toLowerCase();
        const type = String(t.type || "").toLowerCase();
        if (tag === "select") {
          const opt = t.options[t.selectedIndex];
          send({ action: "select", locator: describe(t), value: t.value, optionText: opt ? norm(opt.text) : "" });
        } else if (type === "checkbox" || type === "radio") {
          send({ action: "check", locator: describe(t), value: !!t.checked });
        } else if (type === "file") {
          send({ action: "upload", locator: describe(t), note: "file uploads are not replayed; use upload_file" });
        } else if (isTextField(t)) {
          const s = fillStep(t);
          if (s) send(s);
        }
      };
      const onKey = (ev) => {
        if (ev.key !== "Enter" && ev.key !== "Escape") return;
        const t = deepTarget(ev);
        if (!t || !t.tagName || (t.closest && t.closest(UI_SEL))) return;
        if (ev.key === "Enter" && !isTextField(t)) return;
        if (isTextField(t)) {
          const s = fillStep(t);
          if (s) send(s);
        }
        send({ action: "press", key: ev.key, locator: describe(t) });
      };
      const onFocusOut = (ev) => {
        const t = deepTarget(ev);
        if (t && t.isContentEditable && !isField(t)) {
          const s = fillStep(t);
          if (s) send(s);
        }
      };
      document.addEventListener("click", onClick, true);
      document.addEventListener("dblclick", onDblClick, true);
      document.addEventListener("change", onChange, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("focusout", onFocusOut, true);
      rec = {
        nonce,
        stop() {
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("dblclick", onDblClick, true);
          document.removeEventListener("change", onChange, true);
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("focusout", onFocusOut, true);
        },
      };
      if (indicator) {
        try { showChip(); } catch (_) {}
      }
      return { ok: true, started: true };
    };
    const stopRecording = () => {
      try { removeChip(); } catch (_) {}
      if (!rec) return { ok: true, wasRecording: false };
      try { rec.stop(); } catch (_) {}
      rec = null;
      return { ok: true, wasRecording: true };
    };

    globalThis.__autodomWfLib = {
      v: VERSION,
      norm,
      describe,
      resolve,
      accName,
      implicitRole,
      candidates,
      byRef,
      act,
      actOnRef,
      runStep,
      resolveOnly,
      markCandidates,
      clearMarks,
      removeStorage,
      digest,
      startRecording,
      stopRecording,
      isRecording: () => !!rec,
    };
    return { ok: true };
  }

  // Thin entry points. They answer { needLib: true } when the library is
  // missing (new document) or from another build, and the engine injects
  // _pageWfLib and retries once — so the library is injected once per
  // document instead of before every step. The literal 5 must match
  // VERSION in _pageWfLib (each function is serialized on its own).
  function _pageWfStartRecording(nonce, opts) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.startRecording(nonce, opts) : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfStopRecording() {
    const L = globalThis.__autodomWfLib;
    return L ? L.stopRecording() : { ok: true, wasRecording: false };
  }
  function _pageWfRunStep(step, timeoutMs) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.runStep(step, timeoutMs) : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfActOnRef(ref, step) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.actOnRef(ref, step) : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfCandidates(limit) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? { ok: true, candidates: L.candidates(limit) } : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfResolveOnly(step) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.resolveOnly(step) : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfMark(limit, nearBbox) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.markCandidates(limit, nearBbox) : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfClearMarks() {
    const L = globalThis.__autodomWfLib;
    return L ? L.clearMarks() : { ok: true };
  }
  function _pageWfRemoveStorage(origin, local, session) {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.removeStorage(origin, local, session) : { ok: false, needLib: true, error: "workflow lib not loaded" };
  }
  function _pageWfDigest() {
    const L = globalThis.__autodomWfLib;
    return L && L.v === 5 ? L.digest() : { needLib: true };
  }
  // Fast-mode settle: resolve once the DOM has been quiet for idleMs (no
  // mutations), or after capMs at the latest. Self-contained, no library.
  function _pageWfQuiet(idleMs, capMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      let idleTimer = null;
      let done = false;
      let obs = null;
      const finish = (quiet) => {
        if (done) return;
        done = true;
        clearTimeout(idleTimer);
        clearTimeout(capTimer);
        try { obs && obs.disconnect(); } catch (_) {}
        resolve({ ok: true, quiet, waitedMs: Date.now() - started });
      };
      const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(true), idleMs);
      };
      const capTimer = setTimeout(() => finish(false), capMs);
      try {
        obs = new MutationObserver(arm);
        obs.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (_) {}
      arm();
    });
  }

  // ─── Pure helpers (SW side, unit tested) ─────────────────────────────

  const ACTIONS = new Set([
    "navigate", "click", "dblclick", "hover", "fill", "select", "check", "press",
    "wait", "assert", "scroll", "upload",
  ]);
  const LOCATOR_ACTIONS = new Set(["click", "dblclick", "hover", "fill", "select", "check", "press", "upload"]);
  const VAR_RE = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;
  const HAS_VAR = /\{\{\s*[A-Za-z_][\w]*\s*\}\}/;
  const SECRET_NAME_RE = /pass|pwd|secret|token|otp|pin|cvv|cvc|ssn|card/i;

  function newId(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function slugify(s, fallback) {
    const out = String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32)
      .replace(/_+$/g, "");
    if (!out) return fallback || "value";
    return /^[a-z_]/.test(out) ? out : "v_" + out;
  }

  function describeTarget(loc) {
    if (!loc) return "element";
    const role = loc.role || loc.tag || "element";
    const name = loc.accessibleName || loc.label || loc.placeholder || loc.text || loc.testid || loc.name || loc.id;
    return name ? `${role} "${String(name).slice(0, 60)}"` : loc.css ? `${role} \`${loc.css}\`` : role;
  }

  // Turn literal typed values into {{variables}}. Mutates and returns steps.
  function extractVariables(steps, existing) {
    const variables = Array.isArray(existing) ? existing.slice() : [];
    const used = new Set(variables.map((v) => v.name));
    for (const step of steps) {
      if (step.action !== "fill") continue;
      if (typeof step.value === "string" && HAS_VAR.test(step.value)) continue;
      const loc = step.locator || {};
      const cssId = /#([A-Za-z][\w-]*)/.exec(loc.css || "");
      let base = slugify(loc.label || loc.accessibleName || loc.placeholder || loc.name || loc.id || loc.testid || (cssId && cssId[1]), "value");
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      const secret = !!step.secret || SECRET_NAME_RE.test(name) || loc.inputType === "password";
      variables.push({
        name,
        type: "string",
        secret,
        default: secret ? "" : String(step.value == null ? "" : step.value),
        description: `Value for ${describeTarget(loc)}`,
      });
      step.value = `{{${name}}}`;
      if (secret) step.secret = true;
    }
    return { steps, variables };
  }

  function referencedVariables(wf) {
    const names = new Set();
    const scan = (v) => {
      if (typeof v !== "string") return;
      for (const m of v.matchAll(VAR_RE)) names.add(m[1]);
    };
    for (const s of wf.steps || []) {
      scan(s.value);
      scan(s.url);
      if (s.assert) scan(s.assert.value);
    }
    return names;
  }

  function resolveVariables(wf, provided) {
    const values = {};
    const missing = [];
    const declared = new Map((wf.variables || []).map((v) => [v.name, v]));
    for (const name of referencedVariables(wf)) {
      const decl = declared.get(name);
      const given = provided && Object.prototype.hasOwnProperty.call(provided, name) ? provided[name] : undefined;
      const value = given !== undefined && given !== null ? String(given) : decl && decl.default != null ? String(decl.default) : "";
      if (value === "" && (!decl || decl.secret || decl.required)) missing.push(name);
      values[name] = value;
    }
    return { values, missing };
  }

  function substitute(value, values) {
    if (typeof value !== "string") return value;
    return value.replace(VAR_RE, (_, name) => (values && values[name] != null ? String(values[name]) : ""));
  }

  function validateWorkflow(wf) {
    const errors = [];
    if (!wf || typeof wf !== "object") return ["workflow must be an object"];
    if (!Array.isArray(wf.steps) || wf.steps.length === 0) errors.push("workflow.steps must be a non-empty array");
    if (Array.isArray(wf.steps) && wf.steps.length > 500) errors.push("workflow has more than 500 steps");
    (wf.steps || []).forEach((s, i) => {
      if (!s || !ACTIONS.has(s.action)) errors.push(`step ${i + 1}: unknown action ${s && s.action}`);
      else if (s.action === "navigate" && !s.url) errors.push(`step ${i + 1}: navigate needs url`);
      else if (LOCATOR_ACTIONS.has(s.action) && !s.locator && !s.ref) errors.push(`step ${i + 1}: ${s.action} needs locator`);
      else if (s.action === "assert" && (!s.assert || !s.assert.type)) errors.push(`step ${i + 1}: assert needs assert.type`);
    });
    for (const v of wf.variables || []) {
      if (!/^[A-Za-z_][\w]*$/.test(String(v && v.name))) errors.push(`invalid variable name: ${v && v.name}`);
    }
    return errors;
  }

  // Collapse noise from raw recorder output into replayable steps.
  function compactSteps(raw) {
    const out = [];
    for (const step of raw) {
      const prev = out[out.length - 1];
      const sameTarget = prev && prev.locator && step.locator && prev.locator.css === step.locator.css && (prev.locator.shadowHosts || []).join() === (step.locator.shadowHosts || []).join();
      if (step.action === "fill" && prev && prev.action === "fill" && sameTarget) {
        out[out.length - 1] = step;
        continue;
      }
      if (step.action === "navigate" && prev && prev.action === "navigate" && prev.url === step.url) continue;
      // A click that navigated: the follow-up committed navigation is implied.
      if (step.action === "navigate" && step.implied && prev && LOCATOR_ACTIONS.has(prev.action)) continue;
      out.push(step);
    }
    return out.map((s) => {
      const { t, implied, ...rest } = s;
      return rest;
    });
  }

  function buildDraft({ steps, startUrl, name, description, source }) {
    const compacted = compactSteps(steps);
    if (startUrl && (!compacted.length || compacted[0].action !== "navigate")) {
      compacted.unshift({ action: "navigate", url: startUrl });
    }
    const { variables } = extractVariables(compacted);
    const now = Date.now();
    return {
      id: newId("wf"),
      name: name || `Recorded workflow ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`,
      description: description || "",
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdFrom: source || "recording",
      startUrl: startUrl || (compacted.find((s) => s.action === "navigate") || {}).url || "",
      variables,
      steps: compacted,
      stats: { runs: 0, passes: 0, heals: 0 },
    };
  }

  // Session-log (start_recording) → workflow. Agent tool calls carry their
  // params, so selector-based calls become css locators.
  function fromSessionRecording(actions, opts) {
    const steps = [];
    for (const a of actions || []) {
      if (a.type !== "tool_call") continue;
      const d = a.details || {};
      const tool = String(a.description || "").split("(")[0];
      const css = d.selector || d.target || d.element;
      const loc = css ? { css: String(css) } : null;
      switch (tool) {
        case "navigate": case "browser_navigate":
          if (d.url) steps.push({ action: "navigate", url: d.url });
          break;
        case "click": case "browser_click": case "force_click":
          if (loc) steps.push({ action: d.dblClick || d.doubleClick ? "dblclick" : "click", locator: loc });
          else if (d.text) steps.push({ action: "click", locator: { text: String(d.text) } });
          break;
        case "double_click":
          if (loc) steps.push({ action: "dblclick", locator: loc });
          break;
        case "hover": case "browser_hover":
          if (loc) steps.push({ action: "hover", locator: loc });
          break;
        case "type_text": case "browser_type":
          if (loc) {
            const secret = d.text === "[REDACTED]";
            steps.push({ action: "fill", locator: loc, value: secret ? "" : d.text, ...(secret ? { secret: true } : {}) });
            if (d.submit) steps.push({ action: "press", key: "Enter", locator: loc });
          }
          break;
        case "select_option": case "browser_select_option":
          if (loc) steps.push({ action: "select", locator: loc, value: Array.isArray(d.values) ? d.values[0] : d.value, optionText: d.text });
          break;
        case "press_key": case "browser_press_key":
          steps.push({ action: "press", key: d.key || "Enter", locator: loc || { css: ":focus" } });
          break;
        case "wait_for_text": case "browser_wait_for":
          if (d.text) steps.push({ action: "assert", assert: { type: "text", value: d.text } });
          break;
        default:
          break;
      }
    }
    return buildDraft({ steps, name: opts && opts.name, description: opts && opts.description, source: "session_recording" });
  }

  // ── Heuristic heal: score page candidates against the recorded bundle ──
  function tokens(s) {
    return new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  }
  function similarity(a, b) {
    if (!a || !b) return 0;
    const x = String(a).toLowerCase().trim();
    const y = String(b).toLowerCase().trim();
    if (x === y) return 1;
    if (x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))) return 0.8;
    const ta = tokens(x);
    const tb = tokens(y);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter);
  }
  function scoreCandidate(loc, cand) {
    let score = 0;
    if (loc.testid && cand.testid === loc.testid) score += 0.45;
    if (loc.id && cand.id === loc.id) score += 0.3;
    if (loc.name && cand.name === loc.name) score += 0.2;
    if (loc.tag && cand.tag === loc.tag) score += 0.1;
    if (loc.role && cand.role === loc.role) score += 0.15;
    if (loc.inputType && cand.inputType === loc.inputType) score += 0.05;
    score += 0.35 * similarity(loc.accessibleName, cand.accessibleName);
    score += 0.15 * Math.max(similarity(loc.label, cand.label), similarity(loc.placeholder, cand.placeholder), similarity(loc.text, cand.text));
    if (loc.bbox && cand.bbox) {
      const d = Math.hypot(loc.bbox.x - cand.bbox.x, loc.bbox.y - cand.bbox.y);
      score += 0.1 * Math.max(0, 1 - d / 600);
    }
    return Math.round(score * 1000) / 1000;
  }
  function pickHeuristic(loc, candidates, opts) {
    const minScore = (opts && opts.minScore) || 0.5;
    const margin = (opts && opts.margin) || 0.08;
    const ranked = (candidates || [])
      .map((c) => ({ c, s: scoreCandidate(loc || {}, c) }))
      .sort((a, b) => b.s - a.s);
    if (!ranked.length || ranked[0].s < minScore) return null;
    if (ranked[1] && ranked[0].s - ranked[1].s < margin) return null;
    return { candidate: ranked[0].c, score: ranked[0].s, runnerUp: ranked[1] ? ranked[1].s : 0 };
  }

  function compactLine(c) {
    const role = c.role || c.tag;
    const name = c.accessibleName || c.label || c.placeholder || c.text || "";
    const extra = [];
    if (c.inputType && c.inputType !== c.role && !["text", "submit", "button", "checkbox", "radio", "select-one", "select-multiple", "search", "number", "range"].includes(c.inputType)) {
      extra.push(c.inputType);
    }
    if (c.testid) extra.push(`testid=${c.testid}`);
    return `@${c.ref} ${role}${name ? ` "${String(name).slice(0, 80)}"` : ""}${extra.length ? ` [${extra.join(" ")}]` : ""}`;
  }

  function diffDigest(before, after) {
    if (!before || !after) return null;
    const delta = (a, b) => ({
      added: (b || []).filter((k) => !(a || []).includes(k)),
      removed: (a || []).filter((k) => !(b || []).includes(k)),
    });
    const out = {};
    if (before.url !== after.url) out.url = { from: before.url, to: after.url };
    if (before.title !== after.title) out.title = { from: before.title, to: after.title };
    out.contentChanged = before.textHash !== after.textHash;
    out.elementDelta = (after.elementCount || 0) - (before.elementCount || 0);
    for (const [key, label] of [["storageKeys", "localStorage"], ["sessionKeys", "sessionStorage"], ["cookieNames", "cookies"]]) {
      const d = delta(before[key], after[key]);
      if (d.added.length || d.removed.length) out[label] = d;
    }
    return out;
  }

  // ── Exporters ──
  function jsString(s) {
    return JSON.stringify(String(s == null ? "" : s));
  }
  function valueExpr(value) {
    if (typeof value !== "string" || !HAS_VAR.test(value)) return jsString(value);
    if (/^\{\{\s*[A-Za-z_]\w*\s*\}\}$/.test(value)) return "vars." + value.replace(/[{}\s]/g, "");
    const body = value
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${")
      .replace(VAR_RE, (_, n) => "${vars." + n + "}");
    return "`" + body + "`";
  }
  function playwrightLocator(loc) {
    if (!loc) return "page.locator(':focus')";
    if (loc.testid) {
      return !loc.testidAttr || loc.testidAttr === "data-testid"
        ? `page.getByTestId(${jsString(loc.testid)})`
        : `page.locator(${jsString(`[${loc.testidAttr}="${loc.testid}"]`)})`;
    }
    if (loc.role && loc.accessibleName) {
      return `page.getByRole(${jsString(loc.role)}, { name: ${jsString(loc.accessibleName)}, exact: true })`;
    }
    if (loc.label) return `page.getByLabel(${jsString(loc.label)}, { exact: true })`;
    if (loc.placeholder) return `page.getByPlaceholder(${jsString(loc.placeholder)}, { exact: true })`;
    if (loc.id) return `page.locator(${jsString("#" + loc.id.replace(/([^a-zA-Z0-9_-])/g, "\\$1"))})`;
    if (loc.name) return `page.locator(${jsString(`${loc.tag || ""}[name="${loc.name}"]`)})`;
    if (loc.text) return `page.getByText(${jsString(loc.text)}, { exact: true })`;
    if (loc.css) return `page.locator(${jsString(loc.css)})`;
    if (loc.xpath) return `page.locator(${jsString("xpath=" + loc.xpath)})`;
    return "page.locator(':focus')";
  }
  function envName(name) {
    return "AUTODOM_" + String(name).toUpperCase();
  }
  function toPlaywright(wf) {
    const lines = [];
    lines.push("// Generated by AutoDOM from workflow " + jsString(wf.name) + " (" + wf.id + ")");
    lines.push("import { test, expect } from '@playwright/test';");
    lines.push("");
    const vars = wf.variables || [];
    if (vars.length) {
      lines.push("const vars = {");
      for (const v of vars) {
        const def = v.secret ? '""' : jsString(v.default == null ? "" : v.default);
        lines.push(`  ${v.name}: process.env.${envName(v.name)} ?? ${def},${v.secret ? " // secret: set " + envName(v.name) : ""}`);
      }
      lines.push("};");
      lines.push("");
    }
    lines.push(`test(${jsString(wf.name)}, async ({ page }) => {`);
    for (const s of wf.steps || []) {
      const L = playwrightLocator(s.locator);
      switch (s.action) {
        case "navigate": lines.push(`  await page.goto(${valueExpr(s.url)});`); break;
        case "click": lines.push(`  await ${L}.click();`); break;
        case "dblclick": lines.push(`  await ${L}.dblclick();`); break;
        case "hover": lines.push(`  await ${L}.hover();`); break;
        case "fill": lines.push(`  await ${L}.fill(${valueExpr(s.value)});`); break;
        case "select":
          lines.push(`  await ${L}.selectOption(${s.value != null && s.value !== "" ? valueExpr(s.value) : `{ label: ${jsString(s.optionText)} }`});`);
          break;
        case "check": lines.push(`  await ${L}.${s.value === false ? "uncheck" : "check"}();`); break;
        case "press": lines.push(`  await ${L}.press(${jsString(s.key || "Enter")});`); break;
        case "wait": lines.push(`  await page.waitForTimeout(${Number(s.ms) || 500});`); break;
        case "scroll": lines.push(`  await page.mouse.wheel(0, ${Number(s.y) || 0});`); break;
        case "upload": lines.push(`  // TODO: upload — await ${L}.setInputFiles('path/to/file');`); break;
        case "assert": {
          const a = s.assert || {};
          if (a.type === "url") lines.push(`  await expect(page).toHaveURL(new RegExp(${jsString(String(a.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}));`);
          else if (a.type === "title") lines.push(`  await expect(page).toHaveTitle(new RegExp(${jsString(String(a.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}));`);
          else if (a.type === "text") lines.push(`  await expect(page.getByText(${valueExpr(a.value)}).first()).toBeVisible();`);
          else if (a.type === "visible") lines.push(`  await expect(${playwrightLocator(a.locator)}).toBeVisible();`);
          else if (a.type === "hidden") lines.push(`  await expect(${playwrightLocator(a.locator)}).toBeHidden();`);
          break;
        }
        default: lines.push(`  // unsupported step: ${s.action}`);
      }
    }
    lines.push("});");
    lines.push("");
    return lines.join("\n");
  }

  function stepSentence(s) {
    const target = `**${describeTarget(s.locator)}**`;
    const val = (v) => "`" + String(v == null ? "" : v).replace(/`/g, "'") + "`";
    switch (s.action) {
      case "navigate": return `Open ${val(s.url)}`;
      case "click": return `Click ${target}`;
      case "dblclick": return `Double-click ${target}`;
      case "hover": return `Hover over ${target}`;
      case "fill": return `Fill ${target} with ${s.secret && !/\{\{/.test(s.value || "") ? "`<secret>`" : val(s.value)}`;
      case "select": return `Select ${val(s.optionText || s.value)} in ${target}`;
      case "check": return `${s.value === false ? "Uncheck" : "Check"} ${target}`;
      case "press": return `Press ${val(s.key || "Enter")} in ${target}`;
      case "wait": return `Wait ${Number(s.ms) || 500} ms`;
      case "scroll": return `Scroll to ${s.x || 0}, ${s.y || 0}`;
      case "upload": return `Upload a file to ${target} (manual)`;
      case "assert": {
        const a = s.assert || {};
        if (a.type === "url") return `Verify the URL contains ${val(a.value)}`;
        if (a.type === "title") return `Verify the title contains ${val(a.value)}`;
        if (a.type === "text") return `Verify the page shows ${val(a.value)}`;
        if (a.type === "visible") return `Verify **${describeTarget(a.locator)}** is visible`;
        if (a.type === "hidden") return `Verify **${describeTarget(a.locator)}** is hidden`;
        return `Verify ${a.type}`;
      }
      default: return `${s.action}`;
    }
  }

  function toMarkdown(wf) {
    const out = [];
    out.push(`# ${wf.name}`);
    out.push("");
    if (wf.description) {
      out.push(wf.description);
      out.push("");
    }
    out.push(`- **Workflow ID:** \`${wf.id}\``);
    if (wf.startUrl) out.push(`- **Start URL:** ${wf.startUrl}`);
    if (wf.createdAt) out.push(`- **Recorded:** ${new Date(wf.createdAt).toISOString().slice(0, 10)}`);
    if (wf.stats) out.push(`- **Runs:** ${wf.stats.runs || 0} (passed ${wf.stats.passes || 0}, self-healed ${wf.stats.heals || 0})`);
    out.push("");
    const vars = wf.variables || [];
    if (vars.length) {
      out.push("## Variables");
      out.push("");
      out.push("| Name | Default | Secret | Notes |");
      out.push("| --- | --- | --- | --- |");
      for (const v of vars) {
        const cell = (x) => String(x == null ? "" : x).replace(/\|/g, "\\|").replace(/\n/g, " ");
        out.push(`| \`${v.name}\` | ${v.secret ? "—" : cell(v.default)} | ${v.secret ? "yes" : "no"} | ${cell(v.description)} |`);
      }
      out.push("");
    }
    out.push("## Steps");
    out.push("");
    (wf.steps || []).forEach((s, i) => out.push(`${i + 1}. ${stepSentence(s)}${s.optional ? " _(optional)_" : ""}`));
    out.push("");
    out.push("<details><summary>Machine-readable workflow (AutoDOM can re-import this file)</summary>");
    out.push("");
    out.push("```json");
    out.push(JSON.stringify(stripRuntime(wf), null, 2));
    out.push("```");
    out.push("");
    out.push("</details>");
    out.push("");
    return out.join("\n");
  }

  function stripRuntime(wf) {
    const { lastRun, ...rest } = wf;
    return rest;
  }

  // Accepts a workflow object, its JSON text, or a Markdown routine that
  // embeds the JSON (as produced by toMarkdown).
  function parseRoutine(input) {
    if (input && typeof input === "object") return input;
    const text = String(input || "").trim();
    if (!text) throw new Error("empty workflow");
    if (text.startsWith("{")) return JSON.parse(text);
    const m = text.match(/```json\s*([\s\S]*?)```/);
    if (!m) throw new Error("no ```json block found in Markdown routine");
    return JSON.parse(m[1]);
  }

  function summarize(wf) {
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description || "",
      startUrl: wf.startUrl || "",
      steps: (wf.steps || []).length,
      variables: (wf.variables || []).map((v) => ({ name: v.name, secret: !!v.secret, default: v.secret ? undefined : v.default })),
      updatedAt: wf.updatedAt,
      stats: wf.stats || { runs: 0, passes: 0, heals: 0 },
      lastRun: wf.lastRun || null,
    };
  }

  // ─── Engine (service-worker side) ────────────────────────────────────
  const WF_KEY = "autodom.workflows";
  const RUNS_KEY = "autodom.workflowRuns";
  const REC_KEY = "autodom.wf.recording";
  const DRAFT_KEY = "autodom.wf.lastDraft";
  const MAX_RUNS = 200; // hard ceiling; features.runHistoryLimit picks the real cap
  const UNDO_KEY = "autodom.runUndo";
  const MAX_UNDO_RUNS = 20;
  const UNDO_GROUP = { field: "fields", storage: "storage", cookies: "cookies", navigation: "navigation" };
  const MAY_CHANGE_PAGE = new Set(["click", "dblclick", "press"]);
  // Finished runs / batches stay in memory for live run_get views, then
  // fall back to the persisted history.
  const MAX_FINISHED_LIVE = 20;
  const FINISHED_TTL_MS = 5 * 60 * 1000;
  const RUNS_WRITE_DEBOUNCE_MS = 300;
  const REC_PERSIST_DEBOUNCE_MS = 150;
  const REC_PERSIST_MAX_WAIT_MS = 1000;
  // Used when the SW does not pass getFeatures (unit tests, old callers).
  // Mirrors the engine-relevant subset of feature-flags.js DEFAULTS.
  const FEATURE_DEFAULTS = {
    visionHeal: "auto",
    defaultRunMode: "heal",
    undoTracking: true,
    parallelConcurrency: 3,
    runHistoryLimit: 50,
    perfMode: "fast",
    overlayVisionMarks: true,
    overlayRecordingIndicator: true,
  };

  function unrefTimer(t) {
    try { if (t && typeof t.unref === "function") t.unref(); } catch (_) {}
    return t;
  }

  function makeEngine(ctx) {
    const storage = ctx.storage || (globalThis.chrome && chrome.storage);
    const log = ctx.log || (() => {});
    const exec = (tabId, fn, args) => ctx.executeInTab(tabId, fn, args || [], "ISOLATED");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let rec = null; // { nonce, tabId, steps, startedAt, startUrl, agentNavUrls }
    let lastDraft = null;
    const runs = new Map(); // runId → live run
    const batches = new Map(); // batchId → parallel batch
    let persistChain = Promise.resolve(); // serialises stats read-modify-write across parallel runs
    let currentRunId = null; // newest running run, mirrored to the chat toolbar

    // ── feature flags + hooks ──
    async function features() {
      let flags = null;
      if (typeof ctx.getFeatures === "function") {
        try { flags = await ctx.getFeatures(); } catch (_) {}
      }
      return { ...FEATURE_DEFAULTS, ...(flags && typeof flags === "object" ? flags : {}) };
    }
    // Vision self-heal: "off" never, "on" whenever a vision picker exists,
    // "auto" only when the SW says an AI provider is enabled and usable.
    // A per-call vision:false always wins.
    async function visionAllowed(params, flags) {
      if (params && params.vision === false) return false;
      if (typeof ctx.visionPick !== "function") return false;
      const mode = (flags || (await features())).visionHeal;
      if (mode === "off") return false;
      if (mode === "on") return true;
      if (typeof ctx.visionAvailable === "function") {
        try { return !!(await ctx.visionAvailable()); } catch (_) { return false; }
      }
      return true;
    }
    function broadcast(patch) {
      if (typeof ctx.broadcastState !== "function") return;
      try { ctx.broadcastState(patch); } catch (_) {}
    }
    // A workflow was written to storage outside the MCP save tools (chat
    // /teach, self-heal): the SW forwards it to the bridge so the server's
    // ~/.autodom/workflows mirror stays current.
    function emitSaved(wf, reason, callCtx) {
      if (typeof ctx.onWorkflowSaved !== "function" || !wf) return;
      try { ctx.onWorkflowSaved(JSON.parse(JSON.stringify(wf)), { reason, origin: (callCtx && callCtx.origin) || null }); } catch (_) {}
    }

    // ── storage ──
    async function loadAll() {
      const got = await storage.local.get(WF_KEY);
      return (got && got[WF_KEY]) || {};
    }
    async function saveAll(map) {
      await storage.local.set({ [WF_KEY]: map });
    }
    async function getWorkflow(id) {
      const map = await loadAll();
      return map[id] || null;
    }
    async function putWorkflow(wf) {
      const map = await loadAll();
      wf.updatedAt = Date.now();
      map[wf.id] = wf;
      await saveAll(map);
      return wf;
    }
    async function findWorkflow(ref) {
      if (!ref) return null;
      const map = await loadAll();
      if (map[ref]) return map[ref];
      const lower = String(ref).toLowerCase();
      return Object.values(map).find((w) => String(w.name).toLowerCase() === lower) || null;
    }

    // Run history: an in-memory copy of autodom.workflowRuns serves reads;
    // writes are debounced (300 ms) and flushed at the end of a batch.
    let runsCache = null;
    let runsLoading = null;
    let runsWriteTimer = null;
    let runsWriteChain = Promise.resolve();
    let runsWrittenSig = null;
    const runsSig = (list) => (list || []).map((r) => r && r.runId).join(",");
    async function loadRuns() {
      if (runsCache) return runsCache;
      if (!runsLoading) {
        runsLoading = (async () => {
          try {
            const got = await storage.local.get(RUNS_KEY);
            const list = (got && got[RUNS_KEY]) || [];
            if (!runsCache) runsCache = Array.isArray(list) ? list : [];
          } catch (_) {
            if (!runsCache) runsCache = [];
          }
          return runsCache;
        })().finally(() => { runsLoading = null; });
      }
      return runsLoading;
    }
    function flushRuns() {
      clearTimeout(runsWriteTimer);
      runsWriteTimer = null;
      if (!runsCache) return runsWriteChain;
      const snapshot = runsCache.slice();
      runsWrittenSig = runsSig(snapshot);
      runsWriteChain = runsWriteChain
        .then(() => storage.local.set({ [RUNS_KEY]: snapshot }))
        .catch((err) => log("[AutoDOM WF] write run history failed:", err && err.message));
      return runsWriteChain;
    }
    async function pushRun(report, flags) {
      const list = await loadRuns();
      const limit = Math.max(1, Math.min(MAX_RUNS, Number((flags || {}).runHistoryLimit) || FEATURE_DEFAULTS.runHistoryLimit));
      const slim = { ...report, steps: report.steps.map(({ screenshot, ...s }) => s) };
      runsCache = [slim, ...list.filter((r) => r.runId !== report.runId)].slice(0, limit);
      clearTimeout(runsWriteTimer);
      runsWriteTimer = setTimeout(flushRuns, RUNS_WRITE_DEBOUNCE_MS);
    }
    // Popup → Storage → "Clear run history". The SW removes the storage
    // key; this drops the in-memory copy and any queued write so the old
    // history is not written back. Running runs are kept (they land in the
    // emptied history when they finish); finished ones leave memory.
    async function clearRunHistory() {
      clearTimeout(runsWriteTimer);
      runsWriteTimer = null;
      runsCache = [];
      runsWrittenSig = "";
      // A write that was already in flight could land after the SW's
      // remove: wait for it, then make sure the key is gone.
      try { await runsWriteChain; } catch (_) {}
      try {
        if (typeof storage.local.remove === "function") await storage.local.remove(RUNS_KEY);
        else await storage.local.set({ [RUNS_KEY]: [] });
      } catch (_) {}
      let dropped = 0;
      for (const [id, l] of [...runs.entries()]) {
        if (l.report.status !== "running") { runs.delete(id); dropped++; }
      }
      for (const [id, b] of [...batches.entries()]) {
        if (b.finishedAt) { batches.delete(id); dropped++; }
      }
      return { ok: true, dropped };
    }
    // Popup → Storage → "Clear workflow drafts" (the SW removes the session copy).
    async function clearDrafts() {
      const had = !!lastDraft;
      lastDraft = null;
      return { ok: true, cleared: had };
    }

    // Someone else changed the history (popup "Clear run history"): adopt it.
    try {
      if (storage && storage.onChanged && typeof storage.onChanged.addListener === "function") {
        storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes || !changes[RUNS_KEY]) return;
          const next = changes[RUNS_KEY].newValue;
          if (runsSig(next) === runsWrittenSig) return; // our own write
          runsCache = Array.isArray(next) ? next.slice() : [];
          runsWrittenSig = runsSig(runsCache);
        });
      }
    } catch (_) {}

    // In-flight recording state lives in session storage so a SW restart
    // keeps recording. Writes are debounced for bursts but never starved:
    // a pending change is written at least once a second, and start/stop
    // write immediately.
    let recPersistTimer = null;
    let recLastWrite = 0;
    function writeRecNow() {
      clearTimeout(recPersistTimer);
      recPersistTimer = null;
      recLastWrite = Date.now();
      try {
        if (!storage.session) return Promise.resolve();
        const value = rec ? { ...rec, steps: rec.steps.slice() } : null;
        return Promise.resolve(storage.session.set({ [REC_KEY]: value })).catch(() => {});
      } catch (_) {
        return Promise.resolve();
      }
    }
    function schedulePersistRec() {
      if (Date.now() - recLastWrite >= REC_PERSIST_MAX_WAIT_MS) {
        writeRecNow();
        return;
      }
      if (recPersistTimer) return; // a write within 150 ms is already queued
      recPersistTimer = setTimeout(writeRecNow, REC_PERSIST_DEBOUNCE_MS);
    }

    // Recorder events (step messages, navigations) that arrive while the
    // SW is still reading the in-flight recording back from session
    // storage are queued and replayed once it is known.
    let hydrated = false;
    const earlyEvents = [];
    async function doHydrate() {
      try {
        if (storage.session) {
          const got = await storage.session.get(REC_KEY);
          if (!rec && got && got[REC_KEY] && got[REC_KEY].nonce) rec = got[REC_KEY];
        }
      } catch (_) {}
      hydrated = true;
      const queued = earlyEvents.splice(0);
      for (const fn of queued) {
        try { fn(); } catch (_) {}
      }
      if (rec) broadcast({ wfRecording: true });
    }
    const ready = doHydrate();
    function hydrate() {
      return ready;
    }
    function whenHydrated(fn) {
      if (hydrated) return fn();
      if (earlyEvents.length < 2000) earlyEvents.push(fn);
      return undefined;
    }

    // ── page calls with lazy library injection ──
    async function injectLib(tabId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await exec(tabId, _pageWfLib, []);
          return true;
        } catch (err) {
          if (attempt === 2) throw err;
          await Promise.resolve(ctx.waitForTabComplete(tabId, 8000)).catch(() => {});
          await sleep(250);
        }
      }
      return false;
    }
    // Call a page entry point; inject the library only when the page says
    // it is missing (first call on a new document) and retry once. A call
    // that throws (document replaced mid-call) waits for the tab, injects
    // and retries once too.
    async function execLib(tabId, fn, args) {
      let res;
      try {
        res = await exec(tabId, fn, args);
      } catch (_) {
        await injectLib(tabId);
        return exec(tabId, fn, args);
      }
      if (res && res.needLib) {
        await injectLib(tabId);
        res = await exec(tabId, fn, args);
      }
      return res;
    }

    async function injectRecorder(tabId) {
      const flags = await features();
      return execLib(tabId, _pageWfStartRecording, [rec.nonce, { indicator: flags.overlayRecordingIndicator !== false }]);
    }

    // ── recorder ──
    async function recordStart(params, callCtx) {
      await ready;
      if (rec) return { ok: false, error: "A workflow recording is already running. Call workflow_record_stop first.", tabId: rec.tabId };
      const tab = params && params.tabId != null ? await chrome.tabs.get(params.tabId) : await ctx.getActiveTab(callCtx);
      if (params && params.url) {
        await chrome.tabs.update(tab.id, { url: params.url });
        await ctx.waitForTabComplete(tab.id);
      }
      const fresh = await chrome.tabs.get(tab.id);
      rec = {
        nonce: newId("rec"),
        tabId: tab.id,
        steps: [],
        startedAt: Date.now(),
        startUrl: fresh.url || (params && params.url) || "",
      };
      writeRecNow();
      try {
        await injectRecorder(tab.id);
      } catch (err) {
        const msg = String((err && err.message) || err);
        rec = null;
        writeRecNow();
        return { ok: false, error: `Could not start recorder on this page: ${msg}` };
      }
      broadcast({ wfRecording: true });
      return {
        ok: true,
        recording: true,
        tabId: tab.id,
        startUrl: rec.startUrl,
        hint: "Interact with the page (or drive it with tools). Navigation, clicks, typing, selects, checkboxes and Enter/Escape are captured. Call workflow_record_stop when done.",
      };
    }

    async function storeDraft(r, params) {
      const draft = buildDraft({
        steps: r.steps,
        startUrl: r.startUrl,
        name: params && params.name,
        description: params && params.description,
        source: "recording",
      });
      lastDraft = draft;
      try { storage.session && (await storage.session.set({ [DRAFT_KEY]: draft })); } catch (_) {}
      return draft;
    }

    async function recordStop(params, callCtx) {
      await ready;
      if (!rec) return { ok: false, error: "No workflow recording in progress" };
      const r = rec;
      rec = null;
      await writeRecNow();
      broadcast({ wfRecording: false });
      try { await exec(r.tabId, _pageWfStopRecording, []); } catch (_) {}
      const draft = await storeDraft(r, params);
      let saved = false;
      if (params && params.save) {
        await putWorkflow(draft);
        saved = true;
        emitSaved(draft, "record", callCtx);
      }
      return {
        ok: true,
        saved,
        workflow: draft,
        markdown: toMarkdown(draft),
        hint: saved
          ? `Saved as ${draft.id}. Run it with workflow_run { id: "${draft.id}" }.`
          : "Review the draft, then call workflow_save (optionally with name/description or an edited workflow) to keep it.",
      };
    }

    // The recording tab was closed: keep what was captured as an unsaved
    // draft (workflow_save picks it up) and end the recording.
    async function onTabRemoved(tabId) {
      await ready;
      for (const live of runs.values()) {
        if (live.report.status === "running" && live.report.tabId === tabId) live.tabClosed = true;
      }
      if (!rec || rec.tabId !== tabId) return null;
      const r = rec;
      rec = null;
      await writeRecNow();
      broadcast({ wfRecording: false });
      const draft = await storeDraft(r, { description: "Recording ended because its tab was closed." });
      log("[AutoDOM WF] recording tab closed; kept draft", draft.id);
      return draft;
    }

    function pushStep(step) {
      if (!rec) return;
      if (step.replacesPrevious) {
        delete step.replacesPrevious;
        const prev = rec.steps[rec.steps.length - 1];
        if (prev && prev.action === "click" && prev.locator && step.locator && prev.locator.css === step.locator.css) rec.steps.pop();
      }
      rec.steps.push(step);
      if (rec.steps.length > 2000) rec.steps.shift();
      schedulePersistRec();
    }

    function handleStepMessage(message, sender) {
      if (!rec || message.nonce !== rec.nonce) return;
      if (sender && sender.tab && sender.tab.id !== rec.tabId) return;
      const step = message.step || {};
      if (!ACTIONS.has(step.action)) return;
      pushStep(step);
    }

    // Synchronous (the SW's onMessage listener returns right away). Steps
    // that arrive before hydrate() finished are buffered, not dropped.
    function onRuntimeMessage(message, sender) {
      if (!message || message.type !== "AUTODOM_WF_STEP") return false;
      whenHydrated(() => handleStepMessage(message, sender));
      return true;
    }

    // Typed / bookmarked / agent-driven navigations become navigate steps;
    // link clicks and form submits are implied by the step that caused them.
    function onNavigationCommitted(details) {
      whenHydrated(() => {
        if (!rec || details.tabId !== rec.tabId || details.frameId !== 0) return;
        const tt = details.transitionType || "";
        const q = details.transitionQualifiers || [];
        if (/^(chrome|about|chrome-extension|devtools):/.test(details.url || "")) return;
        if (q.includes("forward_back")) return;
        const explicit = ["typed", "auto_bookmark", "generated", "keyword", "keyword_generated"].includes(tt) || q.includes("from_address_bar");
        pushStep({ action: "navigate", url: details.url, t: Date.now(), ...(explicit ? {} : { implied: true }) });
      });
    }

    async function onNavigationCompleted(details) {
      await ready;
      if (!rec || details.tabId !== rec.tabId || details.frameId !== 0) return;
      try {
        await injectRecorder(details.tabId);
      } catch (err) {
        log("[AutoDOM WF] re-inject recorder failed:", err && err.message);
      }
    }

    function noteAgentTool(tool, params) {
      whenHydrated(() => {
        if (!rec) return;
        if ((tool === "navigate" || tool === "browser_navigate") && params && params.url) {
          pushStep({ action: "navigate", url: String(params.url), t: Date.now() });
        }
      });
    }

    // ── runner ──
    async function safeDigest(tabId) {
      try {
        const d = await execLib(tabId, _pageWfDigest, []);
        return d && !d.needLib ? d : null;
      } catch (_) {
        return null;
      }
    }

    async function waitIfLoading(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "loading") await ctx.waitForTabComplete(tabId, 15000);
        return true;
      } catch (_) {
        return false;
      }
    }

    // After an action. balanced: fixed wait (250 ms default) then the load.
    // fast: 50 ms, then the load if one started, else until the DOM has
    // been quiet for 100 ms (capped at 250 ms). An explicit step.waitMs is
    // always a plain wait.
    async function settle(tabId, ms, opts) {
      if (opts && opts.fast) {
        await sleep(50);
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === "loading") {
            await ctx.waitForTabComplete(tabId, 15000);
            return;
          }
        } catch (_) {
          return;
        }
        try { await exec(tabId, _pageWfQuiet, [100, 250]); } catch (_) {}
        await waitIfLoading(tabId);
        return;
      }
      await sleep(ms);
      await waitIfLoading(tabId);
    }

    // Navigate and wait for the load. The onUpdated listener is registered
    // before tabs.update so a fast load cannot be missed.
    function navigateAndWait(tabId, url, timeoutMs) {
      const onUpdated = globalThis.chrome && chrome.tabs && chrome.tabs.onUpdated;
      if (!onUpdated || typeof onUpdated.addListener !== "function") {
        return Promise.resolve(chrome.tabs.update(tabId, { url })).then(() => settle(tabId, 300));
      }
      return new Promise((resolve, reject) => {
        let done = false;
        let sawLoading = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { onUpdated.removeListener(listener); } catch (_) {}
          if (err) reject(err);
          else resolve();
        };
        const listener = (id, info) => {
          if (id !== tabId || !info) return;
          if (info.status === "loading") sawLoading = true;
          if (info.status === "complete" && sawLoading) finish();
        };
        const timer = setTimeout(() => finish(), Math.max(1000, timeoutMs || 15000));
        onUpdated.addListener(listener);
        Promise.resolve(chrome.tabs.update(tabId, { url })).then(
          async () => {
            // Same-document navigations (hash change) may never report a load.
            await sleep(300);
            if (done || sawLoading) return;
            try {
              const tab = await chrome.tabs.get(tabId);
              if (tab.status !== "loading") finish();
            } catch (_) {
              finish();
            }
          },
          (err) => finish(err),
        );
      });
    }

    async function llmPickCandidate(step, list) {
      if (typeof ctx.llmPick !== "function") return null;
      const prompt =
        "A recorded browser automation step no longer matches the page. Pick the element that best fulfils the step.\n" +
        `Step: ${stepSentence(step)}\n` +
        `Recorded target: ${JSON.stringify({ ...step.locator, xpath: undefined, css: undefined })}\n` +
        "Candidates (one per line, ref first):\n" +
        list.slice(0, 150).map(compactLine).join("\n") +
        '\nAnswer with only the ref (e.g. "@e12"), or "none" if no candidate fits.';
      try {
        const answer = String((await ctx.llmPick(prompt)) || "");
        const m = answer.match(/@?(e\d+)/);
        return m ? list.find((c) => c.ref === m[1]) || null : null;
      } catch (err) {
        log("[AutoDOM WF] llm heal failed:", err && err.message);
        return null;
      }
    }

    // Last resort: screenshot with numbered boxes on every on-screen control;
    // a vision model names the box that fulfils the step. The boxes are
    // needed in the screenshot itself, so with Features → overlayVisionMarks
    // off they are still drawn but removed right after the capture instead
    // of staying up while the model answers.
    async function visionPickCandidate(tabId, step, opts) {
      if (typeof ctx.visionPick !== "function" || typeof ctx.captureScreenshot !== "function") return null;
      const keepMarks = !(opts && opts.showMarks === false);
      try {
        const marked = await execLib(tabId, _pageWfMark, [120, step.locator && step.locator.bbox]);
        if (!marked || !marked.ok || !marked.marks.length) return null;
        let image;
        try {
          image = await ctx.captureScreenshot(tabId);
        } finally {
          if (!keepMarks) {
            try { await exec(tabId, _pageWfClearMarks, []); } catch (_) {}
          }
        }
        if (!image) return null;
        const lines = marked.marks.map((m) => {
          const name = m.accessibleName || m.label || m.placeholder || m.text || "";
          return `${m.n}: ${m.role || m.tag}${name ? ` "${String(name).slice(0, 60)}"` : ""}`;
        });
        const prompt =
          "The screenshot has red numbered boxes on the page's interactive elements. A recorded browser step no longer matches the page.\n" +
          `Step: ${stepSentence(step)}\n` +
          `Recorded target: ${JSON.stringify({ role: step.locator && step.locator.role, name: step.locator && (step.locator.accessibleName || step.locator.label || step.locator.text), tag: step.locator && step.locator.tag })}\n` +
          "Boxes:\n" + lines.join("\n") +
          '\nWhich box is the element the step should act on? Answer with only its number, or "none".';
        const answer = String((await ctx.visionPick({ prompt, image })) || "").trim();
        if (/^none\b/i.test(answer)) return null;
        const m = answer.match(/\b(\d{1,3})\b/);
        return m ? marked.marks.find((x) => x.n === Number(m[1])) || null : null;
      } catch (err) {
        log("[AutoDOM WF] vision heal failed:", err && err.message);
        return null;
      } finally {
        if (keepMarks) {
          try { await exec(tabId, _pageWfClearMarks, []); } catch (_) {}
        }
      }
    }

    async function healStep(tabId, step, opts) {
      const res = await execLib(tabId, _pageWfCandidates, [300]);
      const list = (res && res.candidates) || [];
      if (!list.length) return null;
      const pool = step.action === "fill" ? list.filter((c) => ["input", "textarea"].includes(c.tag) || c.role === "textbox") : list;
      const heuristic = pickHeuristic(step.locator || {}, pool.length ? pool : list);
      let chosen = heuristic && { candidate: heuristic.candidate, via: "heuristic", score: heuristic.score };
      if (!chosen) {
        const viaLlm = await llmPickCandidate(step, pool.length ? pool : list);
        if (viaLlm) chosen = { candidate: viaLlm, via: "llm" };
      }
      if (!chosen && opts && opts.vision === true) {
        const viaVision = await visionPickCandidate(tabId, step, { showMarks: opts.showMarks });
        if (viaVision) chosen = { candidate: viaVision, via: "vision" };
      }
      if (!chosen) return null;
      const acted = await execLib(tabId, _pageWfActOnRef, [chosen.candidate.ref, step]);
      if (!acted || !acted.ok) return null;
      return { ...acted, healedVia: chosen.via, score: chosen.score };
    }

    function serialized(fn) {
      const next = persistChain.then(fn, fn);
      persistChain = next.catch(() => {});
      return next;
    }

    const originOf = (url) => {
      try { return new URL(url).origin; } catch (_) { return ""; }
    };

    // What would reverse this step. Storage and cookie deltas only count when
    // the page stayed on the same origin (a new origin's keys are not ours).
    function undoOpsFor(step, res, before, after, diff) {
      const ops = [];
      if (["fill", "select", "check"].includes(step.action) && res && res.prev && res.prev.kind !== "none") {
        ops.push({
          type: "field",
          step: { action: step.action, locator: (res.after || step.locator), value: res.prev.value },
        });
      }
      const sameOrigin = before && after && originOf(before.url) && originOf(before.url) === originOf(after.url);
      if (diff && sameOrigin) {
        const local = (diff.localStorage && diff.localStorage.added) || [];
        const session = (diff.sessionStorage && diff.sessionStorage.added) || [];
        if (local.length || session.length) ops.push({ type: "storage", origin: originOf(after.url), local, session });
        const names = (diff.cookies && diff.cookies.added) || [];
        if (names.length) ops.push({ type: "cookies", url: after.url, names });
      }
      if (diff && diff.url) ops.push({ type: "navigation", from: diff.url.from, to: diff.url.to });
      return ops;
    }

    // Undo data is RAM-only (session storage): it can hold earlier field values.
    async function saveUndo(runId, info) {
      if (!storage.session) return;
      const got = await storage.session.get(UNDO_KEY);
      const map = (got && got[UNDO_KEY]) || {};
      map[runId] = { ...info, createdAt: Date.now() };
      const keep = Object.entries(map).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, MAX_UNDO_RUNS);
      await storage.session.set({ [UNDO_KEY]: Object.fromEntries(keep) });
    }
    async function getUndo(runId) {
      if (!storage.session) return null;
      const got = await storage.session.get(UNDO_KEY);
      return ((got && got[UNDO_KEY]) || {})[runId] || null;
    }

    // ── live run bookkeeping ──
    function trackRun(live) {
      runs.set(live.report.runId, live);
      currentRunId = live.report.runId;
      broadcast({ activeRunId: currentRunId });
    }
    // Finished runs stay in memory for 5 minutes (at most 20 of them);
    // run_get then reads the persisted history.
    function retireRun(runId) {
      unrefTimer(setTimeout(() => {
        const l = runs.get(runId);
        if (l && l.report.status !== "running") runs.delete(runId);
      }, FINISHED_TTL_MS));
      const finished = [...runs.entries()].filter(([, l]) => l.report.status !== "running");
      if (finished.length > MAX_FINISHED_LIVE) {
        finished.sort((a, b) => (a[1].report.finishedAt || 0) - (b[1].report.finishedAt || 0));
        for (const [id] of finished.slice(0, finished.length - MAX_FINISHED_LIVE)) runs.delete(id);
      }
      if (currentRunId === runId) {
        const still = [...runs.values()].filter((l) => l.report.status === "running");
        currentRunId = still.length ? still[still.length - 1].report.runId : null;
        broadcast({ activeRunId: currentRunId });
      }
    }
    function retireBatch(batchId) {
      unrefTimer(setTimeout(() => {
        const b = batches.get(batchId);
        if (b && b.finishedAt) batches.delete(batchId);
      }, FINISHED_TTL_MS));
      const finished = [...batches.entries()].filter(([, b]) => b.finishedAt);
      if (finished.length > MAX_FINISHED_LIVE) {
        finished.sort((a, b) => a[1].finishedAt - b[1].finishedAt);
        for (const [id] of finished.slice(0, finished.length - MAX_FINISHED_LIVE)) batches.delete(id);
      }
    }

    async function tabAlive(tabId) {
      try { await chrome.tabs.get(tabId); return true; } catch (_) { return false; }
    }

    // Dry run: resolve every step against the page without acting. Stops
    // checking once a step could change the page (click / key press) because
    // later targets may not exist yet; checkAll:true keeps going best-effort.
    async function runDry(wf, params, tab, values, closeIfOwned, flags) {
      const runId = newId("run");
      const report = {
        runId,
        workflowId: wf.id,
        workflowName: wf.name,
        trigger: params.trigger || "manual",
        ...(params.batchId ? { batchId: params.batchId } : {}),
        mode: "dry",
        status: "running",
        tabId: tab.id,
        startedAt: Date.now(),
        finishedAt: null,
        durationMs: null,
        healed: 0,
        steps: [],
        summary: null,
        error: null,
        note: "Dry run: nothing was clicked, typed or changed. Page loads at the start of the workflow are performed.",
      };
      const live = { report, cancel: false, paused: false, wf };
      trackRun(live);
      const visionLater = await visionAllowed(params, flags);
      const promise = (async () => {
        try {
          let canCheck = true;
          let leading = true;
          const timeout = Math.max(300, Math.min(15000, Number(params.stepTimeoutMs) || 1500));
          for (let i = 0; i < wf.steps.length; i++) {
            if (live.cancel) { report.status = "cancelled"; break; }
            if (live.tabClosed) { report.status = "failed"; report.error = "The run's tab was closed."; break; }
            const raw = wf.steps[i];
            const step = { ...raw, value: substitute(raw.value, values), url: substitute(raw.url, values) };
            if (raw.assert) step.assert = { ...raw.assert, value: substitute(raw.assert.value, values) };
            const entry = { index: i, action: step.action, target: step.action === "navigate" ? step.url : describeTarget(step.locator), ok: true };
            report.steps.push(entry);
            if (step.action === "navigate") {
              if (canCheck && leading && params.load !== false) {
                await navigateAndWait(tab.id, step.url);
                entry.note = "page loaded";
              } else {
                entry.unchecked = "navigates away; later steps depend on it";
                canCheck = params.checkAll === true ? canCheck : false;
              }
              continue;
            }
            if (["wait", "upload", "scroll"].includes(step.action)) continue;
            leading = false;
            if (!canCheck) { entry.unchecked = "depends on an earlier step that changes the page"; continue; }
            let found = null;
            const deadline = Date.now() + timeout;
            do {
              found = await execLib(tab.id, _pageWfResolveOnly, [step]);
              if (found && found.found) break;
              await sleep(250);
            } while (Date.now() < deadline);
            if (found && found.found) {
              entry.strategy = found.strategy;
              if (found.ambiguous) entry.ambiguous = true;
              if (found.note) entry.note = found.note;
              if (found.visible === false) entry.note = "found but not visible";
            } else {
              entry.ok = false;
              entry.error = step.action === "assert" ? (found && found.note) || "assertion does not hold" : "element not found";
              if (step.action !== "assert" && step.locator) {
                const cands = await execLib(tab.id, _pageWfCandidates, [300]);
                const pick = pickHeuristic(step.locator, (cands && cands.candidates) || []);
                if (pick) {
                  entry.wouldHealTo = describeTarget(pick.candidate);
                  entry.healScore = pick.score;
                } else if (visionLater) {
                  entry.maybeHealable = "no confident match; a vision model would be asked at run time";
                }
              }
            }
            if (MAY_CHANGE_PAGE.has(step.action) && params.checkAll !== true) canCheck = false;
          }
          const checked = report.steps.filter((s) => !s.unchecked && !["navigate", "wait", "upload", "scroll"].includes(s.action));
          const missing = checked.filter((s) => !s.ok);
          const healable = missing.filter((s) => s.wouldHealTo);
          report.summary = {
            steps: report.steps.length,
            checked: checked.length,
            unchecked: report.steps.filter((s) => s.unchecked).length,
            found: checked.length - missing.length,
            missing: missing.length,
            healable: healable.length,
          };
          if (report.status === "running") {
            report.status = !missing.length ? "dry_ok" : missing.length === healable.length ? "dry_needs_heal" : "dry_broken";
            if (missing.length) {
              report.error = `${missing.length} of ${checked.length} checked steps would not find their target` +
                (healable.length ? ` (${healable.length} could self-heal)` : "") + ".";
            }
          }
        } catch (err) {
          report.status = "failed";
          report.error = String((err && err.message) || err);
        } finally {
          report.finishedAt = Date.now();
          report.durationMs = report.finishedAt - report.startedAt;
          try { await serialized(() => pushRun(report, flags)); } catch (_) {}
          retireRun(runId);
          await closeIfOwned();
          if (typeof params.onDone === "function") {
            try { params.onDone(report); } catch (_) {}
          }
        }
        return report;
      })();
      live.promise = promise;
      return { ok: true, runId, promise, report };
    }

    // callCtx is the SW call context of the tool call that started the run.
    // It is only used to pick the tab here — never kept on the run, which
    // outlives the call.
    async function resolveRunTab(params, callCtx) {
      if (params && params.tabId != null) return chrome.tabs.get(params.tabId);
      if (params && params.newTab && typeof ctx.openRunTab === "function") return ctx.openRunTab();
      return ctx.getActiveTab(callCtx);
    }

    // Resolves (with null) when the calling tool call is cancelled, so a
    // handler that waits on a run can return early; the run keeps going.
    function whenAborted(signal) {
      if (!signal) return new Promise(() => {});
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((r) => signal.addEventListener("abort", () => r(null), { once: true }));
    }

    async function runWorkflow(wf, params, callCtx) {
      params = params || {};
      const errors = validateWorkflow(wf);
      if (errors.length) return { ok: false, error: "Invalid workflow", details: errors };
      const flags = await features();
      const requested = params.mode == null || params.mode === "" ? flags.defaultRunMode : params.mode;
      const mode = requested === "strict" ? "strict" : requested === "dry" ? "dry" : "heal";
      const { values, missing } = resolveVariables(wf, params.variables || {});
      // A dry run never types anything, so secrets are not needed for it.
      if (missing.length && mode !== "dry") {
        return { ok: false, error: `Missing values for variables: ${missing.join(", ")}`, missing };
      }
      const stepTimeoutMs = Math.max(500, Math.min(60000, Number(params.stepTimeoutMs) || 8000));
      let tab;
      try {
        tab = await resolveRunTab(params, callCtx);
      } catch (err) {
        return { ok: false, error: `Could not get a tab for the run: ${String((err && err.message) || err)}` };
      }
      if (!tab || tab.id == null) return { ok: false, error: "Could not get a tab for the run" };
      const openedHere = !!(params.newTab && params.tabId == null);
      const closeIfOwned = async () => {
        if (openedHere && !params.keepTab && typeof ctx.closeRunTab === "function") {
          try { await ctx.closeRunTab(tab.id); } catch (_) {}
        }
      };
      if (mode === "dry") return runDry(wf, params, tab, values, closeIfOwned, flags);
      const fast = flags.perfMode !== "balanced";
      const vision = mode === "heal" && (await visionAllowed(params, flags));
      const undoTracking = flags.undoTracking !== false;
      const runId = newId("run");
      const report = {
        runId,
        workflowId: wf.id,
        workflowName: wf.name,
        trigger: params.trigger || "manual",
        ...(params.batchId ? { batchId: params.batchId } : {}),
        mode,
        status: "running",
        tabId: tab.id,
        startedAt: Date.now(),
        finishedAt: null,
        durationMs: null,
        healed: 0,
        steps: [],
        error: null,
        note: "Stopping a run does not undo steps that already ran.",
      };
      const live = { report, cancel: false, paused: false, wf };
      trackRun(live);
      const undoSteps = [];
      const promise = (async () => {
        let dirty = false;
        let storedForMirror = null;
        // Step i's "after" digest doubles as step i+1's "before" (nothing
        // runs in between), except after a pause, when the user may have
        // changed the page.
        let carried = null;
        try {
          for (let i = 0; i < wf.steps.length; i++) {
            if (live.paused && !live.cancel) {
              carried = null;
              while (live.paused && !live.cancel && !live.tabClosed) {
                await sleep(250);
                if (!(await tabAlive(tab.id))) live.tabClosed = true;
              }
            }
            if (live.cancel) {
              report.status = "cancelled";
              break;
            }
            if (live.tabClosed) {
              report.status = "failed";
              report.error = `The run's tab was closed before step ${i + 1}.`;
              break;
            }
            const raw = wf.steps[i];
            const step = { ...raw, value: substitute(raw.value, values), url: substitute(raw.url, values) };
            if (raw.assert) step.assert = { ...raw.assert, value: substitute(raw.assert.value, values) };
            const started = Date.now();
            const entry = { index: i, action: step.action, target: step.action === "navigate" ? step.url : describeTarget(step.locator), ok: false };
            report.steps.push(entry);
            if (typeof params.onProgress === "function") params.onProgress(report);
            const before = params.diffs === false ? null : carried || (await safeDigest(tab.id));
            carried = null;
            let res;
            try {
              if (step.action === "navigate") {
                await navigateAndWait(tab.id, step.url);
                res = { ok: true };
              } else if (step.action === "wait") {
                await sleep(Math.min(60000, Number(step.ms) || 500));
                res = { ok: true };
              } else if (step.action === "upload") {
                res = { ok: true, skipped: true, note: raw.note || "file upload steps are not replayed" };
              } else {
                res = await execLib(tab.id, _pageWfRunStep, [step, step.timeoutMs || stepTimeoutMs]);
                if ((!res || !res.ok) && res && res.notFound && mode === "heal" && step.locator) {
                  const healed = await healStep(tab.id, step, { vision, showMarks: flags.overlayVisionMarks !== false });
                  if (healed) {
                    res = healed;
                    entry.healed = healed.healedVia;
                    report.healed++;
                    if (healed.after) {
                      raw.locator = { ...healed.after, healedAt: Date.now(), previous: { ...(raw.locator || {}), previous: undefined } };
                      dirty = true;
                    }
                  }
                }
                if (Number(step.waitMs) > 0) await settle(tab.id, Number(step.waitMs));
                else await settle(tab.id, 250, { fast });
              }
            } catch (err) {
              res = { ok: false, error: String((err && err.message) || err) };
            }
            entry.ok = !!(res && res.ok);
            entry.strategy = res && res.strategy;
            if (res && res.ambiguous) entry.ambiguous = true;
            if (res && res.skipped) entry.skipped = true;
            entry.durationMs = Date.now() - started;
            const after = params.diffs === false ? null : await safeDigest(tab.id);
            carried = after;
            const diff = diffDigest(before, after);
            if (diff) entry.diff = diff;
            if (entry.ok && !entry.skipped && undoTracking) {
              const ops = undoOpsFor(step, res, before, after, diff);
              if (ops.length) {
                undoSteps.push({ index: i, label: stepSentence(raw), ops });
                entry.undoable = ops.map((o) => o.type);
              } else if (res && res.prev && res.prev.kind === "none") {
                entry.irreversible = res.prev.reason;
              } else if (MAY_CHANGE_PAGE.has(step.action)) {
                entry.irreversible = "clicks and key presses cannot be undone automatically";
              }
            }
            if (!entry.ok) {
              entry.error = (res && res.error) || "step failed";
              if (step.optional) {
                entry.skipped = true;
                continue;
              }
              if (typeof ctx.captureScreenshot === "function") {
                try { entry.screenshot = await ctx.captureScreenshot(tab.id); } catch (_) {}
              }
              report.status = "failed";
              report.error = `Step ${i + 1} (${stepSentence(raw)}) failed: ${entry.error}`;
              break;
            }
          }
          if (report.status === "running") report.status = "passed";
        } catch (err) {
          report.status = "failed";
          report.error = String((err && err.message) || err);
        } finally {
          report.finishedAt = Date.now();
          report.durationMs = report.finishedAt - report.startedAt;
          try {
            await serialized(async () => {
              const stored = wf.id ? await getWorkflow(wf.id) : null;
              if (stored) {
                stored.stats = stored.stats || { runs: 0, passes: 0, heals: 0 };
                stored.stats.runs++;
                if (report.status === "passed") stored.stats.passes++;
                stored.stats.heals += report.healed;
                stored.lastRun = { runId, status: report.status, at: report.finishedAt, durationMs: report.durationMs };
                if (dirty) {
                  stored.steps = wf.steps;
                  storedForMirror = stored;
                }
                await putWorkflow(stored);
              }
              await pushRun(report, flags);
            });
            if (undoSteps.length && undoTracking) await saveUndo(runId, { tabId: tab.id, workflowName: wf.name, steps: undoSteps });
          } catch (err) {
            log("[AutoDOM WF] persist run failed:", err && err.message);
          }
          if (storedForMirror) emitSaved(storedForMirror, "heal", null);
          retireRun(runId);
          await closeIfOwned();
          if (typeof params.onDone === "function") {
            try { params.onDone(report); } catch (_) {}
          }
        }
        return report;
      })();
      live.promise = promise;
      return { ok: true, runId, promise, report };
    }

    // ── tool handlers ──
    async function wfSave(params, callCtx) {
      params = params || {};
      let wf;
      if (params.workflow || params.markdown) {
        wf = parseRoutine(params.workflow || params.markdown);
      } else {
        wf = lastDraft;
        if (!wf && storage.session) {
          const got = await storage.session.get(DRAFT_KEY);
          wf = got && got[DRAFT_KEY];
        }
        if (!wf) return { ok: false, error: "Nothing to save: record a workflow first or pass `workflow`." };
      }
      wf = JSON.parse(JSON.stringify(wf));
      if (!wf.id) wf.id = newId("wf");
      if (params.name) wf.name = params.name;
      if (params.description != null) wf.description = params.description;
      if (!wf.name) wf.name = "Untitled workflow";
      if (!Array.isArray(wf.variables)) wf.variables = [];
      if (params.parameterize !== false) extractVariables(wf.steps || [], wf.variables);
      wf.createdAt = wf.createdAt || Date.now();
      wf.stats = wf.stats || { runs: 0, passes: 0, heals: 0 };
      const errors = validateWorkflow(wf);
      if (errors.length) return { ok: false, error: "Invalid workflow", details: errors };
      await putWorkflow(wf);
      if (lastDraft && lastDraft.id === wf.id) lastDraft = null;
      emitSaved(wf, "save", callCtx);
      return { ok: true, saved: true, workflow: summarize(wf), full: wf };
    }

    async function wfRun(params, callCtx) {
      params = params || {};
      let wf = null;
      if (params.workflow) {
        wf = parseRoutine(params.workflow);
      } else {
        wf = await findWorkflow(params.id || params.name);
      }
      if (!wf) return { ok: false, error: `Workflow not found: ${params.id || params.name || "(none given)"}` };
      let started;
      try {
        started = await runWorkflow(wf, { ...params, trigger: params.trigger || "mcp" }, callCtx);
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
      if (!started.ok) return started;
      const waitMs = params.wait === false ? 0 : Math.max(0, Math.min(Number(params.waitMs) || 25000, 120000));
      if (!waitMs) return { ok: true, runId: started.runId, status: "running", hint: "Poll run_get { runId } for progress." };
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(null), waitMs); });
      const done = await Promise.race([started.promise, timeout, whenAborted(callCtx && callCtx.signal)]);
      clearTimeout(timer);
      if (!done) {
        return {
          ok: true,
          runId: started.runId,
          status: "running",
          progress: progressOf(started.report),
          hint: `Still running after ${waitMs} ms. Poll run_get { runId: "${started.runId}" }, or run_cancel to stop it.`,
        };
      }
      return { ok: ["passed", "dry_ok", "dry_needs_heal"].includes(done.status), ...done };
    }

    function progressOf(report) {
      const total = (runs.get(report.runId) && runs.get(report.runId).wf.steps.length) || report.steps.length;
      return { done: report.steps.filter((s) => s.ok).length, total, current: report.steps.length };
    }

    function batchView(b) {
      const items = b.items.map((it) => {
        const live = it.runId ? runs.get(it.runId) : null;
        const r = live ? live.report : it.report;
        return {
          index: it.index,
          workflow: it.workflow,
          runId: it.runId || null,
          status: r ? r.status : it.status,
          durationMs: r ? r.durationMs : null,
          healed: r ? r.healed : 0,
          error: (r && r.error) || it.error || null,
        };
      });
      const count = (st) => items.filter((i) => i.status === st).length;
      const running = items.filter((i) => i.status === "running" || i.status === "queued").length;
      const failed = items.filter((i) => ["failed", "dry_broken"].includes(i.status)).length;
      return {
        batchId: b.batchId,
        status: running ? "running" : b.cancel ? "cancelled" : failed ? "failed" : "passed",
        concurrency: b.concurrency,
        total: items.length,
        passed: count("passed") + count("dry_ok") + count("dry_needs_heal"),
        failed,
        running,
        runs: items,
      };
    }

    async function runMany(params, callCtx) {
      params = params || {};
      const specs = Array.isArray(params.runs) ? params.runs : [];
      if (!specs.length) return { ok: false, error: "runs must list at least one { id, variables? } entry" };
      if (specs.length > 20) return { ok: false, error: "At most 20 runs per batch" };
      const flags = await features();
      const concurrency = Math.max(1, Math.min(5, Number(params.concurrency) || Number(flags.parallelConcurrency) || 3));
      const batch = { batchId: newId("batch"), startedAt: Date.now(), concurrency, cancel: false, items: [] };
      specs.forEach((sp, index) =>
        batch.items.push({ index, workflow: String((sp && (sp.id || sp.name)) || "?"), status: "queued", runId: null }),
      );
      batches.set(batch.batchId, batch);
      let next = 0;
      // One item failing (workflow missing, no tab, a thrown error) marks
      // just that item failed; the batch always runs to the end.
      const runItem = async (i) => {
        const sp = specs[i] || {};
        const item = batch.items[i];
        try {
          const wf = await findWorkflow(sp.id || sp.name);
          if (!wf) { item.status = "failed"; item.error = `Workflow not found: ${item.workflow}`; return; }
          item.workflow = wf.name;
          const started = await runWorkflow(wf, {
            variables: { ...(params.variables || {}), ...(sp.variables || {}) },
            mode: sp.mode || params.mode,
            vision: params.vision,
            stepTimeoutMs: params.stepTimeoutMs,
            newTab: true,
            keepTab: params.keepTabs === true,
            trigger: "parallel",
            batchId: batch.batchId,
          });
          if (!started.ok) { item.status = "failed"; item.error = started.error; return; }
          item.runId = started.runId;
          item.status = "running";
          item.report = await started.promise;
          item.status = item.report.status;
        } catch (err) {
          item.status = "failed";
          item.error = String((err && err.message) || err);
        }
      };
      const worker = async () => {
        while (!batch.cancel && next < specs.length) await runItem(next++);
      };
      batch.promise = Promise.allSettled(Array.from({ length: Math.min(concurrency, specs.length) }, worker)).then(async () => {
        batch.finishedAt = Date.now();
        // Runs that never started because the batch was cancelled.
        for (const it of batch.items) if (it.status === "queued" || it.status === "running") it.status = it.status === "queued" ? "cancelled" : "failed";
        try { await flushRuns(); } catch (_) {}
        retireBatch(batch.batchId);
      });
      const waitMs = params.wait === false ? 0 : Math.max(0, Math.min(Number(params.waitMs) || 25000, 120000));
      if (waitMs) {
        let timer;
        const timeout = new Promise((r) => { timer = setTimeout(r, waitMs); });
        await Promise.race([batch.promise, timeout, whenAborted(callCtx && callCtx.signal)]);
        clearTimeout(timer);
      }
      const view = batchView(batch);
      return {
        ok: view.status !== "failed",
        ...view,
        ...(view.status === "running"
          ? { hint: `Still running. Poll run_get { batchId: "${batch.batchId}" } or stop it with run_cancel { batchId }.` }
          : {}),
      };
    }

    async function runUndo(params) {
      const info = await getUndo(params && params.runId);
      if (!info) {
        return { ok: false, error: "No undo data for this run. It is kept in memory for the 20 most recent runs and is lost when the browser closes." };
      }
      const tabId = params.tabId != null ? params.tabId : info.tabId;
      try { await chrome.tabs.get(tabId); } catch (_) {
        return { ok: false, error: "The tab this run used is gone, so its changes cannot be reversed from here." };
      }
      const wanted = new Set(["fields", "storage", "cookies"]);
      if (params.navigation === true) wanted.add("navigation");
      if (Array.isArray(params.include)) { wanted.clear(); params.include.forEach((x) => wanted.add(x)); }
      const only = Array.isArray(params.steps) ? new Set(params.steps.map(Number)) : null;
      const plan = info.steps.filter((st) => !only || only.has(st.index)).slice().reverse();
      const results = [];
      for (const st of plan) {
        for (const op of st.ops) {
          const group = UNDO_GROUP[op.type];
          const item = { step: st.index + 1, what: st.label, type: op.type };
          if (!wanted.has(group)) { results.push({ ...item, status: "skipped", reason: `${group} not included` }); continue; }
          if (params.dryRun === true) { results.push({ ...item, status: "would_undo" }); continue; }
          try {
            if (op.type === "field") {
              const r = await execLib(tabId, _pageWfRunStep, [op.step, 2000]);
              results.push({ ...item, status: r && r.ok ? "undone" : "failed", ...(r && r.ok ? {} : { reason: (r && r.error) || "target not found" }) });
            } else if (op.type === "storage") {
              const r = await execLib(tabId, _pageWfRemoveStorage, [op.origin, op.local, op.session]);
              results.push({ ...item, status: r && r.ok ? "undone" : "failed", detail: r && r.ok ? `${r.removed} key(s) removed` : (r && r.error) });
            } else if (op.type === "cookies") {
              let removed = 0;
              for (const name of op.names) {
                try { if (await chrome.cookies.remove({ url: op.url, name })) removed++; } catch (_) {}
              }
              results.push({ ...item, status: removed ? "undone" : "failed", detail: `${removed}/${op.names.length} cookie(s) removed` });
            } else if (op.type === "navigation") {
              await chrome.tabs.goBack(tabId);
              await settle(tabId, 300);
              results.push({ ...item, status: "undone", detail: `back from ${op.to}` });
            }
          } catch (err) {
            results.push({ ...item, status: "failed", reason: String((err && err.message) || err) });
          }
        }
      }
      const live = (await runGet({ runId: params.runId })) || {};
      const irreversible = (live.steps || [])
        .filter((x) => x.irreversible && (!only || only.has(x.index)))
        .map((x) => ({ step: x.index + 1, what: `${x.action} ${x.target}`, why: x.irreversible }));
      const undone = results.filter((r) => r.status === "undone").length;
      return {
        ok: !results.some((r) => r.status === "failed"),
        dryRun: params.dryRun === true,
        undone,
        results,
        irreversible,
        note: "Only changes AutoDOM can safely reverse (typed values, checkboxes, selects, storage keys and cookies it added, optionally navigation) are undone. Submitted forms, clicks and anything the site did server-side are not.",
      };
    }

    // A batch that already left memory is rebuilt from the run history.
    async function storedBatchView(batchId) {
      const list = (await loadRuns()).filter((r) => r.batchId === batchId);
      if (!list.length) return null;
      list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      const items = list.map((r, index) => ({ index, workflow: r.workflowName, runId: r.runId, status: r.status, report: r }));
      return { ...batchView({ batchId, concurrency: null, cancel: list.some((r) => r.status === "cancelled"), items }), fromHistory: true };
    }

    async function runGet(params) {
      if (params && params.batchId) {
        const b = batches.get(params.batchId);
        if (b) return { ok: true, ...batchView(b) };
        const stored = await storedBatchView(params.batchId);
        return stored ? { ok: true, ...stored } : { ok: false, error: `Batch not found: ${params.batchId}` };
      }
      const id = params && params.runId;
      const live = runs.get(id);
      if (live) return { ok: true, ...live.report, progress: progressOf(live.report), paused: live.paused };
      const stored = (await loadRuns()).find((r) => r.runId === id);
      return stored ? { ok: true, ...stored } : { ok: false, error: `Run not found: ${id}` };
    }

    async function runList(params) {
      const limit = Math.max(1, Math.min(200, Number(params && params.limit) || 20));
      const wfId = params && params.workflowId;
      const active = [...runs.values()]
        .filter((l) => l.report.status === "running")
        .map((l) => l.report.runId);
      const list = (await loadRuns())
        .filter((r) => !wfId || r.workflowId === wfId)
        .slice(0, limit)
        .map((r) => ({
          runId: r.runId,
          workflowId: r.workflowId,
          workflowName: r.workflowName,
          status: r.status,
          mode: r.mode,
          batchId: r.batchId,
          trigger: r.trigger,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          healed: r.healed,
          error: r.error,
        }));
      return { ok: true, active, runs: list };
    }

    function setRunState(params, patch) {
      if (params && params.batchId) {
        const b = batches.get(params.batchId);
        if (!b) return [];
        if (patch.cancel) b.cancel = true;
        const ids = b.items.map((it) => it.runId).filter(Boolean);
        return setRunState({ ...params, batchId: undefined, runIds: ids }, patch);
      }
      const ids = params && params.runIds ? params.runIds : params && params.runId ? [params.runId] : [...runs.keys()];
      const hit = [];
      for (const id of ids) {
        const live = runs.get(id);
        if (!live || live.report.status !== "running") continue;
        if (params && params.tabId != null && live.report.tabId !== params.tabId) continue;
        Object.assign(live, patch);
        hit.push(id);
      }
      return hit;
    }

    const handlers = {
      workflow_record_start: recordStart,
      workflow_record_stop: recordStop,
      workflow_save: wfSave,
      workflow_list: async () => {
        await ready;
        const map = await loadAll();
        const list = Object.values(map).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(summarize);
        return { ok: true, count: list.length, workflows: list, recording: rec ? { tabId: rec.tabId, steps: rec.steps.length } : null };
      },
      workflow_get: async (params) => {
        const wf = await findWorkflow(params && (params.id || params.name));
        return wf ? { ok: true, workflow: wf } : { ok: false, error: "Workflow not found" };
      },
      workflow_delete: async (params) => {
        const map = await loadAll();
        const wf = map[params && params.id];
        if (!wf) return { ok: false, error: "Workflow not found" };
        delete map[wf.id];
        await saveAll(map);
        return { ok: true, deleted: wf.id, name: wf.name };
      },
      workflow_run: wfRun,
      workflow_export: async (params) => {
        const wf = params && params.workflow ? parseRoutine(params.workflow) : await findWorkflow(params && (params.id || params.name));
        if (!wf) return { ok: false, error: "Workflow not found" };
        const format = String((params && params.format) || "markdown").toLowerCase();
        const base = slugify(wf.name, "workflow");
        if (format === "playwright") return { ok: true, format, filename: `${base}.spec.ts`, content: toPlaywright(wf) };
        if (format === "json") return { ok: true, format, filename: `${base}.autodom.json`, content: JSON.stringify(stripRuntime(wf), null, 2) };
        if (format === "markdown" || format === "md") return { ok: true, format: "markdown", filename: `${base}.md`, content: toMarkdown(wf) };
        return { ok: false, error: `Unknown format: ${format} (use playwright, markdown or json)` };
      },
      workflow_from_recording: async (params, callCtx) => {
        if (typeof ctx.getSessionRecording !== "function") return { ok: false, error: "session recording unavailable" };
        const recording = await ctx.getSessionRecording();
        const draft = fromSessionRecording(recording.actions || [], params || {});
        if (!draft.steps.length) return { ok: false, error: "The session recording has no replayable agent actions (navigate/click/type/select/press)." };
        lastDraft = draft;
        if (params && params.save) {
          await putWorkflow(draft);
          emitSaved(draft, "from_recording", callCtx);
        }
        return { ok: true, saved: !!(params && params.save), workflow: draft, markdown: toMarkdown(draft) };
      },
      workflow_run_many: runMany,
      run_undo: runUndo,
      run_get: runGet,
      run_list: runList,
      run_cancel: async (params) => {
        const hit = setRunState(params, { cancel: true, paused: false });
        const batchFound = !!(params && params.batchId && batches.has(params.batchId));
        return { ok: hit.length > 0 || batchFound, cancelled: hit, note: "Stopping a run does not undo steps that already ran." };
      },
      run_pause: async (params) => ({ ok: true, paused: setRunState(params, { paused: true }) }),
      run_resume: async (params) => ({ ok: true, resumed: setRunState(params, { paused: false }) }),
    };

    return {
      handlers,
      hydrate,
      ready,
      onRuntimeMessage,
      onTabRemoved,
      onNavigationCommitted,
      onNavigationCompleted,
      noteAgentTool,
      runWorkflow,
      findWorkflow,
      getWorkflow,
      listWorkflows: async () => Object.values(await loadAll()),
      isRecording: () => !!rec,
      activeRuns: () => [...runs.values()].filter((l) => l.report.status === "running").map((l) => l.report),
      pauseRuns: (tabId) => setRunState({ tabId }, { paused: true }),
      resumeRuns: (tabId) => setRunState({ tabId }, { paused: false }),
      activeRunId: () => currentRunId,
      recordingState: () => (rec ? { tabId: rec.tabId, steps: rec.steps.length } : null),
      flushRuns,
      clearRunHistory,
      clearDrafts,
      // Drop the in-memory run history (after the popup cleared storage).
      invalidateRunsCache: () => { runsCache = null; },
      // Page helpers for other SW features (compact snapshot, ref actions).
      page: { lib: _pageWfLib, candidates: _pageWfCandidates, actOnRef: _pageWfActOnRef },
    };
  }

  // ─── Agent catalog + tiers ───────────────────────────────────────────
  const CATALOG = [
    {
      name: "workflow_record_start",
      description: "Start teaching AutoDOM a task: records clicks, typing, selects, checkboxes, Enter/Escape and navigations on the active tab (user or agent driven) with robust multi-strategy locators. Optional url to open first.",
      parameters: { type: "object", properties: { url: { type: "string" }, tabId: { type: "integer" } } },
    },
    {
      name: "workflow_record_stop",
      description: "Stop the workflow recorder and return a draft workflow (typed values become {{variables}}, passwords become secrets). Pass save:true with a name to store it immediately.",
      parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, save: { type: "boolean" } } },
    },
    {
      name: "workflow_list",
      description: "List saved workflows with their variables, step counts and last run status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "workflow_run",
      description: "Replay a saved workflow deterministically (no LLM). In heal mode (default) a step whose element moved is matched heuristically and the healed locator is saved. Provide variables for {{placeholders}}.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Workflow id or exact name" },
          variables: { type: "object" },
          mode: { type: "string", enum: ["heal", "strict", "dry"], description: "heal (default) self-heals moved elements, strict fails on them, dry only checks that every target can be found" },
        },
        required: ["id"],
      },
    },
  ];
  const TIERS = {
    safeRead: new Set(["workflow_list", "workflow_record_stop"]),
    destructive: new Set(["workflow_run", "workflow_record_start"]),
  };

  globalThis.AutoDOMWorkflow = {
    makeEngine,
    catalog: CATALOG,
    tiers: TIERS,
    extractVariables,
    referencedVariables,
    resolveVariables,
    substitute,
    validateWorkflow,
    compactSteps,
    buildDraft,
    fromSessionRecording,
    scoreCandidate,
    pickHeuristic,
    compactLine,
    diffDigest,
    toPlaywright,
    toMarkdown,
    parseRoutine,
    playwrightLocator,
    summarize,
    slugify,
    describeTarget,
    stepSentence,
    _page: {
      _pageWfLib,
      _pageWfStartRecording,
      _pageWfStopRecording,
      _pageWfRunStep,
      _pageWfActOnRef,
      _pageWfCandidates,
      _pageWfDigest,
      _pageWfResolveOnly,
      _pageWfMark,
      _pageWfClearMarks,
      _pageWfRemoveStorage,
      _pageWfQuiet,
    },
  };
})();
