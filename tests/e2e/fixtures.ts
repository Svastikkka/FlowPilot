import { test as base, chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Fixture site + extension loader for end-to-end tests.
//
// Chrome's site-access prompt cannot be clicked by automation, so the test
// copy of the extension declares host access to the local fixture server up
// front. Everything else (service worker, messaging, content-script injection,
// IndexedDB, UI) is exercised exactly as shipped.

export interface Site {
  url: string;
  submissions: URLSearchParams[];
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function startSite(): Promise<{ server: Server; site: Site }> {
  const submissions: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/form') {
      res.end(
        page(
          'Signup',
          `<h1>Sign up</h1>
           <form action="/thanks" method="get">
             <label for="name">Name</label><input id="name" name="name">
             <label for="country">Country</label>
             <select id="country" name="country"><option value="">Choose</option><option value="nl">Netherlands</option><option value="in">India</option></select>
             <label><input type="checkbox" id="terms" name="terms"> I agree</label>
             <div id="late"></div>
             <button type="submit">Send</button>
           </form>
           <script>setTimeout(() => { document.getElementById('late').innerHTML = '<span id="ready">Ready</span>'; }, 400);</script>`,
        ),
      );
    } else if (url.pathname === '/thanks') {
      submissions.push(url.searchParams);
      res.end(page('Thanks', `<h1>Thanks, ${url.searchParams.get('name') ?? 'stranger'}</h1><ul><li>One</li><li>Two</li></ul>`));
    } else {
      res.statusCode = 404;
      res.end(page('Not found', '<h1>Not found</h1>'));
    }
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ok({ server, site: { url: `http://127.0.0.1:${port}`, submissions } });
    }),
  );
}

function prepareExtension(): string {
  const dist = resolve('dist');
  const dir = mkdtempSync(join(tmpdir(), 'flowpilot-e2e-'));
  cpSync(dist, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

export const test = base.extend<{ site: Site; context: BrowserContext; extensionId: string; app: Page }>({
  // eslint-disable-next-line no-empty-pattern
  site: async ({}, use) => {
    const { server, site } = await startSite();
    await use(site);
    server.close();
  },
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const extDir = prepareExtension();
    const userDataDir = mkdtempSync(join(tmpdir(), 'flowpilot-profile-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });
    await use(context);
    await context.close();
    rmSync(extDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
  app: async ({ context, extensionId }, use) => {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extensionId}/app.html#/`);
    await use(p);
  },
});

export { expect } from '@playwright/test';
