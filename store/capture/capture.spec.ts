import { test, expect, chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startDemoSite } from './demoSite';

// Generates Chrome Web Store assets from the real, built extension:
//   store/assets/screenshots/raw/*.png  – plain 1280×800 app screens
//   store/assets/screenshots/*.jpg      – captioned 1280×800 store screenshots
//   store/assets/promo/*.jpg            – small (440×280) and marquee (1400×560) tiles
//   store/assets/icon-128.png           – store icon (96×96 artwork, 16 px padding)
// Run with: npm run store:assets

const OUT = resolve('store/assets');
const RAW = join(OUT, 'screenshots/raw');
const HOSTS = ['portal.example.com', 'shop.example.com'];
const VIEWPORT = { width: 1280, height: 800 };

const css = (value: string) => ({ strategy: 'css', value });
let n = 0;
const id = () => `d${++n}`;
const s = (type: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: id(), type, params, ...extra });
const typeStep = (sel: string, text: string, name?: string) => s('type', { locator: css(sel), text, clearFirst: true, pressEnter: false }, name ? { name } : {});

function demoWorkflows() {
  const now = Date.now();
  const base = (name: string, description: string, tags: string[], steps: unknown[], extra: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    id: id(),
    name,
    description,
    tags,
    favorite: false,
    variables: [],
    settings: { defaultTimeoutMs: 8000, defaultRetries: 1, defaultOnError: 'stop', stepDelayMs: 150 },
    createdAt: now,
    updatedAt: now,
    steps,
    ...extra,
  });
  const portal = 'http://portal.example.com';
  const shop = 'http://shop.example.com';
  return [
    base(
      'Add new customers from CSV',
      'Creates a customer record in the admin portal for every row of the imported sign-up sheet.',
      ['onboarding', 'csv'],
      [
        s(
          'forEachRow',
          { loopVariable: 'row', maxRows: 500 },
          {
            name: 'For each new customer',
            children: [
              s('openUrl', { url: `${portal}/customers/new` }, { name: 'Open customer form' }),
              typeStep('#name', '{{row_name}}', 'Full name'),
              typeStep('#email', '{{row_email}}', 'Work e-mail'),
              s('select', { locator: css('#plan'), by: 'value', value: '{{row_plan}}' }, { name: 'Plan' }),
              s(
                'if',
                { condition: 'variable', variable: 'row_plan', operator: 'equals', value: 'enterprise', locator: css(''), },
                { name: 'Enterprise plan?', children: [s('check', { locator: css('#manager'), checked: true }, { name: 'Assign manager' })], elseChildren: [] },
              ),
              s('click', { locator: css('button[type="submit"]') }, { name: 'Create customer' }),
              s('wait', { mode: 'textPresent', value: 'Customer created' }),
              s('extractText', { locator: css('#customer-id'), variable: 'customerId', all: false }, { name: 'Read customer ID' }),
              s('addRow', { columns: [{ name: 'customer', value: '{{row_name}}' }, { name: 'plan', value: '{{row_plan}}' }, { name: 'customer_id', value: '{{customerId}}' }] }),
            ],
          },
        ),
      ],
      {
        favorite: true,
        data: {
          columns: ['name', 'email', 'plan'],
          rows: [
            ['Priya Raman', 'priya@northwind.example', 'enterprise'],
            ['Daniel Okafor', 'daniel@lumen.example', 'team'],
            ['Sofia Marquez', 'sofia@harbor.example', 'starter'],
            ['Kenji Watanabe', 'kenji@atlas.example', 'enterprise'],
          ],
        },
      },
    ),
    base('Weekly price check', 'Collects every product name and price from the catalogue into a table.', ['research'], [
      s('openUrl', { url: `${shop}/products` }),
      s(
        'forEachElement',
        { locator: css('.product'), loopVariable: 'item', maxItems: 100 },
        {
          name: 'For each product',
          children: [
            s('extractText', { locator: css('{{item_selector}} .name'), variable: 'product', all: false }),
            s('extractText', { locator: css('{{item_selector}} .price'), variable: 'price', all: false }),
            s('setVariable', { variable: 'price', operation: 'regexReplace', value: '', pattern: '[$,]', replacement: '' }, { name: 'Keep the number only' }),
            s('addRow', { columns: [{ name: 'product', value: '{{product}}' }, { name: 'price', value: '{{price}}' }] }),
          ],
        },
      ),
    ]),
    base('Release smoke test', 'Checks the status page after a deployment and fails if the version is wrong.', ['qa'], [
      s('openUrl', { url: `${portal}/status` }),
      s('wait', { mode: 'textPresent', value: 'operational' }),
      s('extractText', { locator: css('#version'), variable: 'version', all: false }),
      s(
        'if',
        { condition: 'variable', variable: 'version', operator: 'notContains', value: '4.12', locator: css('') },
        { name: 'Unexpected version?', children: [s('stop', { outcome: 'failed', message: 'Expected 4.12, found {{version}}' })], elseChildren: [] },
      ),
      s('capturePage', { what: 'title', variable: 'title' }),
    ]),
    base('Competitor pricing snapshot', 'Captures a screenshot of each competitor pricing page for the weekly review.', ['research'], [
      s('openUrl', { url: `${shop}/products` }),
      s('wait', { mode: 'element', locator: css('.product'), durationMs: 0, value: '' }),
      s('screenshot', { label: 'pricing-{{date}}' }),
    ]),
    base('Expense report submission', 'Fills the monthly expense form from values entered at run start.', ['finance'], [
      s('openUrl', { url: `${portal}/expenses/new` }),
      typeStep('#amount', '{{amount}}', 'Amount'),
      typeStep('#purpose', '{{purpose}}', 'Purpose'),
      s('click', { locator: { strategy: 'text', value: 'Submit for approval' } }, { confirmBefore: true }),
    ], {
      variables: [
        { name: 'amount', defaultValue: '', description: 'Amount', askAtRunStart: true },
        { name: 'purpose', defaultValue: '', description: 'Purpose', askAtRunStart: true },
      ],
    }),
    base('Monthly invoice export', 'Downloads last month’s invoices from the billing portal.', ['finance'], [
      s('openUrl', { url: `${portal}/billing` }),
      s('click', { locator: { strategy: 'text', value: 'Invoices' } }),
      s('select', { locator: css('#period'), by: 'label', value: 'Last month' }),
      s('click', { locator: { strategy: 'text', value: 'Export CSV' } }, { confirmBefore: true }),
    ]),
  ];
}

