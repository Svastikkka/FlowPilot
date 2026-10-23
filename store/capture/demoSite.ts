import { createServer } from 'node:http';
import type { Server } from 'node:http';

// Fictional demo site used only to produce store screenshots. Served on
// localhost; Chromium maps portal.example.com / shop.example.com to it.

const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f4f6fa; color: #1c2230; }
  header { background: #0f766e; color: #fff; padding: 14px 28px; font-weight: 650; letter-spacing: .2px; }
  main { max-width: 760px; margin: 28px auto; background: #fff; border-radius: 10px; padding: 24px 28px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  label { display: block; margin: 12px 0 4px; font-weight: 550; }
  input, select { width: 100%; padding: 8px 10px; border: 1px solid #c8cfdb; border-radius: 6px; font: inherit; box-sizing: border-box; }
  .check { display: flex; gap: 8px; align-items: center; font-weight: 400; } .check input { width: auto; }
  button { margin-top: 18px; background: #0f766e; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; font: inherit; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .product { border: 1px solid #e3e7ef; border-radius: 8px; padding: 14px; } .price { color: #0f766e; font-weight: 700; }
</style></head><body><header>Brightside Supply · ${title}</header><main>${body}</main></body></html>`;

export const PRODUCTS = [
  ['Ergonomic Office Chair', '189.00'],
  ['Standing Desk Frame', '329.00'],
  ['Monitor Arm (Dual)', '74.50'],
  ['Wireless Keyboard', '49.99'],
  ['Noise-Cancelling Headset', '119.00'],
  ['USB-C Docking Station', '139.00'],
];

export function startDemoSite(): Promise<{ server: Server; port: number; submissions: URLSearchParams[] }> {
  const submissions: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/customers/new') {
      res.end(
        shell(
          'New customer',
          `<h2>Add a customer</h2>
           <form action="/customers/created" method="get">
             <label for="name">Full name</label><input id="name" name="name">
             <label for="email">Work e-mail</label><input id="email" name="email" type="email">
             <label for="plan">Plan</label>
             <select id="plan" name="plan"><option value="starter">Starter</option><option value="team">Team</option><option value="enterprise">Enterprise</option></select>
             <label class="check"><input type="checkbox" id="manager" name="manager"> Assign an account manager</label>
             <button type="submit">Create customer</button>
           </form>`,
        ),
      );
    } else if (url.pathname === '/customers/created') {
      submissions.push(url.searchParams);
      res.end(shell('Customer created', `<h2>Customer created</h2><p id="customer-id">CUS-${1040 + submissions.length}</p><p>${url.searchParams.get('name')} was added.</p>`));
    } else if (url.pathname === '/products') {
      res.end(
        shell(
          'Products',
          `<h2>Office essentials</h2><div class="grid">${PRODUCTS.map(
            ([name, price]) => `<div class="product"><div class="name">${name}</div><div class="price">$${price}</div></div>`,
          ).join('')}</div>`,
        ),
      );
    } else if (url.pathname === '/status') {
      res.end(shell('Status', `<h2>All systems operational</h2><p id="version">Release 4.12.0</p>`));
    } else {
      res.statusCode = 404;
      res.end(shell('Not found', '<h2>Not found</h2>'));
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: (server.address() as { port: number }).port, submissions })));
}
