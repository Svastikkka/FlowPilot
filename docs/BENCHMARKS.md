# Benchmarks

The test suites answer "does it work?". The benchmark answers "how reliably,
and how fast?", and whether that changed. It runs on every pull request, on
pushes to `main`, weekly, and on demand
([`.github/workflows/benchmark.yml`](../.github/workflows/benchmark.yml)).

## What it measures

### Reliability (browser benchmark)

[`bench/scenarios.ts`](../bench/scenarios.ts) defines scenarios on a local
benchmark site ([`bench/site.ts`](../bench/site.ts)). Each one reproduces a
pattern that breaks automation on real websites. Every scenario runs **3 times**
through the real, built extension in Chromium (service worker, content script,
IndexedDB), using FlowPilot's default settings, and is checked against what
should have happened (the form the server received, the rows collected, the
text read).

| Category | Scenarios |
|---|---|
| Waiting | element that appears 1.5 s late · server that responds after 2 s · button re-created by a framework re-render · single-page-app navigation |
| Forms | form with client-side validation, filled by field labels · input whose value the page keeps in its own state (React-style) |
| Data & logic | 5-page pagination · 60-post infinite scroll · 25-row CSV · cookie banner on about half the loads (If / Else) |
| Robustness | record a checkout, then replay it on the same page and on a changed page (new generated ids and classes, extra wrappers, reordered buttons) |
| Known limits | shadow DOM · iframes. These are expected to fail and are reported but never fail the run. If one starts passing, the report says so. |

The **reliability score** is the share of successful attempts across all
scenarios expected to work.

### Engine performance (engine benchmark)

[`bench/engine.bench.ts`](../bench/engine.bench.ts) times hot paths in Node
(jsdom for page code), as the median of 5 samples after a warm-up: engine
overhead per step, 5,000-iteration loops, CSV parsing, validation and import of
large workflows, recorder throughput, locator generation and bulk text
extraction.

## When it fails

`bench/report.mjs` fails the run when:

- a scenario expected to work passes **fewer than 2 of 3** attempts. Passing 2
  of 3 is reported as **⚠️ flaky** without failing, so it's visible but doesn't
  block, or
- a median is over its budget in [`bench/budgets.json`](../bench/budgets.json).

Budgets are deliberately generous (about 3× local browser times, 15× local
engine times). CI runners are slower and noisier than a laptop, so budgets
catch real slowdowns, such as an accidental extra wait or a quadratic loop,
rather than machine noise.

Comparisons with [`bench/baseline.json`](../bench/baseline.json) ("vs baseline",
"less reliable than baseline") are informational only.

## Reading the report

The report appears on the workflow run's **Summary** page, and is uploaded as
the `benchmark-results` artifact with the raw `browser.json` and `engine.json`.

| Status | Meaning |
|---|---|
| ✅ | Passed every attempt, within budget |
| ⚠️ flaky | Passed 2 of 3: investigate before it becomes a failure |
| ❌ failing / over budget | Fails the run |
| ➖ known limit | Expected to fail (shadow DOM, iframes) |
| 🎉 now passes | A known limit started working: change its `expected` to `'pass'` |
| ↓ less reliable than baseline | Pass rate dropped compared with `bench/baseline.json` |

## Running it locally

```bash
npx playwright install chromium   # once
npm run bench                     # build + engine + browser + report (about 7 minutes)
npm run bench:engine              # engine benchmark only (seconds)
npm run bench:browser             # browser benchmark only
npm run bench:report              # rebuild the report from bench/results/
```

Useful environment variables:

| Variable | Effect |
|---|---|
| `BENCH_ATTEMPTS=5` | Attempts per scenario (default 3) |
| `BENCH_ONLY=pagination,rerender` | Run only these scenarios |
| `BENCH_SAMPLES=10` | Samples per engine metric (default 5) |
| `BENCH_DEBUG=1` | Extra diagnostics when the harness itself fails |

`npm run bench:browser` uses the extension in `dist/`, so run `npm run build`
first if you changed code (`npm run bench` does this for you).

## Changing the benchmark

**Add a scenario:** add a page to `bench/site.ts` that reproduces the pattern,
then add an entry to `SCENARIOS` in `bench/scenarios.ts` with the workflow (as a
user would build it) and a `verify` function that checks the outcome, not just
that the run "succeeded". Add a budget to `bench/budgets.json` of about 3× its
local median.

**Update the baseline** after a deliberate change (for example, a faster engine
or a new scenario): run `npm run bench`, then `npm run bench:baseline`, and
commit `bench/baseline.json`.

**Tighten a budget** only with evidence from several CI runs. Look at the
medians in the uploaded `browser.json` / `engine.json`.

## Findings so far

- **Generated ids broke recorded workflows.** The recorder used ids like
  `#f-1q2vb91`, which sites regenerate on every build, so replaying after a
  site update failed. Fixed: ids that mix letters and digits count as generated,
  and form fields are located by their `name` first. The "changed page" replay
  scenario now passes every attempt.
- **The default 250 ms pause between steps dominates long runs.** In the 25-row
  CSV scenario, about 44 of 70 seconds are that pause (7 steps × 25 rows ×
  250 ms). It's a deliberate default, but worth revisiting. Setting the pause
  to 0 in a workflow's Settings makes bulk runs much faster.
- **Shadow DOM and iframes are not supported yet.** Tracked as known limits.
