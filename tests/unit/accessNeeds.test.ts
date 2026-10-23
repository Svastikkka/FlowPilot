import { describe, expect, it } from 'vitest';
import { accessNeeds } from '../../src/ui/api';
import type { Step } from '../../src/shared/schema/types';
import { step } from '../helpers/fakes';

describe('accessNeeds', () => {
  const needs = (...urls: string[]) => accessNeeds({ steps: urls.map((url) => step('openUrl', { url })) });

  it('requests only the fixed sites a workflow opens', () => {
    expect(needs('https://a.com/x', 'https://a.com/y', 'http://b.org')).toEqual({ origins: ['https://a.com/*', 'http://b.org/*'], allSitesReasons: [] });
  });

  it('keeps per-site access when only the path or query uses variables', () => {
    expect(needs('https://www.youtube.com/@{{channel}}/shorts', 'https://en.wikipedia.org/wiki/Special:Search?search={{term}}')).toEqual({
      origins: ['https://www.youtube.com/*', 'https://en.wikipedia.org/*'],
      allSitesReasons: [],
    });
  });

  it('needs all sites when the host itself comes from a variable', () => {
    expect(needs('{{url}}').allSitesReasons).toHaveLength(1);
    expect(needs('https://{{host}}/path').allSitesReasons).toHaveLength(1);
  });

  it('looks inside blocks and ignores disabled steps', () => {
    const loop = { ...step('repeat'), children: [step('openUrl', { url: 'https://inner.test/' }), step('openUrl', { url: 'https://off.test/' }, { disabled: true })] } as Step;
    expect(accessNeeds({ steps: [loop] }).origins).toEqual(['https://inner.test/*']);
  });
});
