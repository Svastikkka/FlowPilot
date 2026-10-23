import { describe, expect, it } from 'vitest';
import type { Workflow } from '../../src/shared/schema/types';
import { validateWorkflow } from '../../src/shared/schema/validate';
import { templateById } from '../../src/templates';
import { JsdomBrowser } from '../helpers/jsdomBrowser';
import { css, FAST_SETTINGS, step, wf } from '../helpers/fakes';
import { runWorkflow } from '../helpers/run';

// End-to-end workflow scenarios: real engine + real content-script DOM code,
// driven against multi-page sites rendered by jsdom.

/** Use the template's real definition but fast timings. */
const fast = (w: Workflow): Workflow => ({ ...w, settings: { ...w.settings, ...FAST_SETTINGS, defaultTimeoutMs: 500 } });

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

describe('starter templates against realistic pages', () => {
  it('Repetitive form entry: fills every field, asks before submitting, and submits', async () => {
    const browser = new JsdomBrowser({
      'https://httpbin.org/forms/post': page(
        'Order form',
        `<form method="post" action="/post">
           <p><label>Customer name: <input name="custname"></label></p>
           <p><label>Telephone: <input type="tel" name="custtel"></label></p>
           <p><label>E-mail address: <input type="email" name="custemail"></label></p>
           <fieldset><legend>Pizza Size</legend>
             <label><input type="radio" name="size" value="small"> Small</label>
             <label><input type="radio" name="size" value="medium"> Medium</label>
           </fieldset>
           <fieldset><legend>Toppings</legend>
             <label><input type="checkbox" name="topping" value="bacon"> Bacon</label>
             <label><input type="checkbox" name="topping" value="cheese"> Extra Cheese</label>
           </fieldset>
           <p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
           <p><button>Submit order</button></p>
         </form>`,
      ),
      'https://httpbin.org/post': (url) => page('Submitted', `<pre id="echo">${url.search}</pre>`),
    });
    const template = fast(templateById('form-entry')!.build());
    expect(validateWorkflow(template).valid).toBe(true);

    const { result, prompts, tabId } = await runWorkflow(template, browser, {
      inputs: { customerName: 'Grace Hopper', email: 'grace@navy.test' },
    });

    expect(result.status).toBe('succeeded');
    expect(prompts.map((p) => p.kind)).toEqual(['confirmBefore']);
    expect(prompts[0].message).toContain('Submit order');
    const submitted = new URL(browser.currentUrl(tabId)).searchParams;
    expect(browser.currentUrl(tabId)).toContain('https://httpbin.org/post');
    expect(submitted.get('custname')).toBe('Grace Hopper');
    expect(submitted.get('custemail')).toBe('grace@navy.test');
    expect(submitted.get('custtel')).toBe('555-0100');
    expect(submitted.get('size')).toBe('medium');
    expect(submitted.getAll('topping')).toEqual(['cheese']);
    expect(submitted.get('comments')).toMatch(/^Leave at the door \(sent \d{4}-\d{2}-\d{2}\)$/);
    // Step messages describe what was verified but never echo typed text.
    expect(result.steps[2].message).toBe('Entered 12 characters into input[name="custname"] (verified)');
    expect(JSON.stringify(result.steps)).not.toContain('Grace Hopper');
  });

  it('Repetitive form entry: declining the confirmation stops before submitting', async () => {
    const browser = new JsdomBrowser({
      'https://httpbin.org/forms/post': page(
        'Order form',
        `<form action="/post"><input name="custname"><input name="custtel"><input name="custemail">
         <input type="radio" name="size" value="medium"><input type="checkbox" name="topping" value="cheese">
         <textarea name="comments"></textarea><button>Submit order</button></form>`,
      ),
    });
    const { result, tabId } = await runWorkflow(fast(templateById('form-entry')!.build()), browser, {
      answer: () => ({ action: 'stop' }),
    });
    expect(result.status).toBe('stopped');
    expect(browser.currentUrl(tabId)).toBe('https://httpbin.org/forms/post');
    expect(result.steps.at(-1)!.status).toBe('skipped');
  });

  it('Extract page information: collects text, title and URL and offers them for copying', async () => {
    const url = 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html';
    const browser = new JsdomBrowser({
      [url]: page(
        'A Light in the Attic | Books to Scrape - Sandbox',
        `<article class="product_page"><div class="product_main"><h1>A Light in the Attic</h1><p class="price_color">£51.77</p></div>
         <div id="product_description"><h2>Product Description</h2></div><p>It's hard to imagine a world without A Light in the Attic.</p></article>`,
      ),
    });
    const { result, prompts } = await runWorkflow(fast(templateById('extract-info')!.build()), browser, {
      answer: (p) => (p.kind === 'clipboard' ? { action: 'copied' } : { action: 'continue' }),
    });
    expect(result.status).toBe('succeeded');
    expect(result.variables).toMatchObject({ heading: 'A Light in the Attic', pageTitle: 'A Light in the Attic | Books to Scrape - Sandbox', pageUrl: url });
    expect(result.results.map((r) => r.variable)).toEqual(['heading', 'paragraphs', 'pageTitle', 'pageUrl']);
    expect(prompts[0].text).toContain(`A Light in the Attic | Books to Scrape - Sandbox (${url})`);
    expect(prompts[0].text).toContain("It's hard to imagine a world without A Light in the Attic.");
  });

  it('Visit a set of URLs: navigates through pages and history', async () => {
    const browser = new JsdomBrowser({
      'https://quotes.toscrape.com/': page('Quotes to Scrape', '<h1>quotes</h1>'),
      'https://books.toscrape.com/': page('All products | Books to Scrape - Sandbox', '<h1>books</h1>'),
      'https://en.wikipedia.org/wiki/Web_scraping': page('Web scraping - Wikipedia', '<h1>wiki</h1>'),
    });
    const { result, prompts, tabId } = await runWorkflow(fast(templateById('visit-urls')!.build()), browser, {
      answer: () => ({ action: 'copied' }),
    });
    expect(result.status).toBe('succeeded');
    expect(prompts[0].text).toBe('1. Quotes to Scrape\n2. All products | Books to Scrape - Sandbox\n3. Web scraping - Wikipedia');
    expect(browser.currentUrl(tabId)).toBe('https://books.toscrape.com/');
    expect(result.steps[6].message).toBe('Went back — now at https://books.toscrape.com/');
  });

  it('Search and capture: submits with Enter, waits for results, extracts and screenshots', async () => {
    const browser = new JsdomBrowser({
      'https://en.wikipedia.org/wiki/Main_Page': page(
        'Wikipedia',
        '<form action="/w/index.php"><input name="search" placeholder="Search Wikipedia"></form>',
      ),
      'https://en.wikipedia.org/w/index.php': (url) =>
        page(
          url.searchParams.get('search')!,
          `<h1 id="firstHeading">${url.searchParams.get('search')}</h1>
           <div id="mw-content-text"><p class="mw-empty-elt"></p><p>A browser extension is a software module.</p><p>Second.</p></div>`,
        ),
    });
    const { result, persistence } = await runWorkflow(fast(templateById('search-extract')!.build()), browser, {
      inputs: { term: 'Browser extension' },
    });
    expect(result.status).toBe('succeeded');
    expect(result.variables.title).toBe('Browser extension');
    expect(result.variables.summary).toBe('A browser extension is a software module.');
    expect(result.results.at(-1)).toMatchObject({ kind: 'screenshot', variable: 'Browser extension' });
    expect(persistence.artifacts.size).toBe(1);
    expect(browser.screenshots).toBe(1);
  });
});

