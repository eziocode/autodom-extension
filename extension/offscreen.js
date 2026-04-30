/**
 * AutoDOM offscreen keepalive document.
 *
 * When enabled, this sends a lightweight heartbeat to the service worker so
 * the worker stays warm during long MCP sessions.
 */

setInterval(() => {
  try {
    chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
  } catch (_) {}
}, 20_000);
