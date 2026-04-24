// Marks this page as the side-panel host so chat-panel.js (shared
// with the content-script build) renders full-window instead of
// injecting into a host page. Must run before chat-panel.js loads.
window.__AUTODOM_SIDE_PANEL_MODE__ = true;
