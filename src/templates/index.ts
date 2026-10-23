import type { Step, Workflow } from '../shared/schema/types';
import { createStep } from '../shared/schema/actions';
import { newWorkflow } from '../shared/schema/factory';

// Starter templates. Each call returns a fresh, fully editable workflow.

export interface Template {
  id: string;
  name: string;
  description: string;
  category: 'Data entry' | 'Extraction' | 'Navigation';
  build(): Workflow;
}

const css = (value: string) => ({ strategy: 'css' as const, value });

const CORE_TEMPLATES: Template[] = [
  {
    id: 'form-entry',
    name: 'Repetitive form entry',
    description: 'Fill a form from variables, confirm, then submit. Points at a public test form you can replace with your own.',
    category: 'Data entry',
    build: () =>
      newWorkflow({
        name: 'Repetitive form entry',
        description: 'Fills the httpbin.org demo order form. Change the URL and selectors for your own form.',
        tags: ['data entry', 'template'],
        variables: [
          { name: 'customerName', defaultValue: 'Ada Lovelace', description: 'Customer name', askAtRunStart: true },
          { name: 'phone', defaultValue: '555-0100', description: 'Telephone' },
          { name: 'email', defaultValue: 'ada@example.com', description: 'E-mail', askAtRunStart: true },
          { name: 'comments', defaultValue: 'Leave at the door', description: 'Delivery instructions' },
        ],
        steps: [
          createStep('openUrl', { name: 'Open the form', params: { url: 'https://httpbin.org/forms/post' } }),
          createStep('wait', { params: { mode: 'element', locator: css('form'), durationMs: 0, value: '' } }),
          createStep('type', { name: 'Customer name', params: { locator: css('input[name="custname"]'), text: '{{customerName}}', clearFirst: true, pressEnter: false } }),
          createStep('type', { name: 'Telephone', params: { locator: css('input[name="custtel"]'), text: '{{phone}}', clearFirst: true, pressEnter: false } }),
          createStep('type', { name: 'E-mail', params: { locator: css('input[name="custemail"]'), text: '{{email}}', clearFirst: true, pressEnter: false } }),
          createStep('check', { name: 'Pizza size: medium', params: { locator: css('input[name="size"][value="medium"]'), checked: true } }),
          createStep('check', { name: 'Topping: cheese', params: { locator: css('input[name="topping"][value="cheese"]'), checked: true } }),
          createStep('type', { name: 'Comments', params: { locator: css('textarea[name="comments"]'), text: '{{comments}} (sent {{date}})', clearFirst: true, pressEnter: false } }),
          createStep('click', {
            name: 'Submit order',
            notes: 'Submits the form. FlowPilot asks before running this step.',
            confirmBefore: true,
            params: { locator: { strategy: 'text', value: 'Submit order' } },
          }),
        ] as Step[],
      }),
  },
  {
    id: 'extract-info',
    name: 'Extract page information',
    description: 'Collect a heading, the page title and URL, then offer them for copying.',
    category: 'Extraction',
    build: () =>
      newWorkflow({
        name: 'Extract page information',
        description: 'Reads visible information from a page and prepares a summary to copy.',
        tags: ['extraction', 'template'],
        steps: [
          createStep('openUrl', { params: { url: 'https://example.com' } }),
          createStep('extractText', { name: 'Main heading', params: { locator: css('h1'), variable: 'heading', all: false } }),
          createStep('extractText', { name: 'Body text', params: { locator: css('p'), variable: 'paragraphs', all: true } }),
          createStep('capturePage', { params: { what: 'title', variable: 'pageTitle' } }),
          createStep('capturePage', { params: { what: 'url', variable: 'pageUrl' } }),
          createStep('copyToClipboard', {
            params: { template: '{{pageTitle}} ({{pageUrl}})\n{{heading}}\n\n{{paragraphs}}\n\nCaptured {{datetime}}' },
          }),
        ] as Step[],
      }),
  },
  {
    id: 'visit-urls',
    name: 'Visit a set of URLs',
    description: 'Open several pages in turn and record each page title.',
    category: 'Navigation',
    build: () =>
      newWorkflow({
        name: 'Visit a set of URLs',
        description: 'Opens each URL, waits for it to load and records its title. Duplicate the steps to add more pages.',
        tags: ['navigation', 'template'],
        settings: { defaultTimeoutMs: 15_000, defaultRetries: 1, defaultOnError: 'skip', stepDelayMs: 500 },
        steps: [
          createStep('openUrl', { name: 'Page 1', params: { url: 'https://example.com' } }),
          createStep('capturePage', { params: { what: 'title', variable: 'title1' } }),
          createStep('openUrl', { name: 'Page 2', params: { url: 'https://example.org' } }),
          createStep('capturePage', { params: { what: 'title', variable: 'title2' } }),
          createStep('openUrl', { name: 'Page 3', params: { url: 'https://www.iana.org/help/example-domains' } }),
          createStep('capturePage', { params: { what: 'title', variable: 'title3' } }),
          createStep('navigate', { name: 'Back to page 2', params: { direction: 'back' } }),
          createStep('copyToClipboard', { params: { template: '1. {{title1}}\n2. {{title2}}\n3. {{title3}}' } }),
        ] as Step[],
      }),
  },
  {
    id: 'search-extract',
    name: 'Search and capture',
    description: 'Search a site, wait for results, extract the first paragraph and take a screenshot.',
    category: 'Extraction',
    build: () =>
      newWorkflow({
        name: 'Search and capture',
        description: 'Searches Wikipedia for a term entered at run start.',
        tags: ['extraction', 'template'],
        variables: [{ name: 'term', defaultValue: 'Browser extension', description: 'Search term', askAtRunStart: true }],
        steps: [
          createStep('openUrl', { params: { url: 'https://en.wikipedia.org/wiki/Main_Page' } }),
          createStep('type', { name: 'Search', params: { locator: css('input[name="search"]'), text: '{{term}}', clearFirst: true, pressEnter: true } }),
          createStep('wait', { params: { mode: 'element', locator: css('#firstHeading'), durationMs: 0, value: '' } }),
          createStep('extractText', { name: 'Article title', params: { locator: css('#firstHeading'), variable: 'title', all: false } }),
          createStep('extractText', {
            name: 'First paragraph',
            params: { locator: css('#mw-content-text p:not(.mw-empty-elt)'), variable: 'summary', all: false },
          }),
          createStep('screenshot', { params: { label: '{{title}}' } }),
        ] as Step[],
      }),
  },
];

