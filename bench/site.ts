import { createServer } from 'node:http';
import type { Server } from 'node:http';

// Local benchmark site. Each page reproduces a pattern that breaks browser
// automation on real websites. Pages are deterministic unless noted.

export interface BenchSite {
  url: string;
  server: Server;
  /** Form submissions received, by path. */
  submissions: { path: string; params: Record<string, string> }[];
  reset(): void;
}

const page = (title: string, body: string, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font:15px system-ui;margin:24px} .item{padding:6px;border-bottom:1px solid #ddd} button{margin:4px}</style></head>
  <body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

/** Random-looking but stable-per-variant tokens, like CSS-in-JS / framework ids. */
const token = (seed: string, n: number) => {
  let h = 2166136261;
  for (const c of `${seed}:${n}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
};

function routes(path: string, q: URLSearchParams): string | null {
  switch (path) {
    case '/delayed':
      return page('Delayed', '<div id="slot"></div><p id="out"></p>', `
        setTimeout(() => {
          const b = document.createElement('button'); b.id = 'go'; b.textContent = 'Continue';
          b.onclick = () => document.getElementById('out').textContent = 'continued';
          document.getElementById('slot').appendChild(b);
        }, 1500);`);

    case '/slow':
      return page('Slow', '<h1 id="title">Loaded slowly</h1>');

    case '/rerender':
      // The first button is thrown away and replaced, like a framework re-render.
      return page('Rerender', '<div id="app"><button class="save">Save</button></div><p id="out"></p>', `
        const render = (label) => {
          document.getElementById('app').innerHTML = '<button class="save">' + label + '</button>';
          document.querySelector('.save').onclick = () => document.getElementById('out').textContent = 'saved';
        };
        setTimeout(() => render('Save'), 300);
        setTimeout(() => render('Save'), 700);`);

    case '/spa':
      return page('SPA home', '<nav><a href="/spa/orders" data-link>Orders</a></nav><main id="view">Home</main>', `
        const views = { '/spa': 'Home', '/spa/orders': '<h2>Orders</h2><span id="count">42</span>' };
        const go = (p) => { history.pushState({}, '', p); setTimeout(() => { document.getElementById('view').innerHTML = views[p]; document.title = 'SPA ' + p; }, 400); };
        document.addEventListener('click', (e) => { const a = e.target.closest('[data-link]'); if (a) { e.preventDefault(); go(a.getAttribute('href')); } });`);

    case '/form':
      return page('Form', `
        <form action="/submitted" method="get" novalidate>
          <label for="name">Full name</label><input id="name" name="name">
          <label for="email">E-mail</label><input id="email" name="email" type="email">
          <label for="plan">Plan</label><select id="plan" name="plan"><option value="">Choose</option><option value="team">Team</option><option value="pro">Pro</option></select>
          <label><input type="checkbox" name="terms" id="terms"> I accept the terms</label>
          <p id="error" role="alert"></p>
          <button type="submit">Create account</button>
        </form>`, `
        document.querySelector('form').addEventListener('submit', (e) => {
          const f = e.target; const err = document.getElementById('error');
          if (!f.name.value || !f.email.value.includes('@') || !f.plan.value || !f.terms.checked) { e.preventDefault(); err.textContent = 'Please complete the form'; }
        });`);

    case '/controlled':
      // Like React: the app keeps its own state from input events; the DOM value alone is not enough.
      return page('Controlled', '<input id="q" placeholder="Search"><button id="save">Save</button><p id="out"></p>', `
        let state = '';
        const q = document.getElementById('q');
        q.addEventListener('input', (e) => { state = e.target.value; });
        document.getElementById('save').onclick = () => { location.href = '/submitted?state=' + encodeURIComponent(state); };`);

    case '/list': {
      const p = Number(q.get('page') ?? 1);
      const items = Array.from({ length: 10 }, (_, i) => `<div class="item"><span class="name">Item ${(p - 1) * 10 + i + 1}</span></div>`).join('');
      return page(`List ${p}`, `<div id="results">${items}</div>${p < 5 ? `<a class="next" href="/list?page=${p + 1}">Next ›</a>` : ''}`);
    }

    case '/infinite':
      return page('Infinite', '<div id="feed"></div><p id="end"></p>', `
        let n = 0;
        const more = () => { for (let i = 0; i < 20 && n < 60; i++) { const d = document.createElement('div'); d.className = 'item'; d.textContent = 'Post ' + (++n); document.getElementById('feed').appendChild(d); } if (n >= 60) document.getElementById('end').textContent = 'No more posts'; };
        more();
        addEventListener('scroll', () => { if (innerHeight + scrollY >= document.body.scrollHeight - 50) setTimeout(more, 200); });
        document.body.style.minHeight = '100vh';
        for (const s of document.querySelectorAll('.item')) s.style.height = '80px';
        new MutationObserver(() => document.querySelectorAll('.item').forEach((s) => (s.style.height = '80px'))).observe(document.getElementById('feed'), { childList: true });`);

    case '/banner': {
      // Shown on roughly half of the loads.
      const show = Math.random() < 0.5;
      return page('Banner', `${show ? '<div id="cookies">We use cookies <button id="accept">Accept</button></div>' : ''}<button id="continue">Continue</button><p id="out"></p>`, `
        const c = document.getElementById('cookies');
        if (c) document.getElementById('accept').onclick = () => c.remove();
        document.getElementById('continue').onclick = () => { if (document.getElementById('cookies')) return; document.getElementById('out').textContent = 'continued'; };`);
    }

    case '/record': {
      // Variant b keeps visible text and labels but changes everything a brittle locator depends on.
      const v = q.get('variant') === 'b' ? 'b' : 'a';
      const t = (n: number) => (v === 'a' ? token('a', n) : token('b', n));
      const buttons = [`<button id="btn-${t(1)}" class="c-${t(2)}">Cancel</button>`, `<button id="btn-${t(3)}" class="c-${t(4)}" type="submit">Place order</button>`];
      if (v === 'b') buttons.reverse();
      const wrap = (html: string) => (v === 'b' ? `<div class="w-${t(9)}"><div>${html}</div></div>` : html);
      return page('Checkout', `
        <form action="/submitted" method="get">
          ${wrap(`<label for="f-${t(5)}">Name on order</label><input id="f-${t(5)}" name="customer">`)}
          ${wrap(`<label for="f-${t(6)}">Quantity</label><select id="f-${t(6)}" name="qty"><option>1</option><option>2</option><option>3</option></select>`)}
          ${wrap(`<label><input type="checkbox" name="gift"> Gift wrap</label>`)}
          ${wrap(buttons.join(''))}
        </form>`);
    }

    case '/shadow':
      return page('Shadow', '<x-widget></x-widget><p id="out"></p>', `
        customElements.define('x-widget', class extends HTMLElement { connectedCallback() {
          const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<button id="inner">Inside shadow</button>';
          r.getElementById('inner').onclick = () => document.getElementById('out').textContent = 'clicked';
        } });`);

    case '/iframe':
      return page('Iframe', `<iframe src="/iframe-inner" style="width:400px;height:120px"></iframe>`);
    case '/iframe-inner':
      return page('Inner', '<form action="/submitted" target="_top"><input name="inner" id="inner"><button>Send</button></form>');

    case '/submitted':
      return page('Submitted', `<h1 id="done">Thanks</h1><pre id="echo">${[...q].map(([k, val]) => `${k}=${val}`).join('\n')}</pre>`);

    default:
      return null;
  }
}

export function startBenchSite(): Promise<BenchSite> {
  const submissions: BenchSite['submissions'] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const html = routes(url.pathname, url.searchParams);
    if (url.pathname === '/submitted') submissions.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    const send = () => {
      res.statusCode = html === null ? 404 : 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html ?? '<h1>Not found</h1>');
    };
    if (url.pathname === '/slow') setTimeout(send, 2000);
    else send();
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ok({ url: `http://127.0.0.1:${port}`, server, submissions, reset: () => void submissions.splice(0) });
    }),
  );
}
