/**
 * AutoDOM — Active Session Border Overlay
 *
 * Injects a neon blue transparent border around the viewport
 * when the tab is part of an active MCP session or recording.
 * This visually distinguishes controlled/recorded tabs.
 */

(function () {
  const OVERLAY_ID = "__bmcp_session_border";

  function showBorder() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      border: 2px solid rgba(140, 140, 155, 0.35);
      border-radius: 0;
      transition: opacity 0.3s ease;
    `;

    // Add a quiet indicator away from the chat panel header.
    const badge = document.createElement("div");
    badge.style.cssText = `
      position: fixed;
      left: 10px;
      bottom: 10px;
      pointer-events: none;
      z-index: 2147483647;
      background: rgba(24, 24, 27, 0.4);
      color: rgba(232, 232, 236, 0.55);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 9px;
      font-weight: 500;
      padding: 3px 6px;
      border-radius: 999px;
      letter-spacing: 0.04em;
      border: 1px solid rgba(180, 180, 190, 0.12);
      box-shadow: none;
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    `;
    badge.textContent = "MCP";
    badge.id = OVERLAY_ID + "_badge";

    const style = document.createElement("style");
    style.id = OVERLAY_ID + "_style";
    style.textContent = `
      @media (prefers-reduced-motion: reduce) {
        #${OVERLAY_ID}, #${OVERLAY_ID}_badge {
          animation: none !important;
          transition: none !important;
        }
      }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(badge);
    showTakeoverButton();
  }

  // ── Take over / hand back ──
  // Pauses AutoDOM on this tab (agent calls wait, workflow runs pause)
  // so the user can act by hand, then resumes from the current state.
  //
  // Idle: a small, quiet icon button that stays out of the way and expands
  // to a label on hover/focus. In control: a calm amber pill that says so
  // and offers "Hand back". Drag it anywhere if it sits on something you
  // need; the position is remembered. Lives in a closed shadow root so page
  // CSS cannot restyle it and the page's own scripts cannot reach it.
  const TAKEOVER_ID = OVERLAY_ID + "_takeover";
  const POS_KEY = "autodom.takeoverPos";
  let takeoverOn = false;
  let takeoverUi = null; // { host, render }

  const ICON_PAUSE =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';
  const ICON_PLAY =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>';

  const TAKEOVER_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; z-index: 2147483647; left: 54px; bottom: 10px;
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --bg: rgba(255,255,255,.82); --fg: #3b3b44; --bd: rgba(60,60,70,.22); --accent: #7a4d00; --accent-bg: rgba(255,247,230,.97); --accent-bd: rgba(200,130,10,.6);
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg: rgba(30,30,34,.78); --fg: #d4d4da; --bd: rgba(200,200,215,.2); --accent: #f2c46d; --accent-bg: rgba(44,36,22,.97); --accent-bd: rgba(245,190,90,.55); }
    }
    button {
      all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 0;
      height: 26px; min-width: 26px; padding: 0 6px; border-radius: 13px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--bd);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      cursor: pointer; opacity: .5; user-select: none; touch-action: none;
      transition: opacity .15s ease, background .15s ease, border-color .15s ease;
    }
    .ic { display: inline-flex; flex: none; }
    .label { max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width .18s ease, margin .18s ease; margin-left: 0; }
    button:hover, button:focus-visible { opacity: 1; }
    button:hover .label, button:focus-visible .label { max-width: 220px; margin-left: 6px; margin-right: 2px; }
    button:focus-visible { outline: 2px solid var(--accent-bd); outline-offset: 2px; }
    .on button { opacity: 1; color: var(--accent); background: var(--accent-bg); border-color: var(--accent-bd); box-shadow: 0 1px 6px rgba(0,0,0,.18); }
    .on .label { max-width: 220px; margin-left: 6px; margin-right: 2px; }
    .dragging button { cursor: grabbing; opacity: 1; transition: none; }
    @media (prefers-reduced-motion: reduce) { button, .label { transition: none; } }
    @media print { .wrap { display: none; } }
  `;

  function clampPos(x, y, w, h) {
    return {
      x: Math.max(4, Math.min(window.innerWidth - w - 4, x)),
      y: Math.max(4, Math.min(window.innerHeight - h - 4, y)),
    };
  }

  function showTakeoverButton() {
    if (takeoverUi && document.getElementById(TAKEOVER_ID)) return;
    const host = document.createElement("div");
    host.id = TAKEOVER_ID;
    host.setAttribute("data-autodom-ui", "");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = TAKEOVER_CSS;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-autodom-ui", "");
    const ic = document.createElement("span");
    ic.className = "ic";
    const label = document.createElement("span");
    label.className = "label";
    btn.append(ic, label);
    wrap.appendChild(btn);
    root.append(style, wrap);

    function render() {
      ic.innerHTML = takeoverOn ? ICON_PLAY : ICON_PAUSE;
      label.textContent = takeoverOn ? "In control · Hand back" : "Take over";
      wrap.classList.toggle("on", takeoverOn);
      btn.setAttribute("aria-pressed", String(takeoverOn));
      btn.setAttribute("aria-label", takeoverOn ? "Hand control back to AutoDOM" : "Take over: pause AutoDOM on this tab");
      btn.title = takeoverOn
        ? "Let AutoDOM continue from the page as it is now"
        : "Pause AutoDOM on this tab so you can act by hand. Pausing does not undo steps that already ran. Drag to move.";
    }
    takeoverUi = { host, render };
    render();

    // Remembered position (extension storage, not the page's).
    try {
      chrome.storage.local.get(POS_KEY, (res) => {
        void chrome.runtime.lastError;
        const p = res && res[POS_KEY];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          const c = clampPos(p.x, p.y, 40, 26);
          wrap.style.left = c.x + "px";
          wrap.style.top = c.y + "px";
          wrap.style.bottom = "auto";
        }
      });
    } catch (_) {}

    // Click toggles; a drag of more than a few pixels moves the button instead.
    let drag = null;
    let justDragged = false;
    btn.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const r = wrap.getBoundingClientRect();
      drag = { sx: ev.clientX, sy: ev.clientY, ox: r.left, oy: r.top, w: r.width, h: r.height, moved: false, id: ev.pointerId };
      try { btn.setPointerCapture(ev.pointerId); } catch (_) {}
    });
    btn.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.sx;
      const dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      wrap.classList.add("dragging");
      const c = clampPos(drag.ox + dx, drag.oy + dy, drag.w, drag.h);
      wrap.style.left = c.x + "px";
      wrap.style.top = c.y + "px";
      wrap.style.bottom = "auto";
    });
    const endDrag = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      wrap.classList.remove("dragging");
      try { btn.releasePointerCapture(ev.pointerId); } catch (_) {}
      if (moved) {
        justDragged = true;
        setTimeout(() => (justDragged = false), 0);
        const r = wrap.getBoundingClientRect();
        try { chrome.storage.local.set({ [POS_KEY]: { x: Math.round(r.left), y: Math.round(r.top) } }); } catch (_) {}
      }
    };
    btn.addEventListener("pointerup", endDrag);
    btn.addEventListener("pointercancel", endDrag);

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (justDragged) return;
      const next = !takeoverOn;
      try {
        chrome.runtime.sendMessage({ type: "AUTODOM_TAKEOVER", on: next }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.ok) {
            takeoverOn = next;
            render();
          }
        });
      } catch (_) {}
    });

    document.documentElement.appendChild(host);
    try {
      chrome.runtime.sendMessage({ type: "AUTODOM_TAKEOVER_QUERY" }, (res) => {
        void chrome.runtime.lastError;
        takeoverOn = !!(res && res.takeover);
        render();
      });
    } catch (_) {}
  }

  function hideBorder() {
    const overlay = document.getElementById(OVERLAY_ID);
    const badge = document.getElementById(OVERLAY_ID + "_badge");
    const style = document.getElementById(OVERLAY_ID + "_style");
    if (overlay) overlay.remove();
    if (badge) badge.remove();
    if (style) style.remove();
    // Keep the hand-back control visible while the user is in control.
    if (takeoverUi && !takeoverOn) {
      takeoverUi.host.remove();
      takeoverUi = null;
    }
  }

  // Listen for messages from the service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SHOW_SESSION_BORDER") {
      showBorder();
    }
    if (message.type === "HIDE_SESSION_BORDER") {
      hideBorder();
    }
    if (message.type === "AUTODOM_TAKEOVER_STATE") {
      takeoverOn = !!message.on;
      if (takeoverUi) takeoverUi.render();
    }
  });

  // Expose for direct injection
  window.__bmcp_showBorder = showBorder;
  window.__bmcp_hideBorder = hideBorder;
})();
