// Sample Playwright automation script to verify the AutoDOM automation pipeline.
//
// Run via MCP `run_automation_script`:
//   {
//     "backend": "playwright",
//     "scriptPath": "<abs-path>/examples/playwright-test-automation.mjs",
//     "params": { "query": "playwright" },
//     "browser": "chromium",
//     "headless": true,
//     "timeoutMs": 60000
//   }

export default async function ({ page, params, log }) {
  const query = params.query || "autodom";
  const startUrl = params.url || "https://duckduckgo.com/";

  log("Navigating to", startUrl);
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });

  log("Filling search input with:", query);
  const searchBox = page.locator('input[name="q"]').first();
  await searchBox.waitFor({ state: "visible", timeout: 10000 });
  await searchBox.fill(query);
  await searchBox.press("Enter");

  log("Waiting for results");
  await page.waitForLoadState("domcontentloaded");
  await page
    .locator('[data-testid="result"], article, ol li')
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => log("No results selector matched; continuing"));

  const results = await page.evaluate(() => {
    const nodes = document.querySelectorAll(
      '[data-testid="result"] a[data-testid="result-title-a"], a.result__a, h2 a',
    );
    return Array.from(nodes)
      .slice(0, 5)
      .map((a) => ({ title: a.textContent.trim(), href: a.href }));
  });

  log(`Captured ${results.length} results`);

  return {
    ok: true,
    query,
    finalUrl: page.url(),
    title: await page.title(),
    resultCount: results.length,
    results,
  };
}
