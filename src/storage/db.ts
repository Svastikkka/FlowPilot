import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { RunRecord, Workflow } from '../shared/schema/types';

// IndexedDB layout. Shared by the dashboard, popup and service worker (all run
// on the extension origin). Data is stored unencrypted on this device.

export interface Artifact {
  id: string;
  runId: string;
  label: string;
  dataUrl: string;
  createdAt: number;
}

export interface FlowPilotDB extends DBSchema {
  workflows: { key: string; value: Workflow; indexes: { updatedAt: number } };
  runs: { key: string; value: RunRecord; indexes: { workflowId: string; startedAt: number } };
  artifacts: { key: string; value: Artifact; indexes: { runId: string } };
}

export const DB_NAME = 'flowpilot';
export const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FlowPilotDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<FlowPilotDB>> {
  dbPromise ??= openDB<FlowPilotDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('workflows', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        const runs = db.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('workflowId', 'workflowId');
        runs.createIndex('startedAt', 'startedAt');
        db.createObjectStore('artifacts', { keyPath: 'id' }).createIndex('runId', 'runId');
      }
    },
    blocking() {
      // A newer version was opened elsewhere (e.g. after an update); let it proceed.
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
    },
  });
  return dbPromise;
}

/** Test helper: forget the cached connection. */
export async function resetDbConnection(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}
