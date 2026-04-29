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
  }

  function hideBorder() {
    const overlay = document.getElementById(OVERLAY_ID);
    const badge = document.getElementById(OVERLAY_ID + "_badge");
    const style = document.getElementById(OVERLAY_ID + "_style");
    if (overlay) overlay.remove();
    if (badge) badge.remove();
    if (style) style.remove();
  }

  // Listen for messages from the service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SHOW_SESSION_BORDER") {
      showBorder();
    }
    if (message.type === "HIDE_SESSION_BORDER") {
      hideBorder();
    }
  });

  // Expose for direct injection
  window.__bmcp_showBorder = showBorder;
  window.__bmcp_hideBorder = hideBorder;
})();