async function launch(port: number): Promise<{ context: BrowserContext; extensionId: string; cleanup: () => void }> {
  const extDir = mkdtempSync(join(tmpdir(), 'flowpilot-store-'));
  cpSync(resolve('dist'), extDir, { recursive: true });
  const manifestPath = join(extDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Store screenshots can't click Chrome's permission prompt, so pre-grant the demo hosts.
  manifest.host_permissions = HOSTS.map((h) => `http://${h}/*`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const profile = mkdtempSync(join(tmpdir(), 'flowpilot-store-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h}:80 127.0.0.1:${port}`).join(',')}`],
  });
  context.setDefaultTimeout(20_000);
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  return {
    context,
    extensionId: new URL(worker.url()).host,
    cleanup: () => {
      rmSync(extDir, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function runFromDashboard(app: Page, base: string, name: string, beforeStart?: () => Promise<void>) {
  await app.goto(`${base}#/`);
  await app.getByRole('article').filter({ hasText: name }).getByRole('button', { name: '▶ Run' }).click();
  const dialog = app.getByRole('dialog', { name: new RegExp(`Run “${name}”`) });
  const ack = dialog.getByLabel('I understand and want to run it');
  if (await ack.count()) await ack.check();
  await expect(dialog.getByRole('button', { name: /Start run/ })).toBeEnabled();
  await beforeStart?.();
  await dialog.getByRole('button', { name: /Start run/ }).click();
  await expect(app.locator('.page-header .badge').first()).toHaveText('Succeeded', { timeout: 60_000 });
  // The run opens its own tab; return focus to the app page.
  await app.bringToFront();
}

/** Renders HTML at an exact size and saves it. */
async function render(canvas: { renderer: Browser }, html: string, size: { width: number; height: number }, path: string, type: 'jpeg' | 'png' = 'jpeg') {
  const page = await canvas.renderer.newPage({ viewport: size, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path, type, ...(type === 'jpeg' ? { quality: 92 } : { omitBackground: true }) });
  await page.close();
}

const dataUrl = (path: string, mime = 'image/png') => `data:${mime};base64,${readFileSync(path).toString('base64')}`;

const FONT = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;`;
const GRADIENT = 'linear-gradient(135deg, #4338ca 0%, #6d28d9 55%, #7c3aed 100%)';

function framed(shot: string, caption: string) {
  return `<!doctype html><html><body style="margin:0;width:1280px;height:800px;overflow:hidden;background:${GRADIENT};${FONT}">
  <div style="height:86px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:31px;font-weight:700;letter-spacing:-.3px">${caption}</div>
  <img src="${dataUrl(shot)}" style="position:absolute;left:80px;top:90px;width:1120px;height:700px;border-radius:12px 12px 0 0;box-shadow:0 18px 50px rgba(15,10,60,.45)">
  </body></html>`;
}

function smallTile(icon: string) {
  return `<!doctype html><html><body style="margin:0;width:440px;height:280px;overflow:hidden;background:${GRADIENT};${FONT};color:#fff;position:relative">
  <div style="position:absolute;right:-60px;top:-60px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,.08)"></div>
  <div style="position:absolute;left:-40px;bottom:-90px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.06)"></div>
  <div style="position:absolute;left:36px;top:52px;display:flex;align-items:center;gap:16px">
    <div style="width:76px;height:76px;border-radius:18px;background:#fff;display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,0,0,.25)"><img src="${icon}" style="width:60px;height:60px"></div>
    <div style="font-size:44px;font-weight:800;letter-spacing:-1px">FlowPilot</div>
  </div>
  <div style="position:absolute;left:36px;top:156px;right:30px;font-size:22px;font-weight:600;line-height:1.3">Browser automation that<br>stays on your device</div>
  <div style="position:absolute;left:36px;bottom:26px;font-size:14px;opacity:.85;letter-spacing:.3px">No account · No cloud · No tracking</div>
  </body></html>`;
}

function marquee(icon: string, shot: string) {
  const chip = (t: string) =>
    `<span style="display:inline-block;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.25);font-size:17px;font-weight:600;margin:0 8px 10px 0">${t}</span>`;
  return `<!doctype html><html><body style="margin:0;width:1400px;height:560px;overflow:hidden;background:${GRADIENT};${FONT};color:#fff;position:relative">
  <div style="position:absolute;left:-120px;bottom:-180px;width:420px;height:420px;border-radius:50%;background:rgba(255,255,255,.06)"></div>
  <div style="position:absolute;left:72px;top:84px;width:560px">
    <div style="display:flex;align-items:center;gap:18px">
      <div style="width:72px;height:72px;border-radius:18px;background:#fff;display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,0,0,.25)"><img src="${icon}" style="width:56px;height:56px"></div>
      <div style="font-size:50px;font-weight:800;letter-spacing:-1.2px">FlowPilot</div>
    </div>
    <div style="font-size:38px;font-weight:750;line-height:1.18;margin-top:30px;letter-spacing:-.6px">Automate repetitive browser work — privately.</div>
    <div style="font-size:19px;opacity:.9;margin-top:16px;line-height:1.45">Build workflows visually, loop over CSV data and page elements, and keep everything on your device.</div>
    <div style="margin-top:26px">${['Visual editor', 'Loops &amp; conditions', 'CSV in, CSV out', 'No account · No cloud'].map(chip).join('')}</div>
  </div>
  <div style="position:absolute;left:690px;top:64px;width:900px;height:562px;border-radius:14px;overflow:hidden;box-shadow:0 30px 70px rgba(10,5,50,.5);background:#fff">
    <div style="height:30px;background:#e9ebf2;display:flex;align-items:center;gap:7px;padding-left:14px">
      <span style="width:11px;height:11px;border-radius:50%;background:#f87171"></span><span style="width:11px;height:11px;border-radius:50%;background:#fbbf24"></span><span style="width:11px;height:11px;border-radius:50%;background:#34d399"></span>
    </div>
    <img src="${dataUrl(shot)}" style="width:900px;display:block">
  </div>
  </body></html>`;
}

function storeIcon(icon: string) {
  return `<!doctype html><html><body style="margin:0;width:128px;height:128px;background:transparent;display:grid;place-items:center">
  <img src="${icon}" style="width:96px;height:96px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))">
  </body></html>`;
}

test('generate Chrome Web Store assets', async () => {
  test.setTimeout(240_000);
  mkdirSync(RAW, { recursive: true });
  mkdirSync(join(OUT, 'promo'), { recursive: true });

  const site = await startDemoSite();
  const { context, extensionId, cleanup } = await launch(site.port);
  const base = `chrome-extension://${extensionId}/app.html`;
  try {
    const app = await context.newPage();
    await app.goto(`${base}#/`);

    // Import the demo workflows through the real import flow.
    const importFile = join(mkdtempSync(join(tmpdir(), 'fp-demo-')), 'demo.json');
    writeFileSync(importFile, JSON.stringify({ format: 'flowpilot.workflows', schemaVersion: 2, workflows: demoWorkflows() }));
    await app.locator('input[type=file]').first().setInputFiles(importFile);
    await app.getByRole('dialog', { name: 'Import complete' }).getByRole('button', { name: 'Done' }).click();

    await runFromDashboard(app, base, 'Release smoke test');
    await runFromDashboard(app, base, 'Weekly price check');
    await runFromDashboard(app, base, 'Add new customers from CSV', async () => {
      await app.screenshot({ path: join(RAW, '04-run-dialog.png') });
    });
    expect(site.submissions).toHaveLength(4);

    // Monitor of the CSV run, scrolled to the step tree.
    await app.getByRole('region', { name: 'Steps' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await app.evaluate(() => window.scrollBy(0, -12));
    await app.screenshot({ path: join(RAW, '02-monitor.png') });
    await app.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await app.screenshot({ path: join(RAW, '02b-results.png') });

    // Dashboard (star the CSV workflow the way a user would; imports never carry favorites).
    await app.goto(`${base}#/`);
    await app.getByRole('button', { name: 'Favorite Add new customers from CSV' }).click();
    await expect(app.getByRole('button', { name: 'Unfavorite Add new customers from CSV' })).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Recently run' })).toBeVisible();
    await app.mouse.move(0, 0);
    await app.screenshot({ path: join(RAW, '03-dashboard.png') });

    // Editor with a nested step selected.
    await app.getByRole('link', { name: 'Add new customers from CSV', exact: true }).click();
    await app.getByRole('treeitem', { name: /Step 1\.2: Full name/ }).click();
    await app.mouse.move(0, 0);
    await app.screenshot({ path: join(RAW, '01-editor.png') });

    // Dark mode: the Data tab.
    await app.emulateMedia({ colorScheme: 'dark' });
    await app.getByRole('tab', { name: /Data/ }).click();
    await app.mouse.move(0, 0);
    await app.screenshot({ path: join(RAW, '05-data-dark.png') });
    await app.emulateMedia({ colorScheme: 'light' });

    // Compose the store images in a plain browser (exact viewport per asset).
    const renderer = await chromium.launch({ channel: 'chromium', headless: true });
    const canvas = { renderer };
    const captions: [string, string][] = [
      ['01-editor', 'Build workflows visually — with loops, conditions and data'],
      ['02-monitor', 'Watch every step run, with verified results'],
      ['03-dashboard', 'All your workflows in one place. No account, no cloud.'],
      ['04-run-dialog', 'Stay in control: site access and checks before risky steps'],
      ['05-data-dark', 'Import a CSV and run once per row — in light or dark mode'],
    ];
    for (const [name, caption] of captions) {
      await render(canvas, framed(join(RAW, `${name}.png`), caption), VIEWPORT, join(OUT, 'screenshots', `${name}.jpg`));
    }
    const icon = dataUrl(resolve('public/icons/icon128.png'));
    await render(canvas, smallTile(icon), { width: 440, height: 280 }, join(OUT, 'promo', 'small-promo-tile-440x280.jpg'));
    await render(canvas, marquee(icon, join(RAW, '01-editor.png')), { width: 1400, height: 560 }, join(OUT, 'promo', 'marquee-promo-tile-1400x560.jpg'));
    await render(canvas, storeIcon(icon), { width: 128, height: 128 }, join(OUT, 'icon-128.png'), 'png');
    await renderer.close();
  } finally {
    await context.close();
    site.server.close();
    cleanup();
  }
});
