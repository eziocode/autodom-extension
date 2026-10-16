// Recall store: full output for anything ATK cut, so the agent can page
// through it with the `recall` tool instead of re-running the tool with
// verbose:true. Same idea as `rtk recall <hash>`: compact by default, never
// lossy. In-memory only — this holds page content and must not outlive the
// bridge process.
import { createHash } from "node:crypto";

export const RECALL_DEFAULTS = Object.freeze({
  maxEntries: 64,
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 30 * 60 * 1000,
});

const SLICE_MAX_LINES = 400;
const SLICE_MAX_CHARS = 24_000;
const GREP_MAX_MATCHES = 200;

export function createRecallStore(options = {}) {
  const { maxEntries, maxBytes, ttlMs } = { ...RECALL_DEFAULTS, ...options };
  const now = options.now || Date.now;
  const entries = new Map(); // id -> { text, meta, bytes, at }
  let totalBytes = 0;
  let recalls = 0;

  function _drop(id) {
    const e = entries.get(id);
    if (!e) return;
    totalBytes -= e.bytes;
    entries.delete(id);
  }

  function _sweep() {
    const cutoff = now() - ttlMs;
    for (const [id, e] of entries) {
      if (e.at < cutoff) _drop(id);
    }
    // Map iteration order is insertion order; get() re-inserts, so the
    // first key is always the least recently used.
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      _drop(oldest);
    }
  }

  function put(text, meta = {}) {
    const body = String(text ?? "");
    const id = createHash("sha1").update(body).digest("hex").slice(0, 6);
    _drop(id);
    const bytes = Buffer.byteLength(body);
    if (bytes > maxBytes) return null;
    entries.set(id, { text: body, meta, bytes, at: now() });
    totalBytes += bytes;
    _sweep();
    return entries.has(id) ? id : null;
  }

  function get(id) {
    const key = String(id || "").trim().toLowerCase();
    const e = entries.get(key);
    if (!e) return null;
    if (e.at < now() - ttlMs) {
      _drop(key);
      return null;
    }
    entries.delete(key);
    e.at = now();
    entries.set(key, e);
    return e;
  }

  /**
   * One page of a stored output. `from` is 1-based. With `grep`, returns the
   * matching lines (with their line numbers) instead of a range.
   */
  function slice(id, { from = 1, lines = 200, grep } = {}) {
    const e = get(id);
    if (!e) return null;
    recalls += 1;
    const all = e.text.split("\n");
    const total = all.length;
    if (grep) {
      let re;
      try {
        re = new RegExp(grep, "i");
      } catch (_) {
        const needle = String(grep).toLowerCase();
        re = { test: (s) => s.toLowerCase().includes(needle) };
      }
      const hits = [];
      let matched = 0;
      for (let i = 0; i < total; i += 1) {
        if (!re.test(all[i])) continue;
        matched += 1;
        if (hits.length < GREP_MAX_MATCHES) hits.push(`${i + 1}: ${all[i]}`);
      }
      return { meta: e.meta, totalLines: total, matched, text: _clipChars(hits.join("\n")) };
    }
    const start = Math.max(1, Math.floor(Number(from) || 1));
    const count = Math.max(1, Math.min(Math.floor(Number(lines) || 200), SLICE_MAX_LINES));
    const page = all.slice(start - 1, start - 1 + count).join("\n");
    const text = _clipChars(page);
    const shownTo = Math.min(total, start - 1 + count);
    return { meta: e.meta, totalLines: total, from: start, to: shownTo, more: shownTo < total, text };
  }

  function stats() {
    _sweep();
    return { entries: entries.size, bytes: totalBytes, recalls };
  }

  function clear() {
    entries.clear();
    totalBytes = 0;
  }

  return { put, get, slice, stats, clear };
}

function _clipChars(text) {
  if (text.length <= SLICE_MAX_CHARS) return text;
  return `${text.slice(0, SLICE_MAX_CHARS)}\n… [page clipped at ${SLICE_MAX_CHARS} chars; ask for fewer lines]`;
}
