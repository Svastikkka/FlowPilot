import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseImport } from '../../src/shared/schema/importExport';
import { flatten } from '../../src/shared/schema/tree';

// Every file in examples/ must import cleanly: no rejected workflows and no
// validation errors (which would turn them into drafts that can't run).

const dir = join(__dirname, '../../examples');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('examples', () => {
  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s imports as a runnable workflow', (file) => {
    const { imported, rejected } = parseImport(readFileSync(join(dir, file), 'utf8'));
    expect(rejected).toEqual([]);
    expect(imported).toHaveLength(1);
    expect(imported[0].draftReasons).toEqual([]);
    expect(imported[0].workflow.description.length).toBeGreaterThan(20);
  });

  it('never automate engagement actions (likes, subscribes, comments, follows)', () => {
    for (const file of files) {
      const wf = parseImport(readFileSync(join(dir, file), 'utf8')).imported[0].workflow;
      for (const step of flatten(wf.steps)) {
        const target = JSON.stringify(step.params).toLowerCase();
        if (step.type === 'click') expect(target, `${file}: ${step.name}`).not.toMatch(/like|subscribe|comment|follow|upvote/);
      }
    }
  });
});
