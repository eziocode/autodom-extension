// Per-tool token accounting, the AutoDOM counterpart of `rtk gain`.
// Tokens are estimated at 4 bytes each, which is close enough to rank tools
// and report a savings percentage; nothing here bills anyone.

export const BYTES_PER_TOKEN = 4;

export function estimateTokens(bytes) {
  return Math.ceil((Number(bytes) || 0) / BYTES_PER_TOKEN);
}

export function createStats() {
  const byTool = new Map(); // tool -> { calls, rawBytes, outBytes, compacted, recalls }
  const startedAt = Date.now();

  function _row(tool) {
    let row = byTool.get(tool);
    if (!row) {
      row = { calls: 0, rawBytes: 0, outBytes: 0, compacted: 0, recalls: 0 };
      byTool.set(tool, row);
    }
    return row;
  }

  function record(tool, rawBytes, outBytes) {
    const row = _row(tool);
    row.calls += 1;
    row.rawBytes += Math.max(0, rawBytes | 0);
    row.outBytes += Math.max(0, outBytes | 0);
    if (outBytes < rawBytes) row.compacted += 1;
  }

  function recordRecall(tool) {
    _row(tool || "unknown").recalls += 1;
  }

  function summary({ top = 15 } = {}) {
    let raw = 0;
    let out = 0;
    let calls = 0;
    const rows = [];
    for (const [tool, r] of byTool) {
      raw += r.rawBytes;
      out += r.outBytes;
      calls += r.calls;
      rows.push({
        tool,
        calls: r.calls,
        rawTokens: estimateTokens(r.rawBytes),
        outTokens: estimateTokens(r.outBytes),
        savedTokens: estimateTokens(r.rawBytes - r.outBytes),
        savedPct: r.rawBytes ? Math.round((1 - r.outBytes / r.rawBytes) * 100) : 0,
        recalls: r.recalls,
      });
    }
    rows.sort((a, b) => b.savedTokens - a.savedTokens);
    return {
      since: new Date(startedAt).toISOString(),
      calls,
      rawTokens: estimateTokens(raw),
      outTokens: estimateTokens(out),
      savedTokens: estimateTokens(raw - out),
      savedPct: raw ? Math.round((1 - out / raw) * 1000) / 10 : 0,
      tools: rows.slice(0, top),
    };
  }

  function format(opts) {
    const s = summary(opts);
    const lines = [
      `ATK savings since ${s.since}: ${s.calls} calls, ${s.rawTokens} → ${s.outTokens} tokens (−${s.savedTokens}, ${s.savedPct}%)`,
      "tool | calls | raw→out tok | saved | recalls",
    ];
    for (const r of s.tools) {
      lines.push(`${r.tool} | ${r.calls} | ${r.rawTokens}→${r.outTokens} | ${r.savedPct}% | ${r.recalls}`);
    }
    return lines.join("\n");
  }

  function reset() {
    byTool.clear();
  }

  return { record, recordRecall, summary, format, reset };
}
