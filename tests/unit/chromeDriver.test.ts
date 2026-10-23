import { describe, expect, it } from 'vitest';
import { mapChromeError } from '../../src/background/chromeDriver';

describe('mapChromeError', () => {
  it.each([
    ['No tab with id: 12.', 'TAB_CLOSED', true],
    ['Cannot access contents of url "https://bank.test/". Extension manifest must request permission to access this host.', 'PERMISSION_DENIED', true],
    ['Cannot access a chrome:// URL', 'RESTRICTED_PAGE', true],
    ['The extensions gallery cannot be scripted.', 'RESTRICTED_PAGE', true],
    ['Cannot access contents of url "about:blank".', 'RESTRICTED_PAGE', true],
    ['Could not establish connection. Receiving end does not exist.', 'NAVIGATION_FAILED', false],
    ['The message port closed before a response was received.', 'NAVIGATION_FAILED', false],
    ['Cannot find a next page in history.', 'NAVIGATION_FAILED', true],
    ['Tabs cannot be edited right now (user may be dragging a tab).', 'NAVIGATION_FAILED', false],
    ['Something odd', 'UNKNOWN', false],
  ])('%s → %s', (message, code, fatal) => {
    const e = mapChromeError(new Error(message));
    expect(e.code).toBe(code);
    expect(e.fatal).toBe(fatal);
  });

  it('gives actionable guidance for permission errors', () => {
    expect(mapChromeError(new Error('Missing host permission for the tab')).message).toContain('Grant site access');
  });
});
