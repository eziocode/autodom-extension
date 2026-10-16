// Incremental interactive snapshots (Playwright MCP's `[unchanged]` idea).
// Refs (@eN) are stable per element for the life of a document, so two
// snapshots of the same page diff cleanly by ref. Baselines are kept per
// tab+url; a navigation or a missing baseline yields the full snapshot.

const REF_LINE_RE = /^@(e\d+)\s/;
const MAX_BASELINES = 32;

export function parseInteractiveSnapshot(text) {
  const header = [];
  const footer = [];
  const refs = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = REF_LINE_RE.exec(line);
    if (m) refs.set(m[1], line);
    else if (refs.size) footer.push(line);
    else header.push(line);
  }
  return { header, footer, refs };
}

export function diffInteractiveSnapshots(prevText, nextText) {
  const prev = parseInteractiveSnapshot(prevText);
  const next = parseInteractiveSnapshot(nextText);
  const added = [];
  const changed = [];
  const removed = [];
  let unchanged = 0;
  for (const [ref, line] of next.refs) {
    const before = prev.refs.get(ref);
    if (before === undefined) added.push(`+ ${line}`);
    else if (before !== line) changed.push(`~ ${line}`);
    else unchanged += 1;
  }
  for (const [ref, line] of prev.refs) {
    if (!next.refs.has(ref)) removed.push(`- ${line.split(" ").slice(0, 2).join(" ")}`);
  }
  const headerChanged = prev.header.join("\n") !== next.header.join("\n");
  const lines = [
    ...(headerChanged ? next.header : []),
    `snapshot diff: ${added.length} added, ${changed.length} changed, ${removed.length} removed, ${unchanged} unchanged`,
    ...changed,
    ...added,
    ...removed,
  ];
  return { text: lines.join("\n"), added: added.length, changed: changed.length, removed: removed.length, unchanged };
}

export function createSnapshotBaselines() {
  const baselines = new Map(); // key -> text

  function _key(tabId, url) {
    return `${tabId ?? "active"}|${String(url || "").split("#")[0]}`;
  }

  /**
   * Record `snapshot` as the new baseline and return what to show: the diff
   * against the previous baseline for the same tab+url, or the full text.
   */
  function update({ tabId, url, snapshot }) {
    const key = _key(tabId, url);
    const prev = baselines.get(key);
    baselines.delete(key);
    baselines.set(key, snapshot);
    while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value);
    if (prev == null) return { text: snapshot, diff: false };
    return { ...diffInteractiveSnapshots(prev, snapshot), diff: true };
  }

  function remember({ tabId, url, snapshot }) {
    const key = _key(tabId, url);
    baselines.delete(key);
    baselines.set(key, snapshot);
    while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value);
  }

  return { update, remember, clear: () => baselines.clear() };
}
