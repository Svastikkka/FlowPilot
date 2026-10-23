import { COMMAND_CHANNEL, MONITOR_PORT } from '../shared/messages';
import type { Command, CommandResponse, CommandResultMap, MonitorEvent } from '../shared/messages';
import type { Workflow } from '../shared/schema/types';
import { FlowError } from '../shared/errors';
import { walk } from '../shared/schema/tree';

export async function sendCommand<T extends Command['type']>(command: Extract<Command, { type: T }>): Promise<CommandResultMap[T]> {
  const response = (await chrome.runtime.sendMessage({ channel: COMMAND_CHANNEL, command })) as CommandResponse<T> | undefined;
  if (!response) throw new FlowError('UNKNOWN', 'FlowPilot’s background process did not respond. Try again.');
  if (!response.ok) throw new FlowError(response.error.code, response.error.message, !!response.error.fatal);
  return response.data;
}

export const ALL_SITES = '<all_urls>';

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export interface AccessNeeds {
  /** Origin patterns for static Open URL steps. */
  origins: string[];
  /** Reasons the workflow needs access to all sites (dynamic URLs, screenshots). */
  allSitesReasons: string[];
}

export function accessNeeds(workflow: Pick<Workflow, 'steps'>): AccessNeeds {
  const origins = new Set<string>();
  const reasons = new Set<string>();
  walk(workflow.steps, (s) => {
    if (s.disabled) return false;
    if (s.type === 'openUrl') {
      if (s.params.url.includes('{{')) reasons.add('It opens URLs built from variables, so the sites are only known at run time.');
      else {
        const o = originPattern(s.params.url);
        if (o) origins.add(o);
      }
    }
    if (s.type === 'screenshot') reasons.add('Chrome only allows screenshots with access to all sites (or for runs started from the toolbar popup).');
  });
  return { origins: [...origins], allSitesReasons: [...reasons] };
}

export function hostOf(pattern: string): string {
  return pattern === ALL_SITES ? 'All sites' : pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
}

export async function hasAccess(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  return chrome.permissions.contains({ origins });
}

/**
 * Must be called directly from a user gesture handler (before any other
 * await), otherwise Chrome rejects the request.
 */
export function requestAccess(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(true);
  return chrome.permissions.request({ origins });
}

/** Subscribes to run updates from the service worker; reconnects if the worker restarts. */
export function subscribeToRuns(onEvent: (event: MonitorEvent) => void): () => void {
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (closed) return;
    try {
      port = chrome.runtime.connect({ name: MONITOR_PORT });
    } catch {
      retry = setTimeout(connect, 1_000);
      return;
    }
    port.onMessage.addListener((msg) => onEvent(msg as MonitorEvent));
    port.onDisconnect.addListener(() => {
      port = null;
      if (!closed) retry = setTimeout(connect, 500);
    });
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    port?.disconnect();
  };
}

export function downloadFile(filename: string, content: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workflow';
}
