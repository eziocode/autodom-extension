export default async function ({ page, params, log }) {
  const url = params.url || "https://example.com";
  log("Opening", url);

  await page.goto(url, { waitUntil: "domcontentloaded" });

  return {
    title: await page.title(),
    url: page.url(),
    h1: await page.locator("h1").first().textContent().catch(() => null),
  };
}
