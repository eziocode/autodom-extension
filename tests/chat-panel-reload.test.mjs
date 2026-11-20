// Run with PLAYWRIGHT_PATH and optionally CHROME_BIN for the Chromium build
// under test. A fresh non-incognito profile keeps the user's browser untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("extension reload replaces an orphaned panel in an existing strict-CSP tab", {
  skip: process.env.PLAYWRIGHT_PATH ? false : "Set PLAYWRIGHT_PATH to run browser integration tests",
  timeout: 45000,
}, async (t) => {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH);
  const extension = fileURLToPath(new URL("../extension", import.meta.url));
  const profile = await mkdtemp(join(tmpdir(), "autodom-panel-reload-"));
  const site = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "style-src 'none'" });
    res.end("<!doctype html><title>Panel reload fixture</title>");
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  let context;
  t.after(async () => {
    await context?.close();
    site.close();
    await rm(profile, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN, channel: "chromium",
    args: ["--enable-unsafe-extension-debugging"], ignoreDefaultArgs: ["--disable-extensions"],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const load = async () => {
    const ready = context.waitForEvent("serviceworker", {
      predicate: w => w.url().endsWith("/background/service-worker.js"),
    });
    await cdp.send("Extensions.loadUnpacked", { path: extension });
    return ready;
  };
  const oldWorker = await load();
  const page = context.pages()[0];
  const url = "http://127.0.0.1:" + site.address().port + "/";
  await page.goto(url);
  const tabId = await oldWorker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, url);
  const mount = w => w.evaluate(tabId => ensureChatPanelInjected(tabId), tabId);
  const toggle = w => w.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: "TOGGLE_CHAT_PANEL" }), tabId);
  // An installed older version can leave a visible panel and a delayed
  // teardown that still looks up the replacement roots by ID.
  await page.evaluate(() => {
    const legacy = document.createElement("div");
    legacy.id = "__autodom_chat_panel";
    document.documentElement.appendChild(legacy);
  });
  await mount(oldWorker);
  const mounted = await page.locator("#__autodom_chat_panel").elementHandle();
  await page.evaluate(() => {
    for (const selector of ["#__autodom_chat_panel", "#__autodom_inline_overlay", ".autodom-inline-backdrop"]) {
      document.querySelector(selector).remove();
    }
  });
  assert.equal(await mounted.evaluate(el => el.isConnected), true);
  assert.equal(await page.locator("#__autodom_inline_overlay").count(), 1);
  assert.equal(await page.locator(".autodom-inline-backdrop").count(), 1);
  await toggle(oldWorker);
  const panel = page.locator("#__autodom_chat_panel");
  const original = await panel.elementHandle();
  const before = await page.evaluate(() => performance.timeOrigin);
  assert.equal(await panel.evaluate(el => el.classList.contains("open")), true);

  const freshWorker = await load();
  await mount(freshWorker);
  assert.equal(await page.evaluate(() => performance.timeOrigin), before);
  assert.equal(await original.evaluate(el => el.isConnected), false);
  await mount(freshWorker);
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.evaluate(el => getComputedStyle(el).position), "fixed");
  const open = await panel.evaluate(el => el.classList.contains("open"));
  await toggle(freshWorker);
  assert.equal(await panel.evaluate(el => el.classList.contains("open")), !open);
  // Let a visible pre-reload panel's five-second status poll run.
  const replacement = await panel.elementHandle();
  await new Promise(resolve => setTimeout(resolve, 5500));
  assert.equal(await replacement.evaluate(el => el.isConnected), true);
  assert.equal(await page.locator(":root > .autodom-inline-backdrop").count(), 1);
});
