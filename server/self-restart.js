/**
 * AutoDOM bridge — in-place restart onto a newer version.
 *
 * An update replaces the files under server/, but every bridge process that
 * is already running keeps executing the old code from memory. The IDE owns
 * those processes (it spawned them over stdio and tracks their PID), so they
 * cannot simply be killed and restarted without dropping the IDE's MCP
 * connection. Instead a stale bridge hands its work to a fresh process and
 * stays behind as a thin relay:
 *
 *     IDE ⇄ (old PID, relay only) ⇄ new bridge process
 *
 * The IDE sees the same PID and the same open pipes the whole time. This
 * module holds the pure pieces so they can be tested without spawning:
 *
 *   - readDiskVersion / isNewerVersion   — is a newer server on disk?
 *   - createHandshakeTap                 — remember the client's MCP
 *                                          initialize handshake, because a
 *                                          2025-era stdio session is stateful
 *                                          and the new process must be told
 *                                          the handshake already happened.
 *   - startRelay                         — pipe stdin/stdout to the new
 *                                          process, replaying the handshake
 *                                          and swallowing its duplicate
 *                                          initialize reply.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { compareExtensionVersions } from "./update-utils.js";

const SEMVER = /^\d+\.\d+\.\d+(\.\d+)?$/;

/** Version recorded in server/package.json right now (null if unreadable). */
export function readDiskVersion(packageJsonPath) {
  try {
    const version = String(
      JSON.parse(readFileSync(packageJsonPath, "utf8")).version || "",
    );
    return SEMVER.test(version) ? version : null;
  } catch (_) {
    return null;
  }
}

/** True only for a strictly newer on-disk version (never for a downgrade). */
export function isNewerVersion(diskVersion, runningVersion) {
  return (
    !!diskVersion &&
    SEMVER.test(String(runningVersion)) &&
    compareExtensionVersions(diskVersion, runningVersion) > 0
  );
}

/**
 * Refuse to hand over to code that cannot start: the files must parse and
 * the dependencies must be installed. An update that is half-written (git
 * checkout in progress, npm still installing) fails here and is retried on
 * the next check instead of killing a working bridge.
 */
export function preflightServer(indexPath, spawn = spawnSync) {
  const serverDir = dirname(indexPath);
  if (!existsSync(indexPath)) return { ok: false, reason: "index.js missing" };
  for (const dep of ["ws", "zod", "@modelcontextprotocol/server"]) {
    if (!existsSync(join(serverDir, "node_modules", dep))) {
      return { ok: false, reason: `dependency ${dep} not installed` };
    }
  }
  const res = spawn(process.execPath, ["--check", indexPath], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.error?.message || "").split("\n")[0];
    return { ok: false, reason: `syntax check failed: ${detail}`.trim() };
  }
  return { ok: true };
}

/**
 * Passive tap on the client's stdin that keeps the MCP handshake messages
 * (`initialize` and `notifications/initialized`) so they can be replayed to
 * a successor process. Stops by itself once the handshake is complete, when
 * the client turns out not to use one (stateless first request), or when
 * the traffic is implausibly large.
 */
export function createHandshakeTap(stdin, { maxBytes = 256 * 1024 } = {}) {
  const captured = [];
  let buffer = "";
  let bytes = 0;
  let finished = false;

  const finish = () => {
    finished = true;
    stdin.off("data", onData);
  };

  const onData = (chunk) => {
    if (finished) return;
    bytes += chunk.length;
    if (bytes > maxBytes) return finish();
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (message?.method === "initialize") {
        captured.push({ kind: "initialize", id: message.id, line });
      } else if (message?.method === "notifications/initialized") {
        if (captured.length) {
          captured.push({ kind: "initialized", line });
          return finish();
        }
      } else if (message?.method && captured.length === 0) {
        // First message is a normal request: a stateless client, nothing
        // to replay.
        return finish();
      }
    }
  };

  stdin.on("data", onData);
  return {
    captured,
    /** Handshake fully seen (or not needed) — safe to hand over. */
    get settled() {
      return finished;
    },
    /** Lines to replay to the successor, in order. */
    get handshake() {
      return captured.some((c) => c.kind === "initialized") ? [...captured] : [];
    },
    stop: finish,
  };
}

/**
 * Relay the client's stdio to a successor process. `handshake` (from the
 * tap) is replayed first: `initialize` is sent, the successor's reply is
 * dropped (the client already has one), then `notifications/initialized`
 * follows and anything the client sent in the meantime is flushed.
 * Returns a controller with `end()` to close the successor's stdin.
 */
export function startRelay({
  child,
  stdin,
  stdout,
  handshake = [],
  handshakeTimeoutMs = 5000,
  onLog = () => {},
}) {
  const initialize = handshake.filter((h) => h.kind === "initialize");
  const initialized = handshake.filter((h) => h.kind === "initialized");
  const dropIds = new Set(initialize.map((h) => h.id));

  let ready = initialize.length === 0;
  const queued = [];
  let outBuffer = "";
  let timer = null;

  const becomeReady = () => {
    if (ready) return;
    ready = true;
    clearTimeout(timer);
    for (const h of initialized) child.stdin.write(`${h.line}\n`);
    for (const chunk of queued.splice(0)) child.stdin.write(chunk);
  };

  child.stdout.on("data", (chunk) => {
    if (dropIds.size === 0 && !outBuffer) {
      stdout.write(chunk);
      return;
    }
    outBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = outBuffer.indexOf("\n")) >= 0) {
      const line = outBuffer.slice(0, newline);
      outBuffer = outBuffer.slice(newline + 1);
      let drop = false;
      if (dropIds.size) {
        try {
          const message = JSON.parse(line);
          if (
            message &&
            message.method === undefined &&
            message.id !== undefined &&
            dropIds.has(message.id)
          ) {
            dropIds.delete(message.id);
            drop = true;
          }
        } catch (_) {}
      }
      if (!drop) stdout.write(`${line}\n`);
      else if (dropIds.size === 0) {
        onLog("handshake replayed");
        becomeReady();
      }
    }
    if (dropIds.size === 0 && outBuffer) {
      stdout.write(outBuffer);
      outBuffer = "";
    }
  });

  stdin.on("data", (chunk) => {
    if (ready) child.stdin.write(chunk);
    else queued.push(chunk);
  });
  stdin.on("end", () => {
    try {
      child.stdin.end();
    } catch (_) {}
  });

  // Replay the handshake. Never leave the client hanging if the successor
  // does not answer: flush after a deadline.
  for (const h of initialize) child.stdin.write(`${h.line}\n`);
  if (!ready) {
    timer = setTimeout(() => {
      onLog("handshake reply timed out — flushing queued input");
      becomeReady();
    }, handshakeTimeoutMs);
    timer.unref?.();
  }

  return {
    end() {
      try {
        child.stdin.end();
      } catch (_) {}
    },
  };
}
