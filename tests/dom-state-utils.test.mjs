import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  resolve(root, "extension/background/service-worker.js"),
  "utf8",
);

function loadInjectedHelper(name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} helper is present`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      bodyEnd = index;
      break;
    }
  }
  assert.notEqual(bodyEnd, -1, `${name} helper is complete`);
  const expression = source.slice(start + marker.length, bodyEnd + 1);
  return Function(`"use strict"; return (${expression});`)();
}

const countInteractiveDescendants = loadInjectedHelper(
  "countInteractiveDescendants",
);

function node(parentElement = null, noisy = false) {
  return { parentElement, noisy };
}

test("descendant counts match noisy-container semantics and cap at four", () => {
  const rootNode = node();
  const noisy = node(rootNode, true);
  const children = Array.from({ length: 12 }, () => node(noisy));
  const result = countInteractiveDescendants(
    [noisy, ...children],
    rootNode,
    (item) => item.noisy,
  );
  assert.equal(result.get(noisy), 4);
});

test("fast path performs no ancestor walk when no noisy candidates exist", () => {
  const rootNode = node();
  const children = Array.from({ length: 5000 }, () => node(rootNode));
  const result = countInteractiveDescendants(children, rootNode, () => false);
  assert.equal(result.size, 0);
});

test("helper contains no per-candidate subtree selector scan", () => {
  assert.doesNotMatch(
    countInteractiveDescendants.toString(),
    /querySelectorAll/,
  );
});