const LOGIC_TEMPLATES: Template[] = [
  {
    id: 'scrape-list',
    name: 'Scrape a list into a table',
    description: 'Loop over every item in a list, collect its text and link position into a results table, then download it as CSV.',
    category: 'Extraction',
    build: () =>
      newWorkflow({
        name: 'Scrape a list into a table',
        description: 'Collects Hacker News front-page titles. Change the URL and the "Elements" target for your own list or table rows.',
        tags: ['extraction', 'loop', 'template'],
        steps: [
          createStep('openUrl', { params: { url: 'https://news.ycombinator.com/' } }),
          createStep('forEachElement', {
            name: 'For each story',
            params: { locator: css('.titleline > a'), loopVariable: 'story', maxItems: 30 },
            children: [
              createStep('setVariable', { name: 'Clean up title', params: { variable: 'title', operation: 'set', value: '{{story}}', pattern: '', replacement: '' } }),
              createStep('setVariable', { params: { variable: 'title', operation: 'trim', value: '', pattern: '', replacement: '' } }),
              createStep('addRow', {
                params: {
                  columns: [
                    { name: 'rank', value: '{{story_index}}' },
                    { name: 'title', value: '{{title}}' },
                  ],
                },
              }),
            ],
          }),
        ] as Step[],
      }),
  },
  {
    id: 'csv-form-fill',
    name: 'Fill a form for each CSV row',
    description: 'Submit the same form once per row of your data (import a CSV on the Data tab), checking for an error after each submission.',
    category: 'Data entry',
    build: () =>
      newWorkflow({
        name: 'Fill a form for each CSV row',
        description: 'Uses the httpbin.org demo form. Replace the URL, selectors and data with your own.',
        tags: ['data entry', 'csv', 'loop', 'template'],
        data: {
          columns: ['name', 'email', 'comments'],
          rows: [
            ['Ada Lovelace', 'ada@example.com', 'First row'],
            ['Grace Hopper', 'grace@example.com', 'Second row'],
          ],
        },
        steps: [
          createStep('forEachRow', {
            name: 'For each person',
            params: { loopVariable: 'row', maxRows: 1000 },
            children: [
              createStep('openUrl', { params: { url: 'https://httpbin.org/forms/post' } }),
              createStep('type', { name: 'Name', params: { locator: css('input[name="custname"]'), text: '{{row_name}}', clearFirst: true, pressEnter: false } }),
              createStep('type', { name: 'E-mail', params: { locator: css('input[name="custemail"]'), text: '{{row_email}}', clearFirst: true, pressEnter: false } }),
              createStep('type', { name: 'Comments', params: { locator: css('textarea[name="comments"]'), text: '{{row_comments}}', clearFirst: true, pressEnter: false } }),
              createStep('click', { name: 'Submit', params: { locator: { strategy: 'text', value: 'Submit order' } } }),
              createStep('if', {
                name: 'Did the site report an error?',
                params: { condition: 'textPresent', value: 'error', locator: css(''), variable: '', operator: 'equals' },
                children: [createStep('stop', { params: { outcome: 'failed', message: 'The site reported an error for row {{row_index}}' } })],
                elseChildren: [createStep('addRow', { params: { columns: [{ name: 'row', value: '{{row_index}}' }, { name: 'email', value: '{{row_email}}' }, { name: 'status', value: 'submitted' }] } })],
              }),
            ],
          }),
        ] as Step[],
      }),
  },
];

export const TEMPLATES: Template[] = [...CORE_TEMPLATES, ...LOGIC_TEMPLATES];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
