#!/usr/bin/env node

/**
 * AutoDOM native-messaging helper ("com.autodom.bridge").
 *
 * Lets the extension's Bridge check / Fix inspect and repair the local
 * bridge without a terminal: list every AutoDOM server process, reap
 * orphans and zombies (policy in bridge-reaper.js), and start a fresh
 * detached `index.js --bridge-only` primary when none is alive.
 *
 * Chrome launches this through the wrapper that setup.sh / setup.ps1
 * generate (native-host.sh / native-host.bat, absolute node path baked in)
 * and talks to it with the native-messaging framing: 4-byte little-endian
 * length + UTF-8 JSON, both directions.
 *
 * Requests:  { cmd: "version" | "status" | "flush" | "restart", port? }
 *
 * CLI (setup scripts, debugging):
 *   node native-host.js --cli status|flush|restart|version [--port N]
 */

import { execFile, spawn } from "child_process";
import { promises as fs, openSync, readFileSync } from "fs";
import net from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { WebSocket } from "ws";
import {
  DEFAULT_PORT,
  decideReap,
  parseEtime,
  portFromCommand,
} from "./bridge-reaper.js";

const execFileAsync = promisify(execFile);
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(SERVER_DIR, "index.js");
const VERSION = JSON.parse(
  readFileSync(join(SERVER_DIR, "package.json"), "utf8"),
).version;
const HOST_NAME = "com.autodom.bridge";
const SCAN_PORTS = [9876, 9877, 9878, 9879, 9880];
const NUDGE_WAIT_MS = 4000;
const KILL_GRACE_MS = 1500;
const LOG_PATH = join(tmpdir(), "autodom-native-host.log");
const IS_WIN = process.platform === "win32";

function log(msg) {
  fs.appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(
    () => {},
  );
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function lockPath(port) {
  return join(tmpdir(), `autodom-bridge-${port}.json`);
}

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isAutodomBridge(command) {
  const cmd = command || "";
  if (!/index\.js/.test(cmd)) return false;
  if (/native-host\.js/.test(cmd)) return false;
  // Launcher wrappers (`disclaimer --pgroup -- node …/index.js`, `env --`)
  // carry the bridge command line but are not the bridge; their child is.
  if (/\s--\s.*index\.js/.test(cmd)) return false;
  return cmd.includes(INDEX_JS) || /autodom/i.test(cmd);
}

// ─── Process discovery ───────────────────────────────────────

async function listProcessesPosix() {
  // One `ps` call for the whole table; filtering in JS is cheaper and more
  // portable than pgrep + per-pid ps.
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,ppid=,etime=,command="],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const rows = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      ageMs: parseEtime(m[3]),
      command: m[4],
    });
  }
  return rows;
}

async function listProcessesWindows() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,CommandLine," +
    "@{n='AgeMs';e={[int64]((Get-Date)-$_.CreationDate).TotalMilliseconds}} | " +
    "ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    ageMs: p.AgeMs ?? null,
    command: p.CommandLine || "",
  }));
}

async function listBridges() {
  const rows = IS_WIN ? await listProcessesWindows() : await listProcessesPosix();
  return rows
    .filter((r) => r.pid !== process.pid && isAutodomBridge(r.command))
    .map((r) => ({
      ...r,
      port: portFromCommand(r.command),
      bridgeOnly: r.command.includes("--bridge-only"),
      parentAlive: r.ppid > 1 && isAlive(r.ppid),
    }));
}

async function readLock(port) {
  try {
    return JSON.parse(await fs.readFile(lockPath(port), "utf8"));
  } catch {
    return null;
  }
}

