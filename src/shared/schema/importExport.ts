import { SCHEMA_VERSION } from './types';
import type { Workflow } from './types';
import { LIMITS, workflowSchema } from './zod';
import { checkUrl, validateWorkflow } from './validate';
import { cloneWorkflow } from './factory';
import { flatten } from './tree';

export const EXPORT_FORMAT = 'flowpilot.workflows';

export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  workflows: Workflow[];
}

export function exportWorkflows(workflows: Workflow[], now = new Date()): string {
  const envelope: ExportEnvelope = {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    // Run metadata is local history, not part of the definition.
    workflows: workflows.map(({ lastRun: _lastRun, ...wf }) => wf as Workflow),
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Migrations from older schema versions, keyed by the version they upgrade
 * FROM. Each takes a raw workflow object and returns one at version + 1.
 */
const MIGRATIONS: Record<number, (wf: Record<string, unknown>) => Record<string, unknown>> = {
  // v2 added optional block children and data tables; v1 workflows are valid as-is.
  1: (wf) => ({ ...wf, schemaVersion: 2 }),
};

/** Upgrades a workflow read from local storage that was saved by an older version. */
export function upgradeStoredWorkflow(wf: Workflow): Workflow {
  const version = (wf as { schemaVersion: number }).schemaVersion;
  if (version === SCHEMA_VERSION) return wf;
  return migrateWorkflow(wf as unknown as Record<string, unknown>, version) as unknown as Workflow;
}

export function migrateWorkflow(raw: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let current = raw;
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) throw new ImportError(`Cannot upgrade workflows from schema version ${v}`);
    current = migrate(current);
  }
  return { ...current, schemaVersion: SCHEMA_VERSION };
}

export class ImportError extends Error {}

export interface ImportedWorkflow {
  workflow: Workflow;
  warnings: string[];
  /** Validation errors that make the workflow a draft until fixed. */
  draftReasons: string[];
}

export interface ImportResult {
  imported: ImportedWorkflow[];
  rejected: { name: string; reasons: string[] }[];
}

/**
 * Parses an import file. Structurally invalid workflows are rejected; workflows
 * that are well-formed but fail semantic checks are imported as drafts. All ids
 * are regenerated so imports never overwrite existing workflows.
 */
export function parseImport(text: string, now = Date.now()): ImportResult {
  if (new Blob([text]).size > LIMITS.maxImportBytes) {
    throw new ImportError(`File is larger than ${LIMITS.maxImportBytes / 1024 / 1024} MB`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('File is not valid JSON');
  }
  if (!data || typeof data !== 'object') throw new ImportError('File is not a FlowPilot export');

  let rawList: unknown[];
  let version: number;
  const obj = data as Record<string, unknown>;
  if (obj.format === EXPORT_FORMAT) {
    if (!Array.isArray(obj.workflows)) throw new ImportError('Export file has no workflows list');
    rawList = obj.workflows;
    version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : NaN;
  } else if ('steps' in obj && 'schemaVersion' in obj) {
    rawList = [obj];
    version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : NaN;
  } else {
    throw new ImportError('File is not a FlowPilot export');
  }

  if (!Number.isInteger(version) || version < 1) throw new ImportError('Unknown schema version');
  if (version > SCHEMA_VERSION) {
    throw new ImportError(`This file uses schema version ${version}; update FlowPilot to import it`);
  }
  if (rawList.length > LIMITS.maxWorkflowsPerImport) {
    throw new ImportError(`A file can contain at most ${LIMITS.maxWorkflowsPerImport} workflows`);
  }

  const result: ImportResult = { imported: [], rejected: [] };
  for (const raw of rawList) {
    const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
      ? String((raw as { name: string }).name).slice(0, 80)
      : '(unnamed)';
    if (!raw || typeof raw !== 'object') {
      result.rejected.push({ name, reasons: ['Not an object'] });
      continue;
    }
    let migrated: Record<string, unknown>;
    try {
      migrated = migrateWorkflow(raw as Record<string, unknown>, version);
    } catch (e) {
      result.rejected.push({ name, reasons: [(e as Error).message] });
      continue;
    }
    // Fill in ids/timestamps if a hand-written file omitted them.
    const withDefaults = {
      id: 'import',
      description: '',
      tags: [],
      favorite: false,
      variables: [],
      createdAt: now,
      updatedAt: now,
      ...migrated,
      lastRun: undefined,
    };
    const parsed = workflowSchema.safeParse(withDefaults);
    if (!parsed.success) {
      result.rejected.push({
        name,
        reasons: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'workflow'}: ${i.message}`),
      });
      continue;
    }
    const blocked = flatten(parsed.data.steps).find(
      (s) => s.type === 'openUrl' && checkUrl(s.params.url) === 'This URL scheme is not allowed',
    );
    if (blocked) {
      result.rejected.push({ name, reasons: ['Contains a URL with a blocked scheme (e.g. javascript:)'] });
      continue;
    }
    const workflow = cloneWorkflow(parsed.data as Workflow, { favorite: false }, now);
    const validation = validateWorkflow(workflow);
    result.imported.push({
      workflow,
      warnings: validation.warnings.map((w) => w.message),
      draftReasons: validation.errors.map((e) => e.message),
    });
  }
  return result;
}
