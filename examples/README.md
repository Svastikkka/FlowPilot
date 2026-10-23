# FlowPilot examples

Ready-made workflows you can import and run. Each `.json` file holds one
workflow.

## How to import

1. Open FlowPilot (toolbar button → **Open dashboard**).
2. Click **Import** and choose a `.json` file from this folder.
3. Press **▶ Run**. FlowPilot asks for access to the sites the workflow opens.
4. When the run finishes, download the **Results table** as CSV or JSON from
   the run monitor.

Everything is editable after import: change URLs, selectors, the CSV on the
**Data** tab, or the values asked at run start.

## Examples

| File | What it does | Asks for | Sites |
|---|---|---|---|
| [youtube-channel-shorts-to-csv.json](youtube-channel-shorts-to-csv.json) | Lists every Short on a YouTube channel (position, title, view count). Read-only: it never likes, comments or subscribes. | Channel handle (default `svastikkka`) | youtube.com |
| [quotes-all-pages-to-csv.json](quotes-all-pages-to-csv.json) | Collects every quote, author and tag, following **Next** until the last page | — | quotes.toscrape.com |
| [book-price-watch.json](book-price-watch.json) | Checks a product's price and stock, and alerts you when the price is below your target | Product URL, target price | books.toscrape.com (or any page you point it at) |
| [wikipedia-table-to-csv.json](wikipedia-table-to-csv.json) | Turns a Wikipedia table into rows (location, population, date) | — | en.wikipedia.org |
| [website-health-check-from-csv.json](website-health-check-from-csv.json) | Opens each URL in the Data tab and checks that the expected text appears; PASS/FAIL table | — (edit the Data tab) | Your list |
| [wikipedia-lookup-from-csv.json](wikipedia-lookup-from-csv.json) | Searches Wikipedia for each term in the Data tab and saves the article title and first paragraph | — (edit the Data tab) | en.wikipedia.org |

The `*.toscrape.com` sites are public sandboxes made for practising web
scraping.

### Notes

- **YouTube** loads Shorts as you scroll. The example scrolls 10 times; raise
  **Times** on the *Scroll to load more Shorts* step for channels with many
  Shorts. If YouTube changes its page markup, update the `Elements` target of
  *For each Short* (currently `ytm-shorts-lockup-view-model`).
- Workflows whose URL comes entirely from a variable (the price watch, the
  health check) need **access to all sites**, because the site is only known
  at run time. FlowPilot explains this when you start the run.
- All six examples were run against the live sites on 23 October 2026. Sites
  change; if a step can't find its element, open the step, use **Test step**,
  and adjust its target.

## What's not included, and why

There is deliberately no example that **likes, subscribes, comments, follows or
votes** automatically. Automating engagement inflates metrics, breaks the terms
of YouTube and most other platforms, and can get accounts restricted.
FlowPilot examples automate *your own* repetitive work: collecting data you can
see, filling in your own forms, and checking your own sites.

## Contributing an example

1. Build the workflow in FlowPilot and test it on the live site.
2. Use **⋯ → Export as JSON** and save it here with a descriptive kebab-case
   name.
3. Run `npm run test:unit`. `tests/unit/examples.test.ts` checks that every
   example imports as a runnable workflow (no draft errors), and that none of
   them click like, subscribe, comment, follow or vote buttons.
4. Add a row to the table above.
