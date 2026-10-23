import { createRunRecord, initialVariables, WorkflowRunner } from '../../src/engine/runner';
import type { PendingPrompt, PromptResponse, RunRecord, Workflow } from '../../src/shared/schema/types';
import type { JsdomBrowser } from './jsdomBrowser';
import { FAST_ENGINE, MemoryPersistence } from './fakes';

export interface RunOptions {
  inputs?: Record<string, string>;
  answer?: (prompt: PendingPrompt) => PromptResponse;
  onStart?: (runner: WorkflowRunner, browser: JsdomBrowser) => void;
  target?: RunRecord['target'];
}

/** Runs a workflow with the real engine against a JsdomBrowser, answering prompts automatically. */
export async function runWorkflow(workflow: Workflow, browser: JsdomBrowser, opts: RunOptions = {}) {
  const persistence = new MemoryPersistence();
  const prompts: PendingPrompt[] = [];
  const run = createRunRecord(workflow, { target: opts.target ?? { kind: 'newTab' } });
  let runner!: WorkflowRunner;
  runner = new WorkflowRunner(run, initialVariables(workflow, opts.inputs), {
    driver: browser,
    persistence,
    options: FAST_ENGINE,
    onPrompt: (r) => {
      const p = r.pendingPrompt!;
      prompts.push(p);
      queueMicrotask(() => runner.respond(p.id, opts.answer ? opts.answer(p) : { action: 'continue' }));
    },
  });
  opts.onStart?.(runner, browser);
  const result = await runner.execute();
  return { result, prompts, persistence, tabId: result.tabId! };
}

