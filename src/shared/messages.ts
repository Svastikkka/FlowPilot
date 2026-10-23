import type { DataTable, Locator, PromptResponse, RunRecord, RunTarget, ScrollParams, SelectParams } from './schema/types';
import type { SerializedError } from './errors';

// ---------------------------------------------------------------------------
// Background → content script (DOM operations on the run tab)

export const DOM_CHANNEL = 'flowpilot.dom';

export type DomRequest =
  | { op: 'probe'; locator: Locator }
  | { op: 'click'; locator: Locator; highlight?: boolean }
  | { op: 'type'; locator: Locator; text: string; clearFirst: boolean; pressEnter: boolean; highlight?: boolean }
  | { op: 'clear'; locator: Locator; highlight?: boolean }
  | { op: 'select'; locator: Locator; by: SelectParams['by']; value: string; highlight?: boolean }
  | { op: 'check'; locator: Locator; checked: boolean; highlight?: boolean }
  | { op: 'extractText'; locator: Locator; all: boolean }
  | { op: 'scroll'; mode: ScrollParams['mode']; locator?: Locator; x?: number; y?: number }
  | { op: 'markNth'; locator: Locator; index: number; mark: string }
  | { op: 'pageInfo' }
  | { op: 'textPresent'; text: string };

export interface ProbeResult {
  count: number;
  visible: boolean;
  enabled: boolean;
}
export interface PageInfo {
  url: string;
  title: string;
  readyState: DocumentReadyState;
}

export interface DomResultMap {
  probe: ProbeResult;
  click: { message: string };
  type: { message: string; sensitive: boolean };
  clear: { message: string };
  select: { message: string };
  check: { message: string };
  extractText: { text: string; count: number };
  scroll: { message: string };
  markNth: { found: boolean; total: number; text: string };
  pageInfo: PageInfo;
  textPresent: { present: boolean };
}

export type DomResult<Op extends DomRequest['op']> = DomResultMap[Op];

export type DomResponse = { ok: true; data: unknown } | { ok: false; error: SerializedError };

export interface DomMessage {
  channel: typeof DOM_CHANNEL;
  request: DomRequest;
}

// ---------------------------------------------------------------------------
// UI → background commands

export type Command =
  | { type: 'run.start'; workflowId: string; target: RunTarget; inputs: Record<string, string>; /** Replaces the workflow's data table for this run. */ table?: DataTable }
  | { type: 'run.testStep'; workflowId: string; stepId: string; inputs?: Record<string, string> }
  | { type: 'run.pause'; runId: string }
  | { type: 'run.resume'; runId: string }
  | { type: 'run.stop'; runId: string }
  | { type: 'run.resumeInterrupted'; runId: string; inputs?: Record<string, string> }
  | { type: 'prompt.respond'; runId: string; promptId: string; response: PromptResponse }
  | { type: 'runs.active' };

export interface CommandResultMap {
  'run.start': { runId: string };
  'run.testStep': { runId: string };
  'run.pause': null;
  'run.resume': null;
  'run.stop': null;
  'run.resumeInterrupted': { runId: string };
  'prompt.respond': null;
  'runs.active': { runIds: string[] };
}

export type CommandResponse<T extends Command['type']> =
  | { ok: true; data: CommandResultMap[T] }
  | { ok: false; error: SerializedError };

export const COMMAND_CHANNEL = 'flowpilot.command';

// ---------------------------------------------------------------------------
// Background → UI broadcast over a runtime Port

export const MONITOR_PORT = 'flowpilot.monitor';

export type MonitorEvent = { type: 'run.update'; run: RunRecord } | { type: 'hello'; activeRunIds: string[] };