// pid that owns the LISTEN socket on a port, or null.
async function listenerPid(port) {
  try {
    if (IS_WIN) {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ]);
      return Number.parseInt(stdout.trim(), 10) || null;
    }
    const { stdout } = await execFileAsync("lsof", [
      `-tiTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
    return Number.parseInt(stdout.split("\n")[0], 10) || null;
  } catch {
    return null;
  }
}

function isPortListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

// Ask a primary for BRIDGE_STATUS using the token from its lock file.
function queryBridgeStatus(port, token, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {}
      resolve(value);
    };
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
    );
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "BRIDGE_STATUS", id: "native-host" }));
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "BRIDGE_STATUS_RESPONSE") finish(msg.status || null);
      } catch {}
    });
    ws.on("error", () => finish(null));
    ws.on("close", () => finish(null));
  });
}

async function scan() {
  const bridges = await listBridges();
  const ports = new Set([...SCAN_PORTS, ...bridges.map((b) => b.port)]);
  const locks = {};
  const primaries = {};
  const listeners = {};
  const ports_ = {};
  await Promise.all(
    [...ports].map(async (port) => {
      const [lock, listening, owner] = await Promise.all([
        readLock(port),
        isPortListening(port),
        listenerPid(port),
      ]);
      if (owner) listeners[port] = owner;
      let status = null;
      if (lock?.pid) {
        locks[port] = { pid: lock.pid, alive: isAlive(lock.pid) };
        if (locks[port].alive && lock.token && listening) {
          status = await queryBridgeStatus(port, lock.token);
          if (status?.role === "primary") {
            primaries[port] = {
              pid: status.pid,
              proxies: (status.proxies || []).map((p) => p.pid),
            };
          }
        }
      }
      ports_[port] = {
        listening,
        lockPid: lock?.pid ?? null,
        lockAlive: locks[port]?.alive ?? false,
        listenerPid: owner,
        status,
      };
    }),
  );
  return { bridges, locks, primaries, listeners, ports: ports_ };
}

function summarize(snapshot, verdict) {
  const byPid = new Map();
  for (const k of ["keep", "nudge", "kill"]) {
    for (const v of verdict[k]) byPid.set(v.pid, { action: k, reason: v.reason });
  }
  return {
    bridges: snapshot.bridges.map((b) => ({
      pid: b.pid,
      ppid: b.ppid,
      port: b.port,
      ageMs: b.ageMs,
      parentAlive: b.parentAlive,
      bridgeOnly: b.bridgeOnly,
      primary: snapshot.primaries[b.port]?.pid === b.pid,
      joined: (snapshot.primaries[b.port]?.proxies || []).includes(b.pid),
      verdict: byPid.get(b.pid) || null,
    })),
    ports: Object.fromEntries(
      Object.entries(snapshot.ports).filter(
        ([, p]) => p.listening || p.lockPid,
      ),
    ),
    staleLocks: verdict.staleLocks,
  };
}

// ─── Actions ─────────────────────────────────────────────────

async function killPid(pid) {
  // Re-verify right before signalling: pids can be recycled between the
  // scan and now, and we must never touch a non-AutoDOM process.
  const fresh = (await listBridges()).find((b) => b.pid === pid);
  if (!fresh) return { pid, killed: false, note: "gone or not an AutoDOM bridge" };
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && isAlive(pid)) await delay(100);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await delay(300);
  }
  return { pid, killed: !isAlive(pid) };
}

async function applyVerdict(verdict) {
  const results = [];
  for (const k of verdict.kill) {
    const r = await killPid(k.pid);
    log(`kill pid=${k.pid} port=${k.port} (${k.reason}) → ${r.killed}`);
    results.push({ ...k, ...r });
  }
  for (const port of verdict.staleLocks) {
    await fs.rm(lockPath(port), { force: true }).catch(() => {});
    log(`removed stale lock for port ${port}`);
  }
  return results;
}

async function flush(port) {
  const scope = (v) => (port ? v.port === port : true);
  let snap = await scan();
  let verdict = decideReap(snap);
  verdict = {
    keep: verdict.keep.filter(scope),
    nudge: verdict.nudge.filter(scope),
    kill: verdict.kill.filter(scope),
    staleLocks: verdict.staleLocks.filter((p) => !port || p === port),
  };
  const killed = await applyVerdict(verdict);
  const nudged = [];

  if (verdict.nudge.length) {
    for (const n of verdict.nudge) {
      if (!IS_WIN) {
        try {
          process.kill(n.pid, "SIGUSR2");
        } catch {}
      }
      nudged.push(n.pid);
      log(`nudge pid=${n.pid} port=${n.port} (${n.reason})`);
    }
    // Give them one election cycle to become primary or join as a proxy.
    await delay(NUDGE_WAIT_MS);
    snap = await scan();
    const second = decideReap({ ...snap, nudged });
    const secondScoped = {
      keep: second.keep.filter(scope),
      nudge: [],
      kill: second.kill.filter(scope),
      staleLocks: second.staleLocks.filter((p) => !port || p === port),
    };
    killed.push(...(await applyVerdict(secondScoped)));
  }

  const after = await scan();
  return {
    killed: killed.filter((k) => k.killed),
    nudged,
    after: summarize(after, decideReap(after)),
  };
}

async function startBridgeOnly(port) {
  const logFile = join(tmpdir(), `autodom-bridge-only-${port}.log`);
  const args = [INDEX_JS, "--bridge-only", "--port", String(port)];
  if (IS_WIN) {
    // Chrome runs native hosts inside a kill-on-close job object, so a
    // plain detached child dies with us. WMI creates the process outside
    // that job.
    const cmdLine = `"${process.execPath}" "${INDEX_JS}" --bridge-only --port ${port}`;
    const psCmd =
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
      `-Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}'; ` +
      `CurrentDirectory = '${SERVER_DIR.replace(/'/g, "''")}' }; $r.ProcessId`;
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psCmd,
    ]);
    return Number.parseInt(stdout.trim(), 10) || null;
  }
  // stdout MUST NOT be inherited: it is Chrome's native-messaging pipe.
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, AUTODOM_NATIVE_HOST_SPAWNED: "1" },
  });
  child.unref();
  return child.pid;
}

