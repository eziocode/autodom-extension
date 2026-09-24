/**
 * AutoDOM bridge reaper — the kill policy, as a pure function.
 *
 * Given a snapshot of every AutoDOM bridge process on the machine, the lock
 * files, and what each live primary reports about its connected proxies,
 * decide which processes to keep, which to nudge (SIGUSR2 → re-run the
 * election) and which to kill. No I/O happens here so the policy can be
 * unit-tested; native-host.js gathers the snapshot and applies the verdict.
 *
 * Policy ("orphans + zombies"):
 *   keep  — the primary that owns a port (lock owner / reported primary),
 *           proxies that primary lists as connected, --bridge-only daemons
 *           that own their port, and instances still starting up.
 *   kill  — bridges whose launching parent is gone (PPID 1 or dead parent).
 *   nudge — everything else: a live-parent instance that is neither the
 *           primary nor a joined proxy (e.g. DEGRADED after its recovery
 *           budget ran out). If it is still unjoined after the nudge
 *           (`nudged` contains its pid on the second pass), kill it.
 */

export const DEFAULT_PORT = 9876;
// An instance younger than this may still be inside its election
// (bind retries ≈4s + up to 3 proxy rounds); never judge it yet.
export const STARTUP_GRACE_MS = 15000;

/** Port a bridge command line serves (explicit --port, else the default). */
export function portFromCommand(command, defaultPort = DEFAULT_PORT) {
  const match = /--port[=\s]+(\d+)/.exec(command || "");
  return match ? Number.parseInt(match[1], 10) : defaultPort;
}

/** Parse `ps -o etime=` output ([[dd-]hh:]mm:ss) into milliseconds. */
export function parseEtime(etime) {
  const raw = String(etime || "").trim();
  if (!raw) return null;
  let days = 0;
  let rest = raw;
  const dash = raw.indexOf("-");
  if (dash >= 0) {
    days = Number.parseInt(raw.slice(0, dash), 10) || 0;
    rest = raw.slice(dash + 1);
  }
  const parts = rest.split(":").map((p) => Number.parseInt(p, 10) || 0);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000;
}

/**
 * @param {object} snapshot
 * @param {Array<{pid:number, ppid:number, parentAlive:boolean, port:number,
 *                command?:string, ageMs?:number|null}>} snapshot.bridges
 * @param {Record<number, {pid:number, alive:boolean}>} [snapshot.locks]
 *        lock file per port
 * @param {Record<number, {pid:number, proxies:number[]}>} [snapshot.primaries]
 *        BRIDGE_STATUS answers per port (only reachable primaries)
 * @param {Record<number, number>} [snapshot.listeners] pid listening on
 *        each port (from lsof / Get-NetTCPConnection)
 * @param {Iterable<number>} [snapshot.nudged] pids nudged on a prior pass
 * @returns {{keep:Array, nudge:Array, kill:Array, staleLocks:number[]}}
 */
export function decideReap({
  bridges = [],
  locks = {},
  primaries = {},
  listeners = {},
  nudged = [],
} = {}) {
  const nudgedSet = new Set(nudged);
  const keep = [];
  const nudge = [];
  const kill = [];
  const staleLocks = [];

  for (const [portKey, lock] of Object.entries(locks)) {
    if (lock && lock.pid && !lock.alive) staleLocks.push(Number(portKey));
  }

  for (const b of bridges) {
    const port = b.port ?? portFromCommand(b.command);
    const primary = primaries[port];
    const lock = locks[port];
    const owner = listeners[port];
    const entry = { pid: b.pid, port };

    if (primary && primary.pid === b.pid) {
      keep.push({ ...entry, reason: "primary" });
      continue;
    }
    if (!primary && lock && lock.alive && lock.pid === b.pid) {
      // Owns the lock but did not answer BRIDGE_STATUS (busy, or older
      // server without the handler). Owning the port is enough to keep it.
      keep.push({ ...entry, reason: "lock owner" });
      continue;
    }
    if (owner === b.pid) {
      // Holding the listening socket makes it the primary whatever the
      // lock file says (it may have been deleted from under a live bridge).
      keep.push({ ...entry, reason: "port owner" });
      continue;
    }
    if (primary && (primary.proxies || []).includes(b.pid)) {
      keep.push({ ...entry, reason: "joined proxy" });
      continue;
    }
    if (!b.parentAlive) {
      if (/--bridge-only/.test(b.command || "")) {
        // Detached daemon (PPID 1 by design) that is not the primary: it
        // exits by itself once it sees another owner, but a stuck one is
        // just a squatter.
        kill.push({ ...entry, reason: "bridge-only daemon not owning its port" });
      } else {
        kill.push({ ...entry, reason: "orphan (launching parent gone)" });
      }
      continue;
    }
    if (!primary && ((lock && lock.alive) || owner)) {
      // A live primary exists but could not tell us who its proxies are.
      // Without that list a joined proxy is indistinguishable from a
      // zombie, so a live-parent instance gets the benefit of the doubt.
      keep.push({ ...entry, reason: "unverified (primary did not report proxies)" });
      continue;
    }
    if (typeof b.ageMs === "number" && b.ageMs < STARTUP_GRACE_MS) {
      keep.push({ ...entry, reason: "starting up" });
      continue;
    }
    if (nudgedSet.has(b.pid)) {
      kill.push({ ...entry, reason: "zombie (not joined to the primary after nudge)" });
      continue;
    }
    nudge.push({ ...entry, reason: "not primary and not a joined proxy" });
  }

  return { keep, nudge, kill, staleLocks };
}
