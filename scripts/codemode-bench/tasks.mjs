// Code Mode benchmark: pages, in-page extractors and tasks.
//
// capture.mjs records what the real tools return on these pages (once, from
// a live browser) into tests/fixtures/codemode-bench/. bench.mjs replays each
// task twice through a real AutoDOM server against those recordings: as the
// tool calls an agent makes without Code Mode, and as run_code scripts.
//
// Extractors carry a /*bench:<label>*/ marker so the replaying fake
// extension can answer execute_code from the recording.

export const PAGES = {
  hn: "https://news.ycombinator.com/",
  wiki: "https://en.wikipedia.org/wiki/WebAssembly",
  search: "https://en.wikipedia.org/w/index.php?search=WebAssembly+runtime&fulltext=1&ns0=1",
};

export const EVALS = {
  hn_top5:
    "/*bench:hn_top5*/ return [...document.querySelectorAll('tr.athing')].slice(0, 5).map((r) => {" +
    " const sub = r.nextElementSibling;" +
    " return { title: r.querySelector('.titleline > a')?.textContent," +
    " points: parseInt(sub?.querySelector('.score')?.textContent) || 0," +
    " comments: parseInt([...(sub?.querySelectorAll('a') || [])].pop()?.textContent) || 0 }; });",
  wiki_outline:
    "/*bench:wiki_outline*/ return { title: document.querySelector('h1')?.textContent," +
    " intro: document.querySelector('#mw-content-text p:not(.mw-empty-elt)')?.textContent.trim().slice(0, 400)," +
    " sections: [...document.querySelectorAll('#mw-content-text h2')].map((h) => h.textContent.trim()) };",
  search_first:
    "/*bench:search_first*/ const a = document.querySelector('.mw-search-result-heading a');" +
    " return a ? { title: a.textContent, href: a.href } : null;",
};

// What gets recorded on each page. `result` is the page the first search
// hit leads to; capture.mjs fills in its URL.
export const CAPTURE = {
  hn: { tools: ["get_page_info", "get_dom_state", "take_snapshot", "extract_text"], evals: ["hn_top5"] },
  wiki: { tools: ["get_page_info", "get_dom_state", "take_snapshot", "extract_text"], evals: ["wiki_outline"] },
  search: { tools: ["get_page_info", "get_dom_state", "take_snapshot"], evals: ["search_first"] },
  result: { tools: ["get_page_info"], evals: [] },
};

// Each task: `classic` is the tool-call sequence an agent makes with the
// standard tools (the strongest reasonable one: it already uses
// execute_code where a plain tool cannot pair the data). `code` is the
// Code Mode version. `ctx` is filled from the recordings at replay time.
export const TASKS = [
  {
    id: "hn_top5",
    goal: "Top 5 Hacker News stories with points and comment counts",
    classic: () => [
      ["navigate", { url: PAGES.hn }],
      ["take_snapshot", {}],
      ["execute_code", { code: EVALS.hn_top5 }],
    ],
    code: () => [
      ["code_api", { tools: ["navigate"] }],
      [
        "run_code",
        { code: `await autodom.navigate({ url: ${JSON.stringify(PAGES.hn)} });\nreturn await page.eval(${JSON.stringify(EVALS.hn_top5)});` },
      ],
    ],
  },
  {
    id: "wiki_outline",
    goal: "Outline of a Wikipedia article: title, intro, section headings",
    classic: () => [
      ["navigate", { url: PAGES.wiki }],
      ["extract_text", {}],
    ],
    code: () => [
      ["code_api", { tools: ["navigate"] }],
      [
        "run_code",
        { code: `await autodom.navigate({ url: ${JSON.stringify(PAGES.wiki)} });\nreturn await page.eval(${JSON.stringify(EVALS.wiki_outline)});` },
      ],
    ],
  },
  {
    id: "search_open_first",
    goal: "Search Wikipedia, open the first result, report its title and URL",
    classic: (ctx) => [
      ["navigate", { url: PAGES.search }],
      ["get_dom_state", {}],
      ["click_by_index", { index: ctx.firstResultIndex }],
      ["get_page_info", {}],
    ],
    code: () => [
      ["code_api", { tools: ["navigate", "get_page_info"] }],
      [
        "run_code",
        {
          code:
            `await autodom.navigate({ url: ${JSON.stringify(PAGES.search)} });\n` +
            `const first = await page.eval(${JSON.stringify(EVALS.search_first)});\n` +
            "if (!first) return { found: false };\n" +
            "await autodom.navigate({ url: first.href });\n" +
            "const info = await autodom.get_page_info();\n" +
            "return { title: info.title, url: info.url };",
        },
      ],
    ],
  },
];
