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
  const TAKEOVER_ID = OVERLAY_ID + "_takeover";
  let takeoverOn = false;

  function renderTakeover(btn) {
    btn.textContent = takeoverOn ? "You're in control · Hand back" : "Take over";
    btn.title = takeoverOn
      ? "Let AutoDOM continue from the page as it is now"
      : "Pause AutoDOM on this tab and act by hand. Pausing does not undo steps that already ran.";
    btn.style.background = takeoverOn ? "rgba(217, 119, 6, 0.92)" : "rgba(24, 24, 27, 0.72)";
  }

  function showTakeoverButton() {
    if (document.getElementById(TAKEOVER_ID)) return;
    const btn = document.createElement("button");
    btn.id = TAKEOVER_ID;
    btn.type = "button";
    btn.setAttribute("data-autodom-ui", "");
    btn.style.cssText = `
      position: fixed;
      left: 48px;
      bottom: 8px;
      z-index: 2147483647;
      pointer-events: auto;
      color: #f4f4f5;
      font: 500 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid rgba(180, 180, 190, 0.25);
      cursor: pointer;
    `;
    renderTakeover(btn);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const next = !takeoverOn;
      try {
        chrome.runtime.sendMessage({ type: "AUTODOM_TAKEOVER", on: next }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.ok) {
            takeoverOn = next;
            renderTakeover(btn);
          }
        });
      } catch (_) {}
    });
    document.documentElement.appendChild(btn);
    try {
      chrome.runtime.sendMessage({ type: "AUTODOM_TAKEOVER_QUERY" }, (res) => {
        void chrome.runtime.lastError;
        takeoverOn = !!(res && res.takeover);
        renderTakeover(btn);
      });
    } catch (_) {}
  }

  function hideBorder() {
    const overlay = document.getElementById(OVERLAY_ID);
    const badge = document.getElementById(OVERLAY_ID + "_badge");
    const style = document.getElementById(OVERLAY_ID + "_style");
    const takeover = document.getElementById(TAKEOVER_ID);
    if (overlay) overlay.remove();
    if (badge) badge.remove();
    if (style) style.remove();
    // Keep the hand-back control visible while the user is in control.
    if (takeover && !takeoverOn) takeover.remove();
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
      const btn = document.getElementById(TAKEOVER_ID);
      if (btn) renderTakeover(btn);
    }
  });

  // Expose for direct injection
  window.__bmcp_showBorder = showBorder;
  window.__bmcp_hideBorder = hideBorder;
})();
