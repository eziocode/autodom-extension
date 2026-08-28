import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const panelCss = read("extension/content/chat-panel.css");
const panelJs = read("extension/content/chat-panel.js");
const popupJs = read("extension/popup/popup.js");
const popupHtml = read("extension/popup/popup.html");

// Select-all inside the chat surface used to sweep up every piece of UI
// chrome — header, context bar, welcome copy, suggestion chips, quick
// actions, keyboard hints, and the whole visually-hidden quick-prompt
// overlay — so a pasted "conversation" was mostly button text. The panel
// roots opt out of selection and only real content opts back in.
test("chat surfaces only expose real content to selection", () => {
  assert.match(
    panelCss,
    /#__autodom_chat_panel,\s*\n#__autodom_inline_overlay \{\s*\n\s*-webkit-user-select: none;\s*\n\s*user-select: none;/,
    "panel and inline overlay roots opt out of selection",
  );

  // Everything a user would actually want on the clipboard must opt back
  // in, or the fix would silently make transcripts uncopyable.
  for (const selector of [
    "#__autodom_chat_panel .autodom-chat-msg",
    "#__autodom_inline_overlay .autodom-chat-msg",
    "#__autodom_chat_panel .autodom-chat-context-text",
    "#__autodom_chat_panel .autodom-chat-input",
    "#__autodom_chat_panel .autodom-chat-msg.tool-result pre",
    "#__autodom_chat_panel .ai-tool-card-body",
  ]) {
    assert.ok(
      panelCss.includes(`${selector},`) || panelCss.includes(`${selector} {`),
      `${selector} is re-enabled for selection`,
    );
  }

  // Per-message chrome lives inside the selectable bubble, so it has to
  // opt out a second time.
  for (const selector of [
    "#__autodom_chat_panel .autodom-chat-msg .msg-copy-btn",
    "#__autodom_chat_panel .autodom-chat-msg .autodom-msg-meta",
    "#__autodom_chat_panel .autodom-chat-msg.tool-result summary",
    "#__autodom_chat_panel .ai-tool-card-head",
  ]) {
    assert.ok(
      panelCss.includes(selector),
      `${selector} stays out of copied text`,
    );
  }
});

// opacity/transform-only hiding leaves an element laid out: selectable,
// focusable via Tab, and exposed to assistive tech. Both the closed panel
// and the dismissed quick-prompt overlay have to leave the flow properly.
test("dismissed chat surfaces leave the selection and focus order", () => {
  assert.match(
    panelCss,
    /#__autodom_inline_overlay:not\(\.visible\),\s*\n\.autodom-inline-backdrop:not\(\.visible\) \{\s*\n\s*visibility: hidden;/,
    "hidden quick-prompt overlay and backdrop are visibility: hidden",
  );
  assert.match(
    panelCss,
    /#__autodom_chat_panel:not\(\.open\) \{\s*\n\s*visibility: hidden;/,
    "closed in-page panel is visibility: hidden",
  );
  // The fade/slide has to survive the change, so visibility is delayed
  // out and immediate in rather than being flipped bare.
  assert.match(
    panelCss,
    /visibility 0s linear 0\.32s/,
    "closed panel delays the visibility flip until the slide finishes",
  );

  // The side panel IS the window — it must never hide itself there.
  assert.match(
    panelJs,
    /transition: none !important;\s*\n(?:\s*\/\*[\s\S]*?\*\/\s*\n)?\s*visibility: visible !important;/,
    "side-panel overrides pin the panel visible",
  );
  assert.match(
    panelJs,
    /function closePanel\(\) \{[\s\S]{0,600}?if \(SIDE_PANEL_MODE\) return;/,
    "closePanel is a no-op in side-panel mode",
  );
});

// role="status"/aria-live regions must stay in the accessibility tree.
// Toggling aria-hidden around them announces unreliably (the text is set
// before the region re-enters the tree) and parks stale strings in the
// DOM for the next select-all to pick up.
test("ephemeral toasts clear their text instead of toggling aria-hidden", () => {
  for (const [label, source] of [
    ["chat panel", panelJs],
    ["popup", popupJs],
  ]) {
    assert.doesNotMatch(
      source,
      /toast\.setAttribute\("aria-hidden"/,
      `${label} toast does not toggle aria-hidden on its live region`,
    );
    assert.match(
      source,
      /toast\.textContent = ""/,
      `${label} toast clears its text on hide`,
    );
  }
  assert.doesNotMatch(
    popupHtml,
    /id="popupToast"[\s\S]{0,200}?aria-hidden/,
    "popup toast markup does not start out aria-hidden",
  );
  assert.match(
    popupJs,
    /statusEl\.textContent = ""/,
    "accent apply status clears its text on hide",
  );
});

// The side-panel override stylesheet is built as a JS template literal.
// A backtick inside it (easy to reach for when a comment mentions a class
// or property name) closes the string and turns the remainder into a
// tagged template call: `node --check` still passes, but at runtime the
// whole stylesheet fails to apply. When that happened alongside the
// closed-panel visibility rule, the side panel rendered completely blank.
test("side-panel override stylesheet has no stray template-literal syntax", () => {
  const opener = "sideStyle.textContent = `";
  const start = panelJs.indexOf(opener);
  assert.notEqual(start, -1, "side-panel override literal is present");
  const bodyStart = start + opener.length;
  const end = panelJs.indexOf("`;", bodyStart);
  assert.notEqual(end, -1, "side-panel override literal is terminated");
  const body = panelJs.slice(bodyStart, end);

  assert.equal(
    (body.match(/`/g) || []).length,
    0,
    "no backticks inside the side-panel override literal",
  );
  // ${...} is real interpolation here, so only the known substitution
  // may appear — anything else is a CSS brace being read as JS.
  for (const match of body.match(/\$\{[^}]*\}/g) || []) {
    assert.equal(
      match,
      "${PANEL_ID}",
      `unexpected interpolation ${match} in the side-panel override literal`,
    );
  }
  // The pin itself must survive, or Esc blanks the side panel.
  assert.match(body, /visibility: visible !important;/);
});
