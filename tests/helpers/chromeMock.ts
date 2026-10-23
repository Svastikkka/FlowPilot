import { vi } from 'vitest';

// Minimal in-memory chrome.* surface for tests of storage and UI code.

type Listener = (...args: unknown[]) => unknown;

function event() {
  const listeners = new Set<Listener>();
  return {
    addListener: (l: Listener) => listeners.add(l),
    removeListener: (l: Listener) => listeners.delete(l),
    hasListener: (l: Listener) => listeners.has(l),
    emit: (...args: unknown[]) => listeners.forEach((l) => l(...args)),
    listeners,
  };
}

export interface ChromeMock {
  storageData: Record<string, unknown>;
  grantedOrigins: Set<string>;
  /** Handles chrome.runtime.sendMessage; tests replace this to simulate the service worker. */
  onCommand: (message: unknown) => unknown;
  ports: { name: string; onMessage: ReturnType<typeof event>; emit(msg: unknown): void }[];
  createdTabs: string[];
  permissionPrompts: unknown[];
  grantNextPermissionRequest: boolean;
}

export function installChromeMock(): ChromeMock {
  const state: ChromeMock = {
    storageData: {},
    grantedOrigins: new Set(),
    onCommand: () => ({ ok: true, data: null }),
    ports: [],
    createdTabs: [],
    permissionPrompts: [],
    grantNextPermissionRequest: true,
  };
  const storageChanged = event();

  const chromeObj = {
    runtime: {
      id: 'flowpilot-test',
      getURL: (p: string) => `chrome-extension://flowpilot-test/${p}`,
      getManifest: () => ({ version: '0.1.0', name: 'FlowPilot' }),
      sendMessage: vi.fn(async (message: unknown) => state.onCommand(message)),
      onMessage: event(),
      connect: vi.fn(({ name }: { name: string }) => {
        const onMessage = event();
        const onDisconnect = event();
        const port = { name, onMessage, onDisconnect, postMessage: vi.fn(), disconnect: vi.fn(), emit: (m: unknown) => onMessage.emit(m) };
        state.ports.push(port);
        return port;
      }),
      lastError: undefined,
    },
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[] | null) => {
          if (key == null) return { ...state.storageData };
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => k in state.storageData).map((k) => [k, structuredClone(state.storageData[k])]));
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: state.storageData[k], newValue: structuredClone(v) };
            state.storageData[k] = structuredClone(v);
          }
          storageChanged.emit(changes, 'local');
        }),
        remove: vi.fn(async (key: string) => {
          delete state.storageData[key];
        }),
        clear: vi.fn(async () => {
          state.storageData = {};
        }),
      },
      onChanged: storageChanged,
    },
    permissions: {
      contains: vi.fn(async ({ origins = [] }: { origins?: string[] }) =>
        origins.every((o) => state.grantedOrigins.has(o) || state.grantedOrigins.has('<all_urls>')),
      ),
      request: vi.fn(async (req: { origins?: string[] }) => {
        state.permissionPrompts.push(req);
        if (!state.grantNextPermissionRequest) return false;
        for (const o of req.origins ?? []) state.grantedOrigins.add(o);
        return true;
      }),
      remove: vi.fn(async ({ origins = [] }: { origins?: string[] }) => {
        for (const o of origins) state.grantedOrigins.delete(o);
        return true;
      }),
      getAll: vi.fn(async () => ({ permissions: ['storage', 'scripting', 'activeTab'], origins: [...state.grantedOrigins] })),
      onAdded: event(),
      onRemoved: event(),
    },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        state.createdTabs.push(url);
        return { id: 100 + state.createdTabs.length, url };
      }),
      query: vi.fn(async () => [{ id: 5, url: 'https://example.com/', title: 'Example', active: true }]),
      get: vi.fn(async (id: number) => ({ id, status: 'complete' })),
    },
  };

  Object.defineProperty(chromeObj, '__state', { value: state });
  (globalThis as unknown as { chrome: unknown }).chrome = chromeObj;
  return state;
}
