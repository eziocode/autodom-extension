// Marks this page as the side-panel host so chat-panel.js (shared
// with the content-script build) renders full-window instead of
// injecting into a host page. Must run before chat-panel.js loads.
window.__AUTODOM_SIDE_PANEL_MODE__ = true;

// Liveness + close channel with the service worker. The SW uses the
// presence of this port to know the side panel is open in this
// window, and posts AUTODOM_SIDEPANEL_CLOSE on a second Cmd/Ctrl+
// Shift+K press so we can self-close (Chrome has no sidePanel.close
// API). Reconnects automatically if the SW restarts.
(function connectAutodomSidePanelPort() {
  let port = null;
  function connect() {
    try {
      port = chrome.runtime.connect({ name: "autodom-sidepanel" });
    } catch (_) {
      // SW restarting — retry shortly.
      setTimeout(connect, 250);
      return;
    }
    try {
      // Resolve window id asynchronously and announce ourselves so
      // the SW can key its port registry by windowId.
      chrome.windows.getCurrent({}, (win) => {
        try {
          port.postMessage({
            type: "AUTODOM_SIDEPANEL_HELLO",
            windowId: win && win.id,
          });
        } catch (_) {
          /* port may have died between get + post */
        }
      });
    } catch (_) {
      /* getCurrent unavailable — port still works as liveness */
    }
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === "AUTODOM_SIDEPANEL_CLOSE") {
        try {
          window.close();
        } catch (_) {
          /* nothing else we can do */
        }
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // SW restarted; reconnect so a future toggle still finds us.
      setTimeout(connect, 250);
    });
  }
  connect();
})();
