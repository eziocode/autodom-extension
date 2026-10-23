# Code Mode: measured cost

Code Mode lets the model drive the browser with one `run_code` script instead
of one MCP call per step (see the [README](../README.md#code-mode-experimental)).
This page records what that saves, measured with a repeatable benchmark, and
where the saving comes from.

## Method

`scripts/codemode-bench/bench.mjs` replays three tasks through a real AutoDOM
server, with ATK compaction on as shipped. The browser side is a fake
extension that answers from recordings of real pages, made on 2026-10-23 with
`scripts/codemode-bench/capture.mjs` (Hacker News, the Wikipedia article
"WebAssembly", and a Wikipedia search):

| Task | Goal |
|---|---|
| `hn_top5` | Top 5 Hacker News stories with points and comment counts |
| `wiki_outline` | Title, intro and section headings of a Wikipedia article |
| `search_open_first` | Search Wikipedia, open the first hit, report its title and URL |

Each task runs four ways:

| Approach | Tools listed | Transcript |
|---|---|---|
| classic | 117 (default) | The standard tools the usual way: `navigate`, `take_snapshot` or `get_dom_state`, `extract_text`, `click_by_index`, ... |
| classic+exec | 117 (default) | The standard tools, using `execute_code` wherever it helps. The strongest baseline without Code Mode. For `hn_top5` the classic run already does this. |
| code (hybrid) | 123 (`AUTODOM_CODE_MODE=1`) | `code_api` once, then one `run_code` script |
| code | 14 (`AUTODOM_CODE_MODE=only`) | The same `code_api` and `run_code` calls |

It counts the bytes the model would read. Every request carries the tool list
plus the conversation so far (each call's arguments and result), and a task
takes one request per call plus one for the answer. Tokens are estimated as
bytes / 4. All approaches must return the same answer, which the script checks
(`--check`).

## Results

| Task | Approach | Calls | Tool list B (x turns) | Results B | Args B | Input B | ~Tokens | vs classic | Input excl. tool list B | vs classic |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| hn_top5 | classic | 3 | 62,158 (x4) | 6,806 | 505 | 262,666 | 65,667 |  | 14,034 |  |
| hn_top5 | code (hybrid) | 2 | 65,597 (x3) | 1,425 | 543 | 199,759 | 49,940 | 24% less | 2,968 | 79% less |
| hn_top5 | code | 2 | 8,115 (x3) | 1,425 | 543 | 27,313 | 6,828 | 90% less | 2,968 | 79% less |
| wiki_outline | classic | 2 | 62,158 (x3) | 5,946 | 121 | 192,774 | 48,194 |  | 6,300 |  |
| wiki_outline | classic+exec | 2 | 62,158 (x3) | 604 | 417 | 187,728 | 46,932 | 3% less | 1,254 | 80% less |
| wiki_outline | code (hybrid) | 2 | 65,597 (x3) | 1,446 | 494 | 199,731 | 49,933 | 4% more | 2,940 | 53% less |
| wiki_outline | code | 2 | 8,115 (x3) | 1,446 | 494 | 27,285 | 6,821 | 86% less | 2,940 | 53% less |
| search_open_first | classic | 4 | 62,158 (x5) | 5,612 | 250 | 327,046 | 81,762 |  | 16,256 |  |
| search_open_first | classic+exec | 4 | 62,158 (x5) | 1,197 | 436 | 314,248 | 78,562 | 4% less | 3,458 | 79% less |
| search_open_first | code (hybrid) | 2 | 65,597 (x3) | 1,434 | 589 | 200,126 | 50,032 | 39% less | 3,335 | 79% less |
| search_open_first | code | 2 | 8,115 (x3) | 1,434 | 589 | 27,680 | 6,920 | 92% less | 3,335 | 79% less |

Across the three tasks, `code` reads about 82 KB (about 20,600 tokens)
against about 782 KB (about 195,600 tokens) for `classic`. The raw numbers
are in [codemode-bench.json](codemode-bench.json).

## What the numbers say

1. **The tool list is most of the saving.** The default list is 62 KB and goes
   out with every request. `AUTODOM_CODE_MODE=only` lists 14 tools in 8 KB.
   That accounts for most of the 86-92% drop in total input. Most MCP clients
   prompt-cache the tool list, so in practice this part is billed as cheap
   cache reads rather than full input, but it still fills the context window.
2. **Leaving the tool list out, Code Mode reads 53-79% less than the
   standard tools used the usual way** (9.2 KB against 36.6 KB over the three
   tasks), because page snapshots and page text never reach the model.
3. **Against a classic agent that already uses `execute_code` well, Code Mode
   is about even.** On the single-page task it reads more (2.9 KB against
   1.3 KB). On the multi-step task it is level (3.3 KB against 3.5 KB) and
   needs 2 calls instead of 4. Most of Code Mode's bytes here are `code_api`
   (946-1,242 B per task), which a session pays once and not per task. The
   `run_code` results alone are 192-500 B.
4. **Hybrid mode is not worth it on its own.** Listing the Code Mode tools
   next to everything else makes the tool list 3.4 KB bigger, so a one-step
   task costs 4% more than classic. Code Mode pays off with
   `AUTODOM_CODE_MODE=only`.
5. **Fewer turns.** Code Mode needed 2 calls where the classic runs needed 2-4.
   Each saved turn is a model round trip (latency and output tokens), which
   this benchmark does not measure.

## Limits

- No model runs. The transcripts are hand-written and minimal, so they show
  no retries, extra snapshots or wrong turns. Real classic runs usually take
  more steps than these, and real scripts sometimes fail and are rewritten.
  The benchmark measures what each approach costs when it goes right, not
  which one a model uses better.
- Three tasks on three sites. Tasks with more steps per page favour Code
  Mode more; single lookups favour a well-used `execute_code`.
- `click_by_index` was not recorded, because recording it would have meant
  clicking on the live page. The replay uses the extension's documented
  result shape, about 100 B.
- Tokens are bytes / 4, not a tokenizer count.

## Rerun

```bash
node scripts/codemode-bench/bench.mjs --check
```

CI runs this: it fails if the approaches disagree on an answer, or if Code
Mode reads more than the best classic approach on any task. To refresh the
recordings, with the extension connected to a running bridge:

```bash
node scripts/codemode-bench/capture.mjs
```

The capture script starts its own server, which joins the running bridge as a
proxy. It visits the pages in its own background tab group, only reads them,
and closes the group when it is done.
