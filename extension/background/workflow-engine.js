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
    const VERSION = 3;
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
      const res = act(hit.el, step);
      return {
        ...res,
        strategy: hit.strategy,
        ambiguous: !!hit.ambiguous,
        matches: hit.count,
        after: describe(hit.el),
      };
    };

    const actOnRef = (ref, step) => {
      const el = byRef(ref);
      if (!el) return { ok: false, error: "stale or unknown ref: " + ref };
      const res = act(el, step);
      return { ...res, strategy: "ref", after: describe(el) };
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
    let rec = null;
    const startRecording = (nonce) => {
      if (rec && rec.nonce === nonce) return { ok: true, alreadyRunning: true };
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
      return { ok: true, started: true };
    };
    const stopRecording = () => {
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
      digest,
      startRecording,
      stopRecording,
      isRecording: () => !!rec,
    };
    return { ok: true };
  }

  // Thin entry points (each assumes _pageWfLib ran first in the same world).
  function _pageWfStartRecording(nonce) {
    const L = globalThis.__autodomWfLib;
    return L ? L.startRecording(nonce) : { ok: false, error: "workflow lib not loaded" };
  }
  function _pageWfStopRecording() {
    const L = globalThis.__autodomWfLib;
    return L ? L.stopRecording() : { ok: true, wasRecording: false };
  }
  function _pageWfRunStep(step, timeoutMs) {
    const L = globalThis.__autodomWfLib;
    return L ? L.runStep(step, timeoutMs) : { ok: false, error: "workflow lib not loaded" };
  }
  function _pageWfActOnRef(ref, step) {
    const L = globalThis.__autodomWfLib;
    return L ? L.actOnRef(ref, step) : { ok: false, error: "workflow lib not loaded" };
  }
  function _pageWfCandidates(limit) {
    const L = globalThis.__autodomWfLib;
    return L ? { ok: true, candidates: L.candidates(limit) } : { ok: false, error: "workflow lib not loaded" };
  }
  function _pageWfDigest() {
    const L = globalThis.__autodomWfLib;
    return L ? L.digest() : null;
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
  const MAX_RUNS = 200;

  function makeEngine(ctx) {
    const storage = ctx.storage || (globalThis.chrome && chrome.storage);
    const log = ctx.log || (() => {});
    const exec = (tabId, fn, args) => ctx.executeInTab(tabId, fn, args || [], "ISOLATED");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let rec = null; // { nonce, tabId, steps, startedAt, startUrl, agentNavUrls }
    let lastDraft = null;
    const runs = new Map(); // runId → live run
    let persistTimer = null;

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
    async function loadRuns() {
      const got = await storage.local.get(RUNS_KEY);
      return (got && got[RUNS_KEY]) || [];
    }
    async function pushRun(report) {
      const list = await loadRuns();
      const slim = { ...report, steps: report.steps.map(({ screenshot, ...s }) => s) };
      const next = [slim, ...list.filter((r) => r.runId !== report.runId)].slice(0, MAX_RUNS);
      await storage.local.set({ [RUNS_KEY]: next });
    }
    function schedulePersistRec() {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        try {
          storage.session && storage.session.set({ [REC_KEY]: rec ? { ...rec } : null });
        } catch (_) {}
      }, 150);
    }

    async function hydrate() {
      try {
        if (!storage.session) return;
        const got = await storage.session.get(REC_KEY);
        if (got && got[REC_KEY] && got[REC_KEY].nonce) rec = got[REC_KEY];
      } catch (_) {}
    }

    async function injectRecorder(tabId) {
      await exec(tabId, _pageWfLib, []);
      return exec(tabId, _pageWfStartRecording, [rec.nonce]);
    }

    // ── recorder ──
    async function recordStart(params) {
      if (rec) return { ok: false, error: "A workflow recording is already running. Call workflow_record_stop first.", tabId: rec.tabId };
      const tab = params && params.tabId != null ? await chrome.tabs.get(params.tabId) : await ctx.getActiveTab();
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
      schedulePersistRec();
      try {
        await injectRecorder(tab.id);
      } catch (err) {
        const msg = String((err && err.message) || err);
        rec = null;
        schedulePersistRec();
        return { ok: false, error: `Could not start recorder on this page: ${msg}` };
      }
      return {
        ok: true,
        recording: true,
        tabId: tab.id,
        startUrl: rec.startUrl,
        hint: "Interact with the page (or drive it with tools). Navigation, clicks, typing, selects, checkboxes and Enter/Escape are captured. Call workflow_record_stop when done.",
      };
    }

    async function recordStop(params) {
      if (!rec) return { ok: false, error: "No workflow recording in progress" };
      const r = rec;
      rec = null;
      schedulePersistRec();
      try { await exec(r.tabId, _pageWfStopRecording, []); } catch (_) {}
      const draft = buildDraft({
        steps: r.steps,
        startUrl: r.startUrl,
        name: params && params.name,
        description: params && params.description,
        source: "recording",
      });
      lastDraft = draft;
      try { storage.session && (await storage.session.set({ "autodom.wf.lastDraft": draft })); } catch (_) {}
      let saved = false;
      if (params && params.save) {
        await putWorkflow(draft);
        saved = true;
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

    function onRuntimeMessage(message, sender) {
      if (!message || message.type !== "AUTODOM_WF_STEP") return false;
      if (!rec || message.nonce !== rec.nonce) return true;
      if (sender && sender.tab && sender.tab.id !== rec.tabId) return true;
      const step = message.step || {};
      if (!ACTIONS.has(step.action)) return true;
      pushStep(step);
      return true;
    }

    // Typed / bookmarked / agent-driven navigations become navigate steps;
    // link clicks and form submits are implied by the step that caused them.
    function onNavigationCommitted(details) {
      if (!rec || details.tabId !== rec.tabId || details.frameId !== 0) return;
      const tt = details.transitionType || "";
      const q = details.transitionQualifiers || [];
      if (/^(chrome|about|chrome-extension|devtools):/.test(details.url || "")) return;
      if (q.includes("forward_back")) return;
      const explicit = ["typed", "auto_bookmark", "generated", "keyword", "keyword_generated"].includes(tt) || q.includes("from_address_bar");
      pushStep({ action: "navigate", url: details.url, t: Date.now(), ...(explicit ? {} : { implied: true }) });
    }

    async function onNavigationCompleted(details) {
      if (!rec || details.tabId !== rec.tabId || details.frameId !== 0) return;
      try {
        await injectRecorder(details.tabId);
      } catch (err) {
        log("[AutoDOM WF] re-inject recorder failed:", err && err.message);
      }
    }

    function noteAgentTool(tool, params) {
      if (!rec) return;
      if ((tool === "navigate" || tool === "browser_navigate") && params && params.url) {
        pushStep({ action: "navigate", url: String(params.url), t: Date.now() });
      }
    }

    // ── runner ──
    async function injectLib(tabId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await exec(tabId, _pageWfLib, []);
          return true;
        } catch (err) {
          if (attempt === 2) throw err;
          await ctx.waitForTabComplete(tabId, 8000).catch(() => {});
          await sleep(250);
        }
      }
      return false;
    }

    async function safeDigest(tabId) {
      try {
        await injectLib(tabId);
        return await exec(tabId, _pageWfDigest, []);
      } catch (_) {
        return null;
      }
    }

    async function settle(tabId, ms) {
      await sleep(ms);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "loading") await ctx.waitForTabComplete(tabId, 15000);
      } catch (_) {}
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

    async function healStep(tabId, step) {
      const res = await exec(tabId, _pageWfCandidates, [300]);
      const list = (res && res.candidates) || [];
      if (!list.length) return null;
      const pool = step.action === "fill" ? list.filter((c) => ["input", "textarea"].includes(c.tag) || c.role === "textbox") : list;
      const heuristic = pickHeuristic(step.locator || {}, pool.length ? pool : list);
      let chosen = heuristic && { candidate: heuristic.candidate, via: "heuristic", score: heuristic.score };
      if (!chosen) {
        const viaLlm = await llmPickCandidate(step, pool.length ? pool : list);
        if (viaLlm) chosen = { candidate: viaLlm, via: "llm" };
      }
      if (!chosen) return null;
      const acted = await exec(tabId, _pageWfActOnRef, [chosen.candidate.ref, step]);
      if (!acted || !acted.ok) return null;
      return { ...acted, healedVia: chosen.via, score: chosen.score };
    }

    async function resolveRunTab(params) {
      if (params && params.tabId != null) return chrome.tabs.get(params.tabId);
      if (params && params.newTab && typeof ctx.openRunTab === "function") return ctx.openRunTab();
      return ctx.getActiveTab();
    }

    async function runWorkflow(wf, params) {
      params = params || {};
      const errors = validateWorkflow(wf);
      if (errors.length) return { ok: false, error: "Invalid workflow", details: errors };
      const { values, missing } = resolveVariables(wf, params.variables || {});
      if (missing.length) {
        return { ok: false, error: `Missing values for variables: ${missing.join(", ")}`, missing };
      }
      const mode = params.mode === "strict" ? "strict" : "heal";
      const stepTimeoutMs = Math.max(500, Math.min(60000, Number(params.stepTimeoutMs) || 8000));
      const tab = await resolveRunTab(params);
      const runId = newId("run");
      const report = {
        runId,
        workflowId: wf.id,
        workflowName: wf.name,
        trigger: params.trigger || "manual",
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
      runs.set(runId, live);
      const promise = (async () => {
        let dirty = false;
        try {
          for (let i = 0; i < wf.steps.length; i++) {
            while (live.paused && !live.cancel) await sleep(250);
            if (live.cancel) {
              report.status = "cancelled";
              break;
            }
            const raw = wf.steps[i];
            const step = { ...raw, value: substitute(raw.value, values), url: substitute(raw.url, values) };
            if (raw.assert) step.assert = { ...raw.assert, value: substitute(raw.assert.value, values) };
            const started = Date.now();
            const entry = { index: i, action: step.action, target: step.action === "navigate" ? step.url : describeTarget(step.locator), ok: false };
            report.steps.push(entry);
            if (typeof params.onProgress === "function") params.onProgress(report);
            const before = params.diffs === false ? null : await safeDigest(tab.id);
            let res;
            try {
              if (step.action === "navigate") {
                await chrome.tabs.update(tab.id, { url: step.url });
                await settle(tab.id, 300);
                res = { ok: true };
              } else if (step.action === "wait") {
                await sleep(Math.min(60000, Number(step.ms) || 500));
                res = { ok: true };
              } else if (step.action === "upload") {
                res = { ok: true, skipped: true, note: raw.note || "file upload steps are not replayed" };
              } else {
                await injectLib(tab.id);
                res = await exec(tab.id, _pageWfRunStep, [step, step.timeoutMs || stepTimeoutMs]);
                if ((!res || !res.ok) && res && res.notFound && mode === "heal" && step.locator) {
                  const healed = await healStep(tab.id, step);
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
                await settle(tab.id, Number(step.waitMs) || 250);
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
            const diff = diffDigest(before, after);
            if (diff) entry.diff = diff;
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
            const stored = wf.id ? await getWorkflow(wf.id) : null;
            if (stored) {
              stored.stats = stored.stats || { runs: 0, passes: 0, heals: 0 };
              stored.stats.runs++;
              if (report.status === "passed") stored.stats.passes++;
              stored.stats.heals += report.healed;
              stored.lastRun = { runId, status: report.status, at: report.finishedAt, durationMs: report.durationMs };
              if (dirty) stored.steps = wf.steps;
              await putWorkflow(stored);
            }
            await pushRun(report);
          } catch (err) {
            log("[AutoDOM WF] persist run failed:", err && err.message);
          }
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
    async function wfSave(params) {
      params = params || {};
      let wf;
      if (params.workflow || params.markdown) {
        wf = parseRoutine(params.workflow || params.markdown);
      } else {
        wf = lastDraft;
        if (!wf && storage.session) {
          const got = await storage.session.get("autodom.wf.lastDraft");
          wf = got && got["autodom.wf.lastDraft"];
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
      return { ok: true, saved: true, workflow: summarize(wf), full: wf };
    }

    async function wfRun(params) {
      params = params || {};
      let wf = null;
      if (params.workflow) {
        wf = parseRoutine(params.workflow);
      } else {
        wf = await findWorkflow(params.id || params.name);
      }
      if (!wf) return { ok: false, error: `Workflow not found: ${params.id || params.name || "(none given)"}` };
      const started = await runWorkflow(wf, { ...params, trigger: params.trigger || "mcp" });
      if (!started.ok) return started;
      const waitMs = params.wait === false ? 0 : Math.max(0, Math.min(Number(params.waitMs) || 25000, 120000));
      if (!waitMs) return { ok: true, runId: started.runId, status: "running", hint: "Poll run_get { runId } for progress." };
      const timeout = new Promise((r) => setTimeout(() => r(null), waitMs));
      const done = await Promise.race([started.promise, timeout]);
      if (!done) {
        return {
          ok: true,
          runId: started.runId,
          status: "running",
          progress: progressOf(started.report),
          hint: `Still running after ${waitMs} ms. Poll run_get { runId: "${started.runId}" }, or run_cancel to stop it.`,
        };
      }
      return { ok: done.status === "passed", ...done };
    }

    function progressOf(report) {
      const total = (runs.get(report.runId) && runs.get(report.runId).wf.steps.length) || report.steps.length;
      return { done: report.steps.filter((s) => s.ok).length, total, current: report.steps.length };
    }

    async function runGet(params) {
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
          trigger: r.trigger,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          healed: r.healed,
          error: r.error,
        }));
      return { ok: true, active, runs: list };
    }

    function setRunState(params, patch) {
      const ids = params && params.runId ? [params.runId] : [...runs.keys()];
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
      workflow_from_recording: async (params) => {
        if (typeof ctx.getSessionRecording !== "function") return { ok: false, error: "session recording unavailable" };
        const recording = await ctx.getSessionRecording();
        const draft = fromSessionRecording(recording.actions || [], params || {});
        if (!draft.steps.length) return { ok: false, error: "The session recording has no replayable agent actions (navigate/click/type/select/press)." };
        lastDraft = draft;
        if (params && params.save) await putWorkflow(draft);
        return { ok: true, saved: !!(params && params.save), workflow: draft, markdown: toMarkdown(draft) };
      },
      run_get: runGet,
      run_list: runList,
      run_cancel: async (params) => {
        const hit = setRunState(params, { cancel: true, paused: false });
        return { ok: hit.length > 0, cancelled: hit, note: "Stopping a run does not undo steps that already ran." };
      },
      run_pause: async (params) => ({ ok: true, paused: setRunState(params, { paused: true }) }),
      run_resume: async (params) => ({ ok: true, resumed: setRunState(params, { paused: false }) }),
    };

    return {
      handlers,
      hydrate,
      onRuntimeMessage,
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
          mode: { type: "string", enum: ["heal", "strict"] },
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
    },
  };
})();
