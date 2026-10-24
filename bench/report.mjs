// Turns bench/results/{browser,engine}.json into a markdown report and decides
// whether the benchmark passes.
//
//   node bench/report.mjs                    report + exit 1 on failure
//   node bench/report.mjs --update-baseline  also save the results as bench/baseline.json
//
// Fails when:
//   - a scenario expected to work passes fewer than 2/3 of its attempts, or
//   - a timing exceeds its budget in bench/budgets.json.
// Comparisons with bench/baseline.json are informational: CI machines and
// laptops differ in speed, so only the generous budgets gate.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RESULTS = 'bench/results';
const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const browser = read(`${RESULTS}/browser.json`);
const engine = read(`${RESULTS}/engine.json`);
const budgets = read('bench/budgets.json') ?? { engine: {}, browser: {} };
const baseline = read('bench/baseline.json');

if (!browser && !engine) {
  console.error('No results found. Run npm run bench:engine and/or npm run bench:browser first.');
  process.exit(1);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(3)} ms`);
const delta = (now, before) => {
  if (now === null || now === undefined || !before) return '';
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 5) return '≈';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
};

const failures = [];
const lines = ['# FlowPilot benchmark', ''];
const summary = {};

if (browser) {
  const rows = [];
  let attempts = 0;
  let passedAttempts = 0;
  summary.browser = {};
  for (const sc of browser.scenarios) {
    const passed = sc.attempts.filter((a) => a.passed).length;
    const total = sc.attempts.length;
    const ms = median(sc.attempts.filter((a) => a.passed).map((a) => a.durationMs)) ?? median(sc.attempts.map((a) => a.durationMs));
    const budget = budgets.browser?.[sc.id];
    const before = baseline?.browser?.[sc.id];
    summary.browser[sc.id] = { passRate: passed / total, medianMs: ms };
    let status;
    if (sc.expected === 'unsupported') {
      status = passed > 0 ? '🎉 now passes — mark as supported' : '➖ known limit';
    } else {
      attempts += total;
      passedAttempts += passed;
      if (passed === total) status = '✅';
      else if (passed / total >= 2 / 3) status = '⚠️ flaky';
      else {
        status = '❌ failing';
        failures.push(`Scenario "${sc.id}" passed ${passed}/${total}: ${sc.attempts.find((a) => !a.passed)?.reason ?? ''}`);
      }
      if (budget && ms > budget) {
        status += ` ❌ over budget (${fmtMs(budget)})`;
        failures.push(`Scenario "${sc.id}" median ${fmtMs(ms)} is over its budget of ${fmtMs(budget)}`);
      }
      if (before && passed / total < before.passRate) status += ' ↓ less reliable than baseline';
    }
    const reason = sc.attempts.find((a) => !a.passed)?.reason;
    rows.push(`| ${sc.category} | ${sc.title} | ${passed}/${total} | ${fmtMs(ms)} | ${delta(ms, before?.medianMs)} | ${status}${reason && sc.expected !== 'unsupported' ? `<br><sub>${reason.replace(/\|/g, '\\|').slice(0, 140)}</sub>` : ''} |`);
  }
  const score = attempts ? (passedAttempts / attempts) * 100 : 0;
  summary.reliability = score;
  lines.push(
    `## Reliability: ${score.toFixed(1)}%`,
    '',
    `${passedAttempts} of ${attempts} attempts succeeded across ${browser.scenarios.filter((s) => s.expected === 'pass').length} scenarios (${browser.attemptsPerScenario} attempts each) in Chromium with the built extension.` +
      (baseline?.reliability !== undefined ? ` Baseline: ${baseline.reliability.toFixed(1)}%.` : ''),
    '',
    '| Category | Scenario | Passed | Median time | vs baseline | Status |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  );
}

if (engine) {
  summary.engine = {};
  lines.push('## Engine performance', '', `Median of ${engine.samples} samples, Node ${engine.node}.`, '', '| Metric | Value | Budget | vs baseline | Status |', '|---|---|---|---|---|');
  for (const m of engine.metrics) {
    summary.engine[m.id] = m.value;
    const budget = budgets.engine?.[m.id];
    const over = budget !== undefined && m.value > budget;
    if (over) failures.push(`Metric "${m.id}" is ${fmtMs(m.value)}, over its budget of ${fmtMs(budget)}`);
    lines.push(`| ${m.title} | ${fmtMs(m.value)} | ${budget === undefined ? '—' : fmtMs(budget)} | ${delta(m.value, baseline?.engine?.[m.id])} | ${over ? '❌ over budget' : '✅'} |`);
  }
  lines.push('');
}

lines.push(
  failures.length ? `## ❌ ${failures.length} problem${failures.length === 1 ? '' : 's'}` : '## ✅ All checks passed',
  '',
  ...failures.map((f) => `- ${f}`),
  '',
  '<sub>Timings depend on the machine; only the budgets in `bench/budgets.json` gate. "vs baseline" compares with `bench/baseline.json`.</sub>',
);

const report = lines.join('\n');
mkdirSync(RESULTS, { recursive: true });
writeFileSync(`${RESULTS}/report.md`, report + '\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

if (process.argv.includes('--update-baseline')) {
  const next = { createdAt: new Date().toISOString(), ...(baseline ?? {}), ...summary };
  writeFileSync('bench/baseline.json', JSON.stringify(next, null, 2) + '\n');
  console.log('\nSaved bench/baseline.json');
}

process.exit(failures.length ? 1 : 0);
