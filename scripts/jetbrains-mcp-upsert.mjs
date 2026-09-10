#!/usr/bin/env node
// Register an MCP server in a JetBrains IDE's config, idempotently.
//
// JetBrains AI Assistant needs two files under <IDE config>/options/:
//   McpToolsStoreService.xml — the server list (a JSON blob in an XML attr)
//   llm.mcpServers.xml       — per-server enable flags
//
// Extracted from setup.sh so setup.ps1 can call the same implementation:
// the PowerShell installer had no JetBrains branch at all, which left
// Windows IntelliJ AI Assistant users with zero configuration.
//
// Usage:
//   node scripts/jetbrains-mcp-upsert.mjs --options-dir <dir> --name <server>
//                                         --command node --arg <a> [--arg <b> ...]
//   node scripts/jetbrains-mcp-upsert.mjs --store <file> --ai <file> ...

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const opts = { optionsDir: null, store: null, ai: null, name: null, command: "node", args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const [flag, inline] = eq > 2 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--options-dir": opts.optionsDir = value(); break;
      case "--store": opts.store = value(); break;
      case "--ai": opts.ai = value(); break;
      case "--name": opts.name = value(); break;
      case "--command": opts.command = value(); break;
      case "--arg": opts.args.push(value()); break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.name) throw new Error("--name is required");
  if (opts.optionsDir) {
    opts.store ||= join(opts.optionsDir, "McpToolsStoreService.xml");
    opts.ai ||= join(opts.optionsDir, "llm.mcpServers.xml");
  }
  if (!opts.store || !opts.ai) throw new Error("--options-dir (or both --store and --ai) is required");
  if (!opts.args.length) throw new Error("at least one --arg is required");
  return opts;
}

const decodeXmlAttr = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const encodeXmlAttr = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function upsertStore(file, { name, command, args }) {
  let servers = [];
  if (existsSync(file)) {
    const content = readFileSync(file, "utf8");
    const match = content.match(/<option name="servers" value="([^"]*)" \/>/);
    if (match) {
      try {
        servers = JSON.parse(decodeXmlAttr(match[1]));
      } catch (err) {
        throw new Error(`Failed to parse JetBrains MCP store ${file}: ${err.message}`);
      }
    }
  }
  if (!Array.isArray(servers)) servers = [];

  const entry = { name, transport: { type: "stdio", command, args } };
  const at = servers.findIndex((s) => s && s.name === name);
  if (at >= 0) servers[at] = entry;
  else servers.push(entry);

  writeFileSync(
    file,
    `<application>\n  <component name="McpToolsStoreService">\n    <option name="servers" value="${encodeXmlAttr(JSON.stringify(servers))}" />\n  </component>\n</application>\n`,
  );
  return servers;
}

export function ensureAiServerEnabled(file, { name }) {
  const entry = `      <McpServerConfigurationProperties>\n        <option name="allowedToolsNames" />\n        <option name="enabled" value="true" />\n        <option name="name" value="${name}" />\n      </McpServerConfigurationProperties>`;

  let content = existsSync(file) ? readFileSync(file, "utf8") : "";

  if (!content.trim()) {
    writeFileSync(
      file,
      `<application>\n  <component name="McpApplicationServerCommands" modifiable="true" autoEnableExternalChanges="true">\n    <commands>\n${entry}\n    </commands>\n    <urls />\n  </component>\n</application>\n`,
    );
    return;
  }
  if (content.includes(`<option name="name" value="${name}" />`)) return;
  if (content.includes("</commands>")) {
    writeFileSync(file, content.replace("</commands>", `${entry}\n    </commands>`));
    return;
  }
  throw new Error(`Could not find </commands> in ${file}`);
}

// Only run as a CLI when invoked directly, so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.optionsDir) mkdirSync(opts.optionsDir, { recursive: true });
    upsertStore(opts.store, opts);
    ensureAiServerEnabled(opts.ai, opts);
    process.stdout.write(`registered ${opts.name} in ${opts.store}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