describe('dynamic pages and waiting', () => {
  it('auto-waits for elements rendered after load and for spinners to disappear', async () => {
    const browser = new JsdomBrowser({
      'https://app.test/': page('App', '<div id="spinner">Loading…</div><div id="root"></div>'),
    });
    browser.onLoad = (_url, window) => {
      window.setTimeout(() => {
        window.document.getElementById('spinner')!.remove();
        window.document.getElementById('root')!.innerHTML = '<button id="start">Start</button><output id="out"></output>';
        window.document.getElementById('start')!.addEventListener('click', () => {
          window.setTimeout(() => (window.document.getElementById('out')!.textContent = 'Started!'), 60);
        });
      }, 80);
    };
    const workflow = wf([
      step('openUrl', { url: 'https://app.test/' }),
      step('wait', { mode: 'elementHidden', locator: css('#spinner') }),
      step('click', { locator: { strategy: 'text', value: 'Start' } }),
      step('wait', { mode: 'textPresent', value: 'Started!' }),
      step('extractText', { locator: css('#out'), variable: 'status' }),
    ]);
    const { result } = await runWorkflow(workflow, browser);
    expect(result.status).toBe('succeeded');
    expect(result.variables.status).toBe('Started!');
  });

  it('follows link navigation, waits for the URL and reads the new page', async () => {
    const browser = new JsdomBrowser({
      'https://docs.test/': page('Docs', '<nav><a href="/guide/install">Install guide</a></nav>'),
      'https://docs.test/guide/install': page('Install', '<h1>Installing</h1><code id="cmd">npm i flowpilot</code>'),
    });
    const workflow = wf([
      step('openUrl', { url: 'https://docs.test/' }),
      step('click', { locator: { strategy: 'text', value: 'Install guide' } }),
      step('wait', { mode: 'urlContains', value: '/guide/' }),
      step('capturePage', { what: 'title', variable: 'title' }),
      step('extractText', { locator: css('#cmd'), variable: 'cmd' }),
      step('navigate', { direction: 'back' }),
      step('navigate', { direction: 'forward' }),
    ]);
    const { result, tabId } = await runWorkflow(workflow, browser);
    expect(result.status).toBe('succeeded');
    expect(result.variables).toMatchObject({ title: 'Install', cmd: 'npm i flowpilot' });
    expect(browser.currentUrl(tabId)).toBe('https://docs.test/guide/install');
  });

  it('runs on an existing tab (popup mode) without opening a URL first', async () => {
    const browser = new JsdomBrowser({ 'https://current.test/': page('Current', '<input id="name"><select id="c"><option>A</option><option>B</option></select>') });
    const tabId = browser.openTab('https://current.test/');
    const workflow = wf([
      step('type', { locator: { strategy: 'css', value: '#name' }, text: 'Ada' }),
      step('select', { locator: css('#c'), by: 'label', value: 'B' }),
    ]);
    const { result } = await runWorkflow(workflow, browser, { target: { kind: 'tab', tabId } });
    expect(result.status).toBe('succeeded');
    expect((browser.document(tabId).getElementById('c') as HTMLSelectElement).value).toBe('B');
  });
});

