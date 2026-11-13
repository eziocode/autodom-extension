/**
 * AutoDOM broker spawning.
 *
 * One detached `index.js --bridge-only` process (the "broker") owns each
 * WebSocket port. Every MCP client's stdio process is a thin worker that
 * attaches to the broker over the proxy protocol. Because the broker is not
 * owned by any one MCP client, a client quitting never drops the port for
 * the others, and two clients never fight over who is primary.
 *
 * This module only knows how to: tell whether a port is served, and start a
 * broker exactly once even when several workers race (exclusive spawn lock).
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { promises as fs, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function brokerLockPath(port) {
  return join(tmpdir(), `autodom-bridge-${port}.json`);
}

export function brokerSpawnLockPath(port) {
  return join(tmpdir(), `autodom-bridge-${port}.spawn`);
}

/** Resolve true if something accepts TCP connections on 127.0.0.1:port. */
export function isPortListening(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Start a detached broker process. Returns its pid. */
export function spawnBrokerProcess({ indexJs, port, execPath = process.execPath, env = process.env }) {
  const logFile = join(tmpdir(), `autodom-bridge-only-${port}.log`);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(execPath, [indexJs, "--bridge-only", "--port", String(port)], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...env, AUTODOM_BROKER_SPAWNED: "1", AUTODOM_LAUNCHER_PID: "" },
    });
    child.unref();
    return child.pid;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

/**
 * Make sure a broker serves `port`. Safe to call from many workers at once:
 * only the worker holding the exclusive spawn lock starts a process; the
 * others wait for the port to come up.
 *
 * @returns {Promise<{ok:boolean, spawned:boolean, pid?:number, reason?:string}>}
 */
export async function ensureBroker({ indexJs, port, waitMs = 6000, spawnFn = spawnBrokerProcess }) {
  if (await isPortListening(port)) return { ok: true, spawned: false };

  const spawnLock = brokerSpawnLockPath(port);
  let lockFd = null;
  try {
    lockFd = await fs.open(spawnLock, "wx");
    await lockFd.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch (err) {
    if (err?.code !== "EEXIST") return { ok: false, spawned: false, reason: err?.message };
    // Someone else is spawning. Break the lock if its holder died or it is
    // older than the wait window (crashed mid-spawn).
    const held = await readJson(spawnLock);
    if (!held || !pidAlive(held.pid) || Date.now() - (held.at || 0) > waitMs) {
      await fs.rm(spawnLock, { force: true }).catch(() => {});
      return ensureBroker({ indexJs, port, waitMs, spawnFn });
    }
  }

  let pid;
  try {
    if (lockFd && !(await isPortListening(port))) {
      pid = spawnFn({ indexJs, port });
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await isPortListening(port)) {
        const lock = await readJson(brokerLockPath(port));
        if (lock?.token) return { ok: true, spawned: !!pid, pid: lock.pid || pid };
      }
      await delay(150);
    }
    return { ok: false, spawned: !!pid, pid, reason: `broker did not come up on port ${port} within ${waitMs}ms` };
  } finally {
    if (lockFd) {
      await lockFd.close().catch(() => {});
      await fs.rm(spawnLock, { force: true }).catch(() => {});
    }
  }
}
