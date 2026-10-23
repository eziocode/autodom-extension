// Code Mode API generation: tool definitions (zod -> JSON Schema) become a
// TypeScript declaration the model codes against, plus a one-line-per-tool
// index for progressive discovery through `code_api`.

import { AREA_NAMES, RESULT_TYPES, areaOf } from "./result-types.js";

const TIER_RANK = { read: 0, write: 1, destructive: 2 };

export function tierAllows(ceiling, tier) {
  return (TIER_RANK[tier] ?? TIER_RANK.write) <= (TIER_RANK[ceiling] ?? TIER_RANK.write);
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function literal(value) {
  return JSON.stringify(value);
}

function wrapUnion(type) {
  return type.includes(" | ") || type.includes("=>") ? `(${type})` : type;
}

function oneLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\*\//g, "* /")
    .trim();
}

/** JSON Schema node -> TypeScript type text. Unknown shapes degrade to `any`. */
export function schemaToTs(schema, indent = "") {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ") || "never";
  if ("const" in schema) return literal(schema.const);
  const alts = schema.anyOf || schema.oneOf;
  if (Array.isArray(alts)) {
    const types = [...new Set(alts.map((s) => schemaToTs(s, indent)))];
    return types.includes("any") ? "any" : types.join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return [...new Set(schema.type.map((t) => schemaToTs({ ...schema, type: t }, indent)))].join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return schema.items ? `${wrapUnion(schemaToTs(schema.items, indent))}[]` : "any[]";
    case "object":
      return objectToTs(schema, indent);
    default:
      return schema.properties ? objectToTs(schema, indent) : "any";
  }
}

function objectToTs(schema, indent) {
  const props = Object.entries(schema.properties || {});
  if (props.length === 0) {
    const extra = schema.additionalProperties;
    if (extra && typeof extra === "object") return `Record<string, ${schemaToTs(extra, indent)}>`;
    return "Record<string, any>";
  }
  const required = new Set(schema.required || []);
  const inner = indent + "  ";
  const lines = props.map(([name, prop]) => {
    const doc = propDoc(prop);
    const key = IDENT.test(name) ? name : literal(name);
    // zod defaults land in `required` for the output side only; inputs
    // with a default are optional to the caller.
    const optional = !required.has(name) || (prop && "default" in prop);
    return `${doc ? `${inner}/** ${doc} */\n` : ""}${inner}${key}${optional ? "?" : ""}: ${schemaToTs(prop, inner)};`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function propDoc(prop) {
  if (!prop || typeof prop !== "object") return "";
  const parts = [];
  if (prop.description) parts.push(oneLine(prop.description));
  if ("default" in prop && prop.default !== undefined) parts.push(`Default: ${oneLine(literal(prop.default))}`);
  if (typeof prop.minimum === "number" || typeof prop.maximum === "number") {
    parts.push(`Range: ${prop.minimum ?? "-inf"}..${prop.maximum ?? "inf"}`);
  }
  return parts.join(". ");
}

// Result types are written with two-space nesting from column 0; shift
// continuation lines under the declaration's indent.
function reindent(type, indent) {
  return type
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n");
}

function firstSentence(text) {
  const flat = oneLine(text);
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(flat);
  const s = m ? m[1] : flat;
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

/**
 * @param {object[]} definitions                  server tool definitions ({name, description, parameters})
 * @param {object} opts
 * @param {(parameters: any) => object} opts.jsonSchemaFor  zod -> JSON Schema (input side)
 * @param {(name: string) => string} opts.tierOf
 * @param {(def: object) => boolean} opts.include
 */
export function buildApi(definitions, { jsonSchemaFor, tierOf, include }) {
  const entries = [];
  for (const def of definitions) {
    if (!include(def)) continue;
    let schema;
    try {
      schema = jsonSchemaFor(def.parameters);
    } catch (_) {
      schema = { type: "object", properties: {} };
    }
    // `verbose` is an ATK switch; inside a script results are always raw.
    if (schema?.properties?.verbose) {
      schema = { ...schema, properties: { ...schema.properties } };
      delete schema.properties.verbose;
    }
    const tier = tierOf(def.name);
    const props = Object.keys(schema?.properties || {});
    const required = (schema?.required || []).filter((n) => !("default" in (schema.properties?.[n] || {})));
    const paramType = props.length ? schemaToTs(schema, "  ") : null;
    const argList = paramType ? `p${required.length ? "" : "?"}: ${paramType}` : "";
    const resultType = RESULT_TYPES[def.name] ? reindent(RESULT_TYPES[def.name], "  ") : "any";
    const decl =
      `  /** ${oneLine(def.description)} @tier ${tier} */\n` +
      `  ${def.name}(${argList}): Promise<${resultType}>;`;
    entries.push({
      name: def.name,
      tier,
      area: areaOf(def.name),
      typed: !!RESULT_TYPES[def.name],
      summary: firstSentence(def.description),
      description: oneLine(def.description),
      decl,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(entries.map((e) => [e.name, e]));

  const declare = (list) => `declare const autodom: {\n${list.map((e) => e.decl).join("\n")}\n};`;

  return {
    names: entries.map((e) => e.name),
    has: (name) => byName.has(name),
    entry: (name) => byName.get(name),
    /** Full declaration for every bound tool. */
    dts: () => `${GLOBALS_DTS}\n${declare(entries)}`,
    /** One line per tool, `name [tier] summary`, grouped under `## area` (or one area only). */
    index: (onlyArea) => {
      const out = [];
      for (const area of AREA_NAMES) {
        if (onlyArea && area !== onlyArea) continue;
        const list = entries.filter((e) => e.area === area);
        if (!list.length) continue;
        out.push(`## ${area}`);
        for (const e of list) out.push(`${e.name} [${e.tier}] ${e.summary}${e.typed ? "" : " (returns any)"}`);
      }
      return out.join("\n");
    },
    areas: () => AREA_NAMES.filter((a) => entries.some((e) => e.area === a)),
    /** Declarations for the given names; unknown names are reported. */
    declare: (names) => {
      const found = [];
      const missing = [];
      for (const n of names) (byName.has(n) ? found : missing).push(n);
      return { text: found.length ? declare(found.map((n) => byName.get(n))) : "", missing };
    },
    /** Best matches for a free-text query, by name and description terms. */
    search: (query, limit = 8) => {
      const terms = String(query || "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean);
      if (!terms.length) return [];
      const scored = [];
      for (const e of entries) {
        const name = e.name.toLowerCase();
        const desc = e.description.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (name === t) score += 10;
          else if (name.includes(t)) score += 4;
          if (desc.includes(t)) score += 1;
        }
        if (score > 0) scored.push([score, e]);
      }
      scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
      return scored.slice(0, limit).map(([, e]) => e.name);
    },
  };
}

export const GLOBALS_DTS = `// Globals available to run_code scripts (async function body: await + return).
declare const page: {
  /** Run fn in the active tab's page (MAIN world) and return its JSON result.
   *  fn is serialized with toString(): it cannot close over script variables; pass them as args (JSON). */
  eval<T = any>(fn: ((...args: any[]) => T | Promise<T>) | string, ...args: any[]): Promise<T>;
};
/** Attach a screenshot to the run_code result. ref comes from autodom.take_screenshot(). */
declare function emitImage(ref: { imageRef: string } | string): void;
declare function sleep(ms: number): Promise<void>;
// console.log/info/warn/error are captured and returned as logs.
// A failed tool call throws Error { name: "ToolError" | "InvalidParams" | "TierDenied", message, tool, details? }.
// No fetch, require, timers or filesystem: reach the browser only through autodom.* and page.eval.`;
