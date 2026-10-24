# FlowPilot

[![CI](https://github.com/Svastikkka/FlowPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Svastikkka/FlowPilot/actions/workflows/ci.yml)

**Your browser. Your workflow. Your rules.**

FlowPilot is a local-first Chrome extension (Manifest V3) for building, saving
and running browser automation workflows. There are no accounts, no servers, no
AI APIs and no telemetry. Workflows, run history and settings stay in your
browser profile.

It's for developers, QA engineers, operations teams and power users who repeat
the same browser tasks.

---

## Status: Milestones 1–3 (core, logic, data)

| Area | State |
|---|---|
| Visual workflow editor (add / remove / edit / duplicate / disable / rename / drag-and-drop reorder, notes, generated config forms, inline validation) | ✅ Implemented |
| All 15 actions: open URL, back/forward/reload, click, enter text, clear, select, check/uncheck, wait (element / hidden / text / URL / page load / duration), extract text, capture URL/title, scroll, screenshot, ask to continue, copy to clipboard, stop | ✅ Implemented |
| Variables: user-defined, asked at run start, secret, built-ins (`{{date}}`, `{{time}}`, `{{datetime}}`, `{{timestamp}}`, `{{runId}}`), values extracted by earlier steps | ✅ Implemented |
| Execution: auto-waiting, per-step timeouts and retries, error policy (stop / skip / ask), "ask before this step", pause / resume / stop, rerun, test a single step | ✅ Implemented |
| Execution monitor, run history, results export (JSON/CSV), screenshots | ✅ Implemented |
| Crash recovery after MV3 service-worker termination (resume from the interrupted step) | ✅ Implemented |
| Dashboard: search, sort, tags, favorites, recently run, duplicate / rename / export / delete, JSON import with validation | ✅ Implemented |
| Templates (form entry, page extraction, visiting URLs, search & capture, scrape a list into a table, fill a form for each CSV row) | ✅ Implemented |
| Settings, site-access management, privacy page, delete history / all data | ✅ Implemented |
| Logic blocks: **If / Else** (element exists / visible / absent, page text, URL, variable comparisons incl. regex and numbers), **Repeat**, **While** (with an iteration cap), **For each element**, **For each data row**, **Break**, **Next iteration**, nested up to 8 levels | ✅ Implemented |
| User-defined success / failure conditions (If + Stop with an outcome) | ✅ Implemented |
| **Set variable** (set, append, add a number, slice, regex extract / replace, trim, case, length) | ✅ Implemented |
| **Data tables**: import a CSV on the Data tab, edit it in a grid, or choose a different CSV for each run | ✅ Implemented |
| **Results table**: *Add row to results* steps build a table that downloads as CSV or JSON | ✅ Implemented |
| Activity log of every step execution (with loop position) | ✅ Implemented |
| **Recorder**: record clicks, typing, dropdown and checkbox choices into editable steps; stable locators; sensitive fields become secret variables; review before saving | ✅ Implemented |
| **Element picker** (🎯 Pick on page): choose targets by clicking, no selectors needed; picks all similar items for loops | ✅ Implemented |

The design, schema and the plan for later milestones are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). A feature-by-feature comparison
with Automa, including which of its features FlowPilot deliberately leaves out,
is in [docs/AUTOMA_COMPARISON.md](docs/AUTOMA_COMPARISON.md).

---

## Install (from source)

Requirements: Node 20.11+ and Chrome 116+.

```bash
npm install
npm run build          # type-check, then build into dist/
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.

The dashboard opens on first install. You can open it again from the toolbar
button → **Open dashboard**, or from the extension's **Options**.

`npm run dev` rebuilds the pages and service worker on change. The content
script is built by the second step of `npm run build`, so run the full build
after changing `src/content/`. Reload the extension in `chrome://extensions`
after each rebuild.

### Package for the Chrome Web Store

```bash
npm run package        # builds and writes release/flowpilot-<version>.zip
npm run store:assets   # regenerates screenshots, promo tiles and the store icon
```

Every listing field, permission justification and asset is listed in
[store/LISTING.md](store/LISTING.md).

---

## Using FlowPilot

1. **Create a workflow**: click **Create workflow** or pick a template.
2. **Add steps**: start with **Open URL**, then add interactions. To choose
   the element a step works on, press **🎯 Pick on page** and click it. FlowPilot
   opens the page, outlines elements as you move the mouse (*Button "Save"*,
   *Field "Email"*), and fills in a stable target. Clicks in pick mode never
   reach the page. For **For each element** loops, click one item and FlowPilot
   selects all the similar ones. You can also type a target yourself:
   - **CSS**: `#email`, `button.primary` (in DevTools, right-click the element → Copy → Copy selector)
   - **Text**: the element's visible text, e.g. `Sign in`
   - **Label**: the field's label, aria-label or placeholder
   - **XPath**: `//table//tr[2]/td[1]`
3. **Use variables**: type `{{name}}` in any text field, or click a variable
   chip. Define variables on the **Variables** tab. Turn on *Ask at run start*
   for values you enter on each run, and *Secret* for values that must never be
   stored in history.
4. **Test a step**: **Test step** runs only the selected step, in a test tab
   kept for that workflow. Test **Open URL** first, then the steps after it.
5. **Run**: FlowPilot asks for access to the sites the workflow opens, asks you
   to acknowledge steps that look like submissions, purchases or deletions, then
   opens the run in a new tab. The monitor shows each step as it runs.
6. **Run on the current page**: click the toolbar button and choose **Run here**.
   This uses Chrome's `activeTab` grant for that page, so no permanent site
   access is needed.

### Examples

Importable example workflows are in [examples/](examples/). They export a
YouTube channel's Shorts to CSV, scrape every page of a paginated site, watch
a price, turn a Wikipedia table into CSV, health-check a list of URLs, and look
up a list of topics. Use **Import** on the dashboard and pick a file.

### Recording

Open **Recorder**, enter the page to start on, and press **Start recording**
(or use **Record this tab** in the toolbar popup). FlowPilot opens the page with
a red **Recording** badge. Use the site as usual, then press **Stop** on the
badge, in the popup or on the Recorder page.

- Recorded: clicks, text typed into fields (stored once the field loses focus
  or you press Enter), dropdown choices, checkboxes and radio buttons, and
  addresses you type into the address bar.
- Each element gets the most stable locator FlowPilot can find (test id, id,
  field name, label or text, then a short CSS path), checked to match exactly
  one element.
- Password, one-time-code and card fields are never recorded. Their step uses
  a secret variable that asks for the value when you run the workflow.
- Only the recorded tab is watched, only until you stop or close it. If you
  navigate to a site FlowPilot can't access yet, the Recorder page offers to
  allow it.
- Review the steps (remove, reorder, edit targets and text), then **Save as
  workflow** and refine it in the editor.

### Logic and data

- **Blocks hold steps.** If / Else and the loops appear in the step list with
  their steps indented underneath. Use **＋ Add step to Then / inside**, drag
  steps in and out, or press **Alt+→** to move a step into the block above and
  **Alt+←** to move it out.
- **Loop variables.** Every loop has a name (e.g. `row`), and
  `{{row_index}}` is the iteration number:
  - *For each element* sets `{{item}}` to the element's text, and
    `{{item_selector}}` to a CSS target for that element. Use the selector in
    later steps, e.g. click `{{item_selector}} a`.
  - *For each data row* sets one variable per column, e.g. `{{row_email}}`.
- **Data.** On the **Data** tab, import a CSV (the first row holds the column
  names) or type rows in. When you start a run, you can pick a different CSV for
  that run only. It must contain the columns the workflow uses.
- **Results.** *Add row to results* appends a row (columns can use variables).
  The monitor shows the table and downloads it as CSV or JSON. CSV exports
  neutralise spreadsheet formulas.
- **Success / failure conditions.** Put a **Stop run** step inside an If (for
  example "if the page shows *Error* → stop as failed").
- **Safety limits.** While loops require a maximum iteration count, and loops
  over elements or rows have item caps. A run stops after 50,000 step
  executions in total, so an endless loop can't run forever.

### Error handling

Each step first waits up to its timeout for its element to be present, visible
and enabled. If the step still fails, it is retried up to its retry count. After
that, its failure rule applies: **Stop the run**, **Skip and continue**, or
**Ask me** (Retry / Skip / Stop from the monitor). You can set defaults per
workflow under *Settings* and override them per step.

### What "succeeded" means

FlowPilot only reports what it can check: typed values are read back, selected
options and checkbox states are confirmed, and page loads are observed. A click
is reported as "clicked", never as "submitted". The website's response is up to
the website.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save settings in this browser. |
| `unlimitedStorage` | Keep workflows, history and screenshots locally without the default quota. |
| `scripting` | Inject FlowPilot's page helper into the tab a run controls, only on sites you have allowed. |
| `activeTab` | Run on the page you are viewing when you start from the toolbar button. |
| Optional host access (`<all_urls>`, requested per site) | Requested when a workflow opens a site. "All sites" is requested only if you choose it, which is needed for screenshots and for URLs built from variables. Revoke it under Settings → Site access. |

FlowPilot does not request `tabs`, `history`, `cookies`, `webRequest` or any
network permission.

---

## Privacy and security

- No network requests are made by FlowPilot itself. There is no analytics, ads
  or remote logging.
- Data is stored **unencrypted** in IndexedDB and `chrome.storage.local`. See
  [PRIVACY.md](PRIVACY.md).
- Typed text is never written to run history. Secret variables are kept in
  memory only. Password and payment fields are never read.
- Imported workflows are validated against a strict, versioned schema. Unknown
  actions, `javascript:`/`data:` URLs, oversized files and extra fields are
  rejected or stripped. **There is no action that runs arbitrary JavaScript.**
- UI commands are accepted only from FlowPilot's own extension pages. Web pages
  and content scripts cannot start runs.
- FlowPilot never bypasses CAPTCHAs, logins or other access controls.

---

## Testing

```bash
npm test                 # unit + functional (Vitest, jsdom): 250 tests
npm run test:unit        # schema, validation, tree, CSV, interpolation, data ops, safety, engine (incl. logic blocks), DOM actions, storage, run manager, editor state
npm run test:functional  # full workflows (incl. every template, loops, CSV runs) against multi-page jsdom sites + React UI flows
npm run test:e2e         # builds, then drives the real extension in Chromium with Playwright (4 tests)
```

- **Unit tests** cover each module in isolation. The engine is tested with a
  scripted driver: sequencing, retries, every error policy, timeouts,
  pause/resume/stop, prompts, variables and secret masking. For logic blocks
  they cover every loop type, Break / Next iteration, nested blocks, Stop inside
  loops, the runaway-loop guard, and resuming in the middle of a loop iteration
  or an If branch.
- **Functional tests** run the real engine and the real content-script DOM code
  against multi-page sites rendered by jsdom. This covers link navigation, form
  submission, history and delayed elements. React Testing Library tests cover
  the dashboard, editor, run dialog, monitor and settings flows.
- **End-to-end tests** (`tests/e2e`) load `dist/` into Playwright's Chromium,
  serve a local fixture site, build a workflow through the editor UI, run it and
  check what the server actually received. They also cover import, prompts,
  failure reporting and single-step tests. Chrome's site-access prompt can't be
  automated, so the E2E copy of the extension declares access to the fixture
  server in its manifest. Install the browser once with
  `npx playwright install chromium`.

### Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push to
`main`, on pull requests, and on demand. It has three jobs:

| Job | What it does |
|---|---|
| Typecheck & tests | `npm ci`, typecheck, unit tests, functional tests, on Node 20 and 22 |
| Build extension | Builds and packages the store zip, checks that the manifest and `package.json` versions match, and uploads the zip as the `flowpilot-extension` artifact |
| End-to-end | Installs Playwright's Chromium, builds, and runs the E2E suite against the real extension. On failure it uploads the HTML report and traces as `playwright-report` |

On CI, Playwright retries a failed E2E test once and reports it as flaky
rather than passing it silently.

---

## Known limitations

- Chrome may stop the service worker, or the OS may suspend the browser, during
  long runs. FlowPilot saves progress after every step and offers **Resume from
  step N**, but it cannot promise uninterrupted execution.
- Only the top-level frame is automated. Elements inside iframes and closed
  shadow roots can't be targeted, and CSS selectors don't reach into shadow DOM.
- File-upload inputs and drag-and-drop gestures are not supported, and the
  recorder doesn't capture hovering, scrolling, or actions inside iframes. Add
  those steps in the editor.
- Typing sets the field value and dispatches input/change events. It does not
  simulate individual key presses, so pages that listen only for key events may
  not react.
- Browser pages (`chrome://`), the Chrome Web Store and other extensions' pages
  can't be automated (Chrome's own rule).
- *For each element* tags the current element with a `data-flowpilot-item`
  attribute so later steps can target it. Pages that react to attribute changes
  may notice it.
- Run progress is saved at most every 100 ms (status changes and prompts are
  saved immediately). After an interruption, resuming may repeat the step that
  was in progress.
- Regular expressions in *Set variable* and conditions run in the extension's
  service worker. Input is capped at 100,000 characters, but a pathological
  pattern can still make a run slow.

---

## Project layout

```
src/shared     schema, validation, import/export, interpolation, safety, messages
src/engine     environment-agnostic workflow runner + action handlers
src/content    content script: locators and verified DOM operations
src/background service worker: chrome driver, run manager, recovery
src/storage    IndexedDB repositories + chrome.storage settings
src/ui         React dashboard, editor, monitor, popup
src/templates  starter templates
tests          unit / functional / e2e
examples       importable example workflows
docs           architecture, Automa comparison
store          Chrome Web Store listing, privacy policy for the gist, asset generator
```

The `src/shared/features.ts` registry is where future premium capabilities would
be gated by a local licence check. In this version every feature is enabled.
There are no payments, accounts or artificial limits.