describe('failure handling end to end', () => {
  const site = { 'https://site.test/': page('Site', '<button id="ok">OK</button>') };

  it('fails with a message that identifies the step and leaves later steps pending', async () => {
    const browser = new JsdomBrowser(site);
    const workflow = wf([
      step('openUrl', { url: 'https://site.test/' }),
      step('click', { locator: css('#missing') }, { name: 'Press the missing button' }),
      step('click', { locator: css('#ok') }),
    ]);
    const { result } = await runWorkflow(workflow, browser);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ stepIndex: 1, code: 'ELEMENT_NOT_FOUND' });
    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'pending']);
    expect(result.summary).toMatch(/No element matches #missing after waiting/);
  });

  it('skips optional steps and still completes', async () => {
    const browser = new JsdomBrowser(site);
    const workflow = wf([
      step('openUrl', { url: 'https://site.test/' }),
      step('click', { locator: css('#cookie-banner') }, { onError: 'skip', timeoutMs: 150 }),
      step('click', { locator: css('#ok') }),
    ]);
    const { result } = await runWorkflow(workflow, browser);
    expect(result.status).toBe('succeeded');
    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'skipped', 'succeeded']);
  });

  it('reports missing site access without retrying', async () => {
    const browser = new JsdomBrowser({ ...site, 'https://bank.test/': page('Bank', '') });
    browser.restricted.add('https://bank.test');
    const workflow = wf([step('openUrl', { url: 'https://bank.test/' }, { retries: 3 })]);
    const { result } = await runWorkflow(workflow, browser);
    expect(result.error).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(result.steps[0].attempts).toBe(1);
  });

  it('reports a closed tab gracefully', async () => {
    const browser = new JsdomBrowser(site);
    const workflow = wf([step('openUrl', { url: 'https://site.test/' }), step('wait', { mode: 'duration', durationMs: 100 }), step('click', { locator: css('#ok') })]);
    const { result } = await runWorkflow(workflow, browser, {
      onStart: (_runner, b) => setTimeout(() => b.closeTab(1), 50),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'TAB_CLOSED', stepIndex: 2 });
  });

  it('explains that the run tab needs a page first', async () => {
    const { result } = await runWorkflow(wf([step('click', { locator: css('#ok') })]), new JsdomBrowser(site));
    expect(result.error?.message).toContain('Start the workflow with an "Open URL" step');
  });

  it('lets the user retry after fixing the page (ask policy)', async () => {
    const browser = new JsdomBrowser({ 'https://site.test/': page('Site', '<div id="slot"></div>') });
    let tabId = 0;
    const { result, prompts } = await runWorkflow(
      wf([step('openUrl', { url: 'https://site.test/' }), step('click', { locator: css('#late') }, { onError: 'ask', timeoutMs: 100 })]),
      browser,
      {
        answer: (p) => {
          if (p.kind === 'error') {
            tabId = [...browser.tabs.keys()][0];
            browser.document(tabId).getElementById('slot')!.innerHTML = '<button id="late">Late</button>';
            return { action: 'retry' };
          }
          return { action: 'continue' };
        },
      },
    );
    expect(prompts.map((p) => p.kind)).toEqual(['error']);
    expect(result.status).toBe('succeeded');
    expect(result.steps[1].attempts).toBe(2);
  });
});
