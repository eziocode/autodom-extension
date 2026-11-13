// Writes a recorded HAR to disk for har_stop: one file, or one file per
// test-case segment, plus an optional curl script for the API calls.
import { promises as fs } from "fs";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join } from "path";

const API_TYPES = new Set(["XHR", "Fetch", "EventSource"]);
// Set by the client or the network stack; replaying them breaks requests.
const SKIP_CURL_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);

const slug = (s, max = 40) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// The HAR for one segment: its entries, the pages they reference, and the
// steps (tool calls) that ran in it.
function segmentHar(har, segment) {
  const log = har.log;
  const entries = log.entries.filter((e) => e._autodom?.segment === segment.index);
  const pageIds = new Set(entries.map((e) => e.pageref).filter(Boolean));
  return {
    log: {
      ...log,
      pages: log.pages.filter((p) => pageIds.has(p.id)),
      entries,
      _autodom: {
        segments: [segment],
        steps: (log._autodom?.steps || []).filter((st) => st.segment === segment.index),
      },
    },
  };
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A REDACTED value becomes a shell variable the user can set, so the
// script never carries the secret.
function curlValue(value, name) {
  if (value !== "REDACTED") return shellQuote(value);
  return `"$AUTODOM_REDACTED_${slug(name, 60).replace(/[^a-z0-9]/g, "_").toUpperCase()}"`;
}

export function toCurl(har) {
  const lines = [
    "#!/bin/sh",
    "# API calls recorded by AutoDOM. Redacted values are read from",
    "# $AUTODOM_REDACTED_<NAME> variables; set them before running.",
    "",
  ];
  let segment = null;
  let count = 0;
  for (const e of har.log.entries) {
    if (!API_TYPES.has(e._resourceType) || !/^https?:/.test(e.request.url)) continue;
    const seg = e._autodom?.segment ?? 0;
    if (seg !== segment) {
      segment = seg;
      const label = har.log._autodom?.segments?.find((s) => s.index === seg)?.label;
      lines.push(`# ── segment ${seg}${label ? `: ${label}` : ""}`);
    }
    const parts = [`curl -sS -X ${e.request.method} ${shellQuote(e.request.url)}`];
    for (const h of e.request.headers || []) {
      if (h.name.startsWith(":") || SKIP_CURL_HEADERS.has(h.name.toLowerCase())) continue;
      parts.push(`-H ${h.value === "REDACTED" ? `"${h.name}: ${curlValue(h.value, h.name).slice(1, -1)}"` : shellQuote(`${h.name}: ${h.value}`)}`);
    }
    const body = e.request.postData?.text;
    if (body) parts.push(`--data-raw ${shellQuote(body)}`);
    lines.push(`# ${e.response?.status ?? "?"} ${e._autodom?.tool ? `(step ${e._autodom.step}: ${e._autodom.tool})` : ""}`.trimEnd());
    lines.push(parts.join(" \\\n  "));
    lines.push("");
    count += 1;
  }
  return { text: lines.join("\n"), count };
}

// Where the files go: an absolute .har path (one file), an absolute
// directory (split), or ~/Downloads/autodom-har/. Existing files are kept
// unless overwrite.
export async function writeHarFiles(har, { host, path, split, curl = false, overwrite = false } = {}) {
  const segments = har.log._autodom?.segments || [];
  const splitting = (split || (segments.length > 1 ? "segment" : "none")) === "segment" && segments.length > 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dir = join(homedir(), "Downloads", "autodom-har");
  let base = `${slug(host || "page") || "page"}-${stamp}`;
  if (path) {
    if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
    if (extname(path).toLowerCase() === ".har") {
      dir = dirname(path);
      base = basename(path, extname(path));
    } else if (splitting) {
      dir = path;
    } else {
      throw new Error(`path must end in .har (or be a directory when the HAR is split per segment): ${path}`);
    }
  }
  const plan = splitting
    ? segments.map((seg) => ({
        seg,
        file: join(dir, `${base}-${String(seg.index + 1).padStart(2, "0")}${seg.label ? `-${slug(seg.label)}` : ""}.har`),
        har: segmentHar(har, seg),
      }))
    : [{ seg: null, file: join(dir, `${base}.har`), har }];
  const curlFile = curl ? join(dir, `${base}.curl.sh`) : null;
  if (!overwrite) {
    for (const f of [...plan.map((p) => p.file), ...(curlFile ? [curlFile] : [])]) {
      if (await exists(f)) throw new Error(`${f} exists; pass overwrite:true to replace it`);
    }
  }
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (const p of plan) {
    const text = JSON.stringify(p.har, null, 2);
    await fs.writeFile(p.file, text, "utf8");
    files.push({
      ...(p.seg && { segment: p.seg.index, label: p.seg.label }),
      path: p.file,
      bytes: Buffer.byteLength(text),
      entries: p.har.log.entries.length,
    });
  }
  const out = files.length === 1 ? { path: files[0].path, bytes: files[0].bytes } : { files };
  if (curlFile) {
    const { text, count } = toCurl(har);
    await fs.writeFile(curlFile, text, { encoding: "utf8", mode: 0o700 });
    out.curl = { path: curlFile, requests: count };
  }
  return out;
}
