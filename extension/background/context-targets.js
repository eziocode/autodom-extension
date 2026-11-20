// Shared frame discovery. All page code runs in the extension's isolated world.
(function () {
  function scopeOf(params) {
    const scope = {};
    for (const key of ["frameId", "documentId", "hostPath"]) {
      if (params?.[key] !== undefined) scope[key] = params[key];
    }
    return scope;
  }

  async function injectionTarget(tabId, scope = {}) {
    const { frameId, documentId } = scope;
    if (frameId !== undefined && (!Number.isInteger(frameId) || frameId < 0)) {
      throw new Error("frameId must be a non-negative integer");
    }
    if (documentId !== undefined) {
      if (typeof documentId !== "string" || !documentId) throw new Error("Invalid documentId");
      if (frameId !== undefined) {
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId }).catch(() => null);
        if (!frame || frame.documentId !== documentId) {
          throw new Error("Stale frame document. Inspect the page again for a current target.");
        }
      }
      // A navigation after the check cannot redirect this injection to a new document.
      return { tabId, documentIds: [documentId] };
    }
    return { tabId, frameIds: [frameId ?? 0] };
  }

  // Serialized by chrome.scripting. Bounds apply to DOM traversal as well as output.
  function pageScan({ mode, selector, text, limit, isChild, maxDepth = 8, hostPath, allowMissingHost, action }) {
    const rows = [];
    const hosts = [];
    let visited = 0;
    let truncated = false;
    const maxNodes = mode === "highlights" ? 1800 : 12000;
    const closedHosts = [];
    const hiddenChildren = [];
    const excluded = '[data-autodom-ui],[id^="__autodom"],[id^="__bmcp"],script,style,noscript';
    const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
    function visible(el) {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (el.checkVisibility
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : getComputedStyle(el).visibility !== "hidden");
    }
    function eligible(el) {
      if (el.closest("[inert]")) return false;
      if (action !== "hover" && el.closest(':disabled,[aria-disabled="true"]')) return false;
      if (action === "fill") return !el.readOnly && (el.isContentEditable || el.matches("input,textarea,select"));
      return action !== "select" || el.localName === "select" || typeof el.click === "function";
    }
    function frameIndex(parent, child) {
      for (let i = 0; i < parent.length; i++) if (parent[i] === child) return i;
      return -1;
    }
    function locator(el, root) {
      if (el.id && el.id.length < 90) {
        const id = "#" + CSS.escape(el.id);
        if (root.querySelectorAll(id).length === 1) return id;
      }
      const path = [];
      for (let node = el; node; node = node.parentElement) {
        const tag = CSS.escape(node.localName);
        let index = 1;
        for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.localName === node.localName) index++;
        }
        path.unshift(tag + ":nth-of-type(" + index + ")");
        const candidate = path.join(" > ");
        if (candidate.length > 512) return null;
        const found = root.querySelectorAll(candidate);
        if (found.length === 1 && found[0] === el) return candidate;
      }
      return null;
    }

    function scan(root, path, inactiveHost = false) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) { return el.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
      });
      let sampled = 0;
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (++visited > maxNodes || rows.length >= limit) { truncated = true; break; }
        const queried = mode === "query";
        if (action && (el.localName === "iframe" || el.localName === "frame") && (inactiveHost || !visible(el) || el.closest("[inert]"))) {
          const index = frameIndex(window, el.contentWindow);
          if (index >= 0) hiddenChildren.push(index);
        }
        const matches = queried
          ? ((selector && el.matches(selector)) || (text && Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.includes(text))))
          : mode === "highlights" && sampled < 2 && (isChild || path.length) && el.matches(interactive);
        if (matches) {
          const shown = visible(el);
          if (action ? !inactiveHost && shown && eligible(el) : queried || shown) {
            const css = queried && selector && selector.length <= 512 && el.matches(selector) && root.querySelectorAll(selector).length === 1
              ? selector : locator(el, root);
            if (!css) truncated = true;
            const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, queried ? 200 : 64);
            const sensitive = el.type === "password" || /password|token|secret|one-time-code|cc-number|cc-csc/i.test([el.name, el.id, el.autocomplete].join(" "));
            rows.push({ tag: el.localName, text: queried ? (el.textContent || "").trim().slice(0, 200) : label,
              ...(queried && { label, value: !sensitive && el.value ? String(el.value).slice(0, 200) : undefined }),
              id: el.id || undefined, visible: shown,
              hostPath: path, selector: css, ...(css ? {} : { reason: "locator length limit" }) });
            sampled++;
          }
        }
        // Chrome can identify a closed custom-element root from the isolated
        // world. Report only its host; inspection/action uses open roots.
        if (!el.shadowRoot && el.localName.includes("-") && !hostPath && closedHosts.length < 8) {
          const closed = globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el);
          if (closed?.mode === "closed") {
            const host = locator(el, root);
            if (host) closedHosts.push([...path, host]);
            else truncated = true;
          }
        }
        if (el.shadowRoot && !hostPath) {
          const host = locator(el, root);
          if (!host || path.length >= maxDepth || hosts.length >= 32) { truncated = true; continue; }
          const next = [...path, host];
          hosts.push({ hostPath: next, tag: el.localName, id: el.id || undefined, childElementCount: el.shadowRoot.childElementCount,
            ...(mode === "hosts" && { className: typeof el.className === "string" ? el.className.slice(0, 100) : undefined,
              innerElementCount: el.shadowRoot.querySelectorAll("*").length }) });
          scan(el.shadowRoot, next, inactiveHost || (action && !!el.closest("[inert]")));
          if (visited > maxNodes) break;
        }
      }
    }
    try {
      let root = document;
      if (hostPath !== undefined) {
        if (!Array.isArray(hostPath) || hostPath.some(s => typeof s !== "string" || !s.trim())) throw new Error("Invalid hostPath");
        for (const selector of hostPath) {
          const hosts = root.querySelectorAll(selector);
          if (!hosts.length && allowMissingHost) return { rows: [], hosts: [], truncated: false };
          if (hosts.length !== 1) throw new Error("Missing or ambiguous shadow host: " + selector);
          root = hosts[0].shadowRoot;
          if (!root) throw new Error("Shadow root inaccessible or closed: " + selector);
        }
      }
      if (selector) root.querySelector(selector); // Validate even on an empty document.
      scan(root, hostPath || []);
      return { rows, hosts, closedHosts, truncated, title: document.title.slice(0, 80),
        ...(action && { hiddenChildren, childIndex: isChild ? frameIndex(window.parent, window) : -1 }) };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function collect(tabId, opts = {}) {
    const mode = opts.mode || "highlights";
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 24));
    const frameLimit = mode === "highlights" ? 8 : 24;
    const contextHighlights = [];
    let searchComplete = true;
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (!Array.isArray(frames) || !frames.length) throw new Error("Frame inventory unavailable");
    } catch (err) {
      searchComplete = false;
      frames = [{ frameId: 0 }];
      contextHighlights.push({ kind: "inaccessible", reason: "Frame inventory unavailable" });
    }
    const scoped = opts.frameId !== undefined || opts.documentId !== undefined;
    if (scoped) {
      frames = frames.filter(f => (opts.frameId === undefined || f.frameId === opts.frameId) &&
        (opts.documentId === undefined || f.documentId === opts.documentId));
      if (!frames.length) return { searchComplete: false, error: "Stale or missing frame document. Inspect the page again.", contextHighlights };
    }
    frames.sort((a, b) => a.frameId - b.frameId);
    if (frames.length > frameLimit) {
      searchComplete = false;
      contextHighlights.push({ kind: "truncated", omittedFrames: frames.length - frameLimit });
    }
    const observations = await Promise.all(frames.slice(0, frameLimit).map(async frame => {
      const info = { frameId: frame.frameId, ...(frame.parentFrameId >= 0 && { parentFrameId: frame.parentFrameId }),
        ...(frame.documentId && { documentId: frame.documentId }) };
      try {
        const [injected] = await chrome.scripting.executeScript({
          target: frame.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [frame.frameId] },
          world: "ISOLATED", func: pageScan,
          args: [{ mode, selector: opts.selector || "", text: opts.text || "", limit, isChild: frame.frameId !== 0, allowMissingHost: !scoped, action: opts.action || null,
            ...(opts.maxDepth !== undefined && { maxDepth: opts.maxDepth }), ...(opts.hostPath !== undefined && { hostPath: opts.hostPath }) }],
        });
        if (!Array.isArray(injected?.result?.rows) || !Array.isArray(injected?.result?.hosts) || injected.error || injected.result.error) throw new Error(injected?.result?.error || injected?.error?.message || "Frame unavailable");
        if (injected.documentId) info.documentId = injected.documentId;
        return { info, page: injected.result };
      } catch (err) {
        return { info, error: err.message };
      }
    }));
    const results = [];
    const hosts = [];
    const highlightLimit = 32;
    let highlightsClipped = false;
    let resultsClipped = false;
    const add = row => {
      if (contextHighlights.length < highlightLimit) contextHighlights.push(row);
      else highlightsClipped = true;
    };
    const byFrame = new Map(observations.map(observation => [observation.info.frameId, observation]));
    function hiddenFrame(frameId) {
      let entry = byFrame.get(frameId);
      while (entry?.info.parentFrameId >= 0) {
        const parent = byFrame.get(entry.info.parentFrameId);
        if (parent?.page?.hiddenChildren?.includes(entry.page?.childIndex)) return true;
        entry = parent;
      }
      return false;
    }
    for (const { info, page, error } of observations) {
      if (opts.action && hiddenFrame(info.frameId)) continue;
      if (error) {
        searchComplete = false;
        add({ kind: "inaccessible", ...info, reason: error.slice(0, 180) });
        continue;
      }
      if (page.truncated || page.closedHosts?.length) searchComplete = false;
      if (info.frameId) {
        const frame = frames.find(frame => frame.frameId === info.frameId);
        let url;
        try {
          const parsed = new URL(frame.url);
          url = ["http:", "https:"].includes(parsed.protocol) ? (parsed.origin + parsed.pathname).slice(0, 120)
            : parsed.protocol === "about:" ? parsed.href.slice(0, 80) : parsed.protocol;
        } catch (_) {}
        add({ kind: "frame", ...info, url, label: page.title || undefined });
      }
      for (const hostPath of page.closedHosts || []) {
        add({ kind: "inaccessible", ...info, hostPath, reason: "Closed shadow root" });
      }
      if (page.truncated) add({ kind: "truncated", ...info });
      for (const host of page.hosts) {
        hosts.push({ ...info, ...host });
        if (mode === "hosts" || !page.rows.some(row => row.hostPath.length === host.hostPath.length && row.hostPath.every((s, i) => s === host.hostPath[i]))) {
          add({ kind: "shadow", ...info, hostPath: host.hostPath });
        }
      }
      for (const row of page.rows) {
        const { selector, hostPath, ...details } = row;
        const target = selector && { frameId: info.frameId, ...(info.documentId && { documentId: info.documentId }), hostPath, selector };
        const kind = hostPath.length ? "shadow" : info.frameId ? "frame" : "document";
        if (mode === "query") {
          if (!target) searchComplete = false;
          if (results.length < limit) results.push({ ...details, ...info, hostPath, target,
            context: [info.frameId ? 'iframe[frameId=' + info.frameId + ']' : "main", ...hostPath].join(" >>> ") });
          else resultsClipped = true;
        }
        if (kind !== "document") add({ kind, tag: row.tag, label: (row.label || row.text).slice(0, 64), target, ...(!target && { ...info, hostPath }) });
      }
    }
    if (resultsClipped) {
      searchComplete = false;
      add({ kind: "truncated", reason: "Query result limit" });
    }
    if (highlightsClipped) contextHighlights.push({ kind: "truncated", reason: "Highlight limit" });
    const failed = (scoped || observations.every(o => o.error)) && observations.find(o => o.error);
    return { results, hosts, contextHighlights, searchComplete, ...(failed && { error: failed.error }) };
  }
  globalThis.AutoDOMContext = { collect, pageScan, scopeOf, injectionTarget };
})();
