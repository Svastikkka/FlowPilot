import { test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserDriver } from '../src/engine/driver';
import { createRunRecord, WorkflowRunner } from '../src/engine/runner';
import type { DomRequest } from '../src/shared/messages';
import type { Step, Workflow } from '../src/shared/schema/types';
import { createStep } from '../src/shared/schema/actions';
import { newWorkflow } from '../src/shared/schema/factory';
import { validateWorkflow } from '../src/shared/schema/validate';
import { exportWorkflows, parseImport } from '../src/shared/schema/importExport';
import { parseCsv, toCsv } from '../src/shared/csv';
import { appendEvent, newSession } from '../src/shared/recorder';
import { bestLocator } from '../src/content/recorder';
import { performDomRequest } from '../src/content/domActions';

// Engine performance benchmark: times hot paths in Node (jsdom for DOM code)
// and writes bench/results/engine.json. Each metric is the median of several
// samples after a warm-up.

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 5);

interface Metric {
  id: string;
  title: string;
  unit: 'ms';
  value: number;
  samples: number[];
}

const metrics: Metric[] = [];

async function measure(id: string, title: string, fn: () => unknown | Promise<unknown>, per = 1) {
  await fn(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    await fn();
    samples.push((performance.now() - t) / per);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const value = Number(sorted[Math.floor(sorted.length / 2)].toFixed(4));
  metrics.push({ id, title, unit: 'ms', value, samples: samples.map((s) => Number(s.toFixed(4))) });
}

/** A driver whose page answers instantly, so only engine overhead is measured. */
const instantDriver: BrowserDriver = {
  prepareTab: async () => 1,
  navigate: async () => undefined,
  history: async () => undefined,
  waitForSettle: async () => undefined,
  screenshot: async () => 'data:,',
  dom: (async (_t: number, req: DomRequest) => {
    if (req.op === 'probe') return { count: 1, visible: true, enabled: true };
    if (req.op === 'pageInfo') return { url: 'https://bench.test/', title: 'T', readyState: 'complete' };
    return { message: 'ok', sensitive: false };
  }) as BrowserDriver['dom'],
};

const quiet = { saveRun: async () => undefined, saveArtifact: async () => 'a' };
const fast = { defaultTimeoutMs: 5000, defaultRetries: 0, defaultOnError: 'stop' as const, stepDelayMs: 0 };

async function run(workflow: Workflow) {
  const runner = new WorkflowRunner(createRunRecord(workflow, { target: { kind: 'newTab' } }), {}, {
    driver: instantDriver,
    persistence: quiet,
    options: { highlightElements: false, pollIntervalMs: 10, retryBackoffMs: 1 },
  });
  const result = await runner.execute();
  if (result.status !== 'succeeded') throw new Error(`bench run ${result.status}: ${result.error?.message}`);
}

test('engine benchmark', async () => {
  // Engine: per-step overhead with an instant page.
  const flat = newWorkflow({ settings: fast, steps: Array.from({ length: 500 }, (_, i) => createStep('clear', { params: { locator: { strategy: 'css', value: `#f${i}` } } }) as Step) });
  await measure('engine.step_overhead', 'Engine overhead per page step (500 steps, instant page)', () => run(flat), 500);

  // Engine: loop throughput.
  const loop = newWorkflow({
    settings: fast,
    variables: [{ name: 'n', defaultValue: '0' }],
    steps: [createStep('repeat', { params: { times: 5000, loopVariable: 'i' }, children: [createStep('setVariable', { params: { variable: 'n', operation: 'increment', value: '1', pattern: '', replacement: '' } }) as Step] }) as Step],
  });
  await measure('engine.loop_5000', 'Repeat block, 5,000 iterations with Set variable', () => run(loop));

  // Data.
  const csvText = toCsv(
    Array.from({ length: 10 }, (_, i) => `col${i}`),
    Array.from({ length: 5000 }, (_, r) => Array.from({ length: 10 }, (_, c) => `value ${r}-${c}, "quoted"`)),
  );
  await measure('csv.parse_5000x10', 'Parse a 5,000-row × 10-column CSV', () => parseCsv(csvText));

  // Validation and import.
  const big = newWorkflow({
    settings: fast,
    steps: Array.from({ length: 100 }, () =>
      createStep('forEachElement', {
        params: { locator: { strategy: 'css', value: 'li' }, loopVariable: 'it', maxItems: 10 },
        children: [
          createStep('extractText', { params: { locator: { strategy: 'css', value: '{{it_selector}} a' }, variable: 'v', all: false } }) as Step,
          createStep('if', { params: { condition: 'variable', variable: 'v', operator: 'contains', value: 'x', locator: { strategy: 'css', value: '' } }, children: [createStep('addRow', { params: { columns: [{ name: 'v', value: '{{v}}' }] } }) as Step], elseChildren: [] }) as Step,
        ],
      }) as Step,
    ),
  });
  await measure('validate.500_steps', 'Validate a 500-step nested workflow', () => {
    if (!validateWorkflow(big).valid) throw new Error('bench workflow invalid');
  });
  const file = exportWorkflows(Array.from({ length: 10 }, () => big));
  await measure('import.10_workflows', 'Import a file with 10 × 500-step workflows', () => parseImport(file));

  // Recorder.
  await measure('recorder.append_10k', 'Fold 10,000 recorded events into steps', () => {
    const s = newSession('b', 1, 'https://bench.test/', 0);
    for (let i = 0; i < 10_000; i++) {
      appendEvent(s, { kind: 'input', locator: { strategy: 'css', value: `#f${i % 50}` }, value: `v${i}`, sensitive: false, field: 'f', at: i * 10 });
    }
  });

  // DOM code on a large page.
  document.body.innerHTML = `<main>${Array.from({ length: 400 }, (_, i) => `<section class="card"><h3>Item ${i}</h3><p>Text ${i}</p><a href="/item/${i}">Open</a><button>Buy</button></section>`).join('')}</main>`;
  const targets = Array.from(document.querySelectorAll('a, button')).filter((_, i) => i % 4 === 0).slice(0, 200);
  await measure('locator.best_per_element', 'Generate a stable locator (2,000-node page), per element', () => targets.forEach((el) => bestLocator(document, el)), targets.length);
  await measure('dom.extract_all_400', 'Extract text from 400 matching elements', () => performDomRequest(document, { op: 'extractText', locator: { strategy: 'css', value: '.card h3' }, all: true }));

  const out = resolve('bench/results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'engine.json'), JSON.stringify({ kind: 'engine', createdAt: new Date().toISOString(), node: process.version, samples: SAMPLES, metrics }, null, 2));
  for (const m of metrics) console.log(`${m.id.padEnd(28)} ${m.value.toFixed(3).padStart(10)} ms  ${m.title}`);
}, 300_000);