async function restart(port = DEFAULT_PORT) {
  const flushed = await flush(port);
  const portInfo = flushed.after.ports[port];
  const hasPrimary = flushed.after.bridges.some(
    (b) => b.port === port && b.primary,
  );
  if (hasPrimary || (portInfo?.listening && portInfo?.lockAlive)) {
    return { ...flushed, started: null, note: "a live primary already owns the port" };
  }
  if (portInfo?.listening) {
    return {
      ...flushed,
      started: null,
      error: `Port ${port} is held by a non-AutoDOM process; free it or pick another port.`,
    };
  }
  const pid = await startBridgeOnly(port);
  log(`started --bridge-only pid=${pid} port=${port}`);
  const deadline = Date.now() + 6000;
  let ready = false;
  while (Date.now() < deadline) {
    const lock = await readLock(port);
    if (lock?.pid && isAlive(lock.pid) && (await isPortListening(port))) {
      ready = true;
      break;
    }
    await delay(200);
  }
  return { ...flushed, started: { pid, port, ready } };
}

async function status() {
  const snap = await scan();
  return summarize(snap, decideReap(snap));
}

async function handle(req) {
  const cmd = req?.cmd;
  const port = Number.parseInt(req?.port, 10) || undefined;
  try {
    switch (cmd) {
      case "version":
        return { ok: true, host: HOST_NAME, version: VERSION, node: process.version, serverDir: SERVER_DIR };
      case "status":
        return { ok: true, version: VERSION, ...(await status()) };
      case "flush":
        return { ok: true, version: VERSION, ...(await flush(port)) };
      case "restart":
        return { ok: true, version: VERSION, ...(await restart(port || DEFAULT_PORT)) };
      default:
        return { ok: false, error: `unknown cmd: ${cmd}` };
    }
  } catch (err) {
    log(`${cmd} failed: ${err?.stack || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ─── Native-messaging framing ────────────────────────────────

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return new Promise((resolve) => {
    process.stdout.write(Buffer.concat([header, body]), resolve);
  });
}

function serveNativeMessaging() {
  let buf = Buffer.alloc(0);
  let pending = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && pending === 0) process.exit(0);
  };
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      let req = null;
      try {
        req = JSON.parse(body);
      } catch {}
      pending++;
      log(`request ${body.slice(0, 200)}`);
      handle(req)
        .then((res) => writeMessage({ ...res, requestId: req?.requestId }))
        .finally(() => {
          pending--;
          maybeExit();
        });
    }
  });
  process.stdin.on("end", () => {
    ended = true;
    maybeExit();
  });
}

const argv = process.argv.slice(2);
if (argv[0] === "--cli") {
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? argv[portIdx + 1] : undefined;
  handle({ cmd: argv[1] || "status", port }).then((res) => {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    process.exit(res.ok ? 0 : 1);
  });
} else {
  serveNativeMessaging();
}
