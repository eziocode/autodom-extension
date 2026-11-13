// Per-hop latency for bridge tool calls.
//
// One record per call, split into the hops a call crosses:
//   preSendMs    server work before the frame leaves (bootstrap wait,
//                reconnect grace, guardrails)
//   roundTripMs  frame sent → TOOL_RESULT received
//   swQueueMs    waiting in the extension's admission / tab lanes
//   swExecMs     running the tool in the extension (executeScript, CDP, ...)
//   transportMs  roundTrip minus the extension's own time: WS hops, JSON,
//                service-worker scheduling, and the primary hop when proxied
//   relayMs      (proxied calls) secondary → primary → secondary overhead
//   totalMs      callExtensionTool start → result
//
// Records live in a fixed ring; summary() reports per-tool p50/p95.

const DEFAULT_CAPACITY = 500;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const PHASES = [
  "totalMs",
  "preSendMs",
  "roundTripMs",
  "swQueueMs",
  "swExecMs",
  "transportMs",
  "relayMs",
];

function finite(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// Build one record from server-side marks and the extension's timing frame.
// `ext` is the TOOL_RESULT `timing` field (may be missing for older
// extensions or for calls that never reached the extension).
// `relay` is the primary's timing when this call was proxied through it.
export function buildTimingRecord({ tool, startAt, sentAt, endAt, ext, relay }) {
  const rec = { tool, ts: Date.now() };
  rec.totalMs = round1(endAt - startAt);
  if (sentAt != null) {
    rec.preSendMs = round1(sentAt - startAt);
    rec.roundTripMs = round1(endAt - sentAt);
  }
  // Proxied call: the primary measured its own hop to the extension; the
  // extension's numbers come through the primary unchanged.
  const swSource = relay?.ext || ext || null;
  const queue = finite(swSource?.queueMs);
  const exec = finite(swSource?.execMs);
  if (queue != null) rec.swQueueMs = queue;
  if (exec != null) rec.swExecMs = exec;
  if (finite(swSource?.swAgeMs) != null) rec.swAgeMs = swSource.swAgeMs;
  if (swSource?.firstCallSinceBoot) rec.coldWake = true;
  const primaryRoundTrip = finite(relay?.roundTripMs);
  if (rec.roundTripMs != null && primaryRoundTrip != null) {
    rec.relayMs = round1(Math.max(0, rec.roundTripMs - primaryRoundTrip));
  }
  const extHop = primaryRoundTrip ?? rec.roundTripMs;
  if (extHop != null && queue != null && exec != null) {
    rec.transportMs = round1(Math.max(0, extHop - queue - exec));
  }
  return rec;
}

export function createTimingStats({ capacity = DEFAULT_CAPACITY } = {}) {
  const ring = [];
  let next = 0;

  function record(rec) {
    if (!rec) return;
    if (ring.length < capacity) ring.push(rec);
    else {
      ring[next] = rec;
      next = (next + 1) % capacity;
    }
  }

  function ordered() {
    return ring.length < capacity ? ring.slice() : ring.slice(next).concat(ring.slice(0, next));
  }

  function phaseStats(recs) {
    const out = {};
    for (const phase of PHASES) {
      const vals = recs.map((r) => r[phase]).filter((v) => typeof v === "number");
      if (!vals.length) continue;
      vals.sort((a, b) => a - b);
      out[phase] = { p50: percentile(vals, 50), p95: percentile(vals, 95), max: vals[vals.length - 1] };
    }
    return out;
  }

  function summary({ top = 10, recent = 5 } = {}) {
    const recs = ordered();
    const byTool = new Map();
    for (const r of recs) {
      if (!byTool.has(r.tool)) byTool.set(r.tool, []);
      byTool.get(r.tool).push(r);
    }
    const tools = [...byTool.entries()]
      .map(([tool, list]) => ({ tool, count: list.length, ...phaseStats(list) }))
      .sort((a, b) => (b.totalMs?.p95 ?? 0) - (a.totalMs?.p95 ?? 0))
      .slice(0, top);
    return {
      samples: recs.length,
      coldWakes: recs.filter((r) => r.coldWake).length,
      overall: phaseStats(recs),
      slowestTools: tools,
      recent: recs.slice(-recent),
    };
  }

  function reset() {
    ring.length = 0;
    next = 0;
  }

  return { record, summary, reset, get size() { return ring.length; } };
}
