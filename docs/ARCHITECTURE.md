# FlowPilot architecture

This document is the design reference for FlowPilot. It covers the runtime
components, the folder layout, the workflow schema, the execution model and the
phased implementation plan.

## 1. Runtime components

```
┌───────────────────────────── Extension origin ─────────────────────────────┐
│                                                                            │
│  app.html (dashboard SPA)        popup.html            background.js (SW)  │
│  ├─ Dashboard / Library          ├─ quick run on       ├─ message router   │
│  ├─ Workflow editor              │  the active tab     ├─ RunManager       │
│  ├─ Execution monitor  ◀──port───┼──────────────────── │  └─ WorkflowRunner│
│  ├─ Templates / History          │                     │     (engine)      │
│  └─ Settings / Privacy           │                     ├─ ChromeDriver     │
│            │                     │                     └─ crash recovery   │
│            └────────── IndexedDB + chrome.storage.local ◀─────┘            │
└────────────────────────────────────────────────────────────────────────────┘
                                                   │ chrome.scripting
                                                   │ chrome.tabs.sendMessage
                                                   ▼
                                    content.js (injected on demand, only into
                                    the run's tab, only with host permission)
                                    └─ locator + DOM action handlers
```

* **Engine (`src/engine`)** is environment-agnostic. It talks to the browser
  through a `BrowserDriver` interface, asks the user questions through a
  `Prompter`, and persists checkpoints through a `RunPersistence`. This is what
  makes it unit-testable with fakes and functionally testable against jsdom.
* **Background service worker (`src/background`)** hosts the engine for real
  runs, implements `BrowserDriver` with `chrome.tabs` / `chrome.scripting`, and
  broadcasts run updates to connected UI pages over a long-lived port.
* **Content script (`src/content`)** is a small, self-contained IIFE that is
  injected only into the tab a run is driving. It resolves locators and
  performs a fixed set of DOM operations. It never evaluates code from a
  workflow.
* **UI (`src/ui`)** is a React SPA (`app.html`) plus a popup. Both read
  persisted data directly from IndexedDB (same extension origin) and send
  commands to the service worker.

### Manifest V3 service worker lifetime

Chrome may terminate the service worker at any time. FlowPilot therefore:

1. Persists the run record (status, current step, per-step results,
   variables, extracted results) to IndexedDB after every state change.
2. Keeps the worker active while a run is in progress (including long waits
   and while waiting for the user) by making a trivial extension API call
   every 20 s; each API call resets Chrome's idle timer.
3. On worker start-up, any run still marked `running`, `paused` or
   `waiting_for_user` is marked `interrupted`. The monitor shows the completed
   steps and offers **Resume from step N**, which restores the saved variables
   and continues in the original tab (or a new tab if it was closed).

FlowPilot does not promise uninterrupted execution if Chrome or the OS
suspends the browser.

## 2. Folder structure

```
FlowPilot/
├─ public/
│  ├─ manifest.json            MV3 manifest (copied verbatim into dist/)
│  └─ icons/                   generated PNG icons
├─ src/
│  ├─ shared/                  code used by every context
│  │  ├─ schema/
│  │  │  ├─ types.ts           Workflow / Step / Run TypeScript types
│  │  │  ├─ actions.ts         action catalogue: labels, form fields, defaults
│  │  │  ├─ zod.ts             runtime schemas (structural validation)
│  │  ├─ factory.ts         new / cloned workflows
│  │  │  ├─ validate.ts        semantic validation (errors + warnings)
│  │  │  └─ importExport.ts    versioned JSON import/export + migrations
│  │  ├─ interpolate.ts        {{variable}} templating
│  │  ├─ safety.ts             sensitive-action detection
│  │  ├─ errors.ts             FlowError + error codes + friendly messages
│  │  ├─ messages.ts           typed extension message protocol
│  │  ├─ features.ts           feature registry (future premium hooks)
│  │  └─ ids.ts
│  ├─ engine/
│  │  ├─ driver.ts             BrowserDriver / Prompter / persistence ports
│  │  ├─ runner.ts             WorkflowRunner: sequencing, retries, policy,
│  │  │                        pause/resume/stop, checkpoints
│  │  └─ handlers.ts           one handler per action type (registry)
│  ├─ content/
│  │  ├─ locator.ts            css / text / label / xpath resolution
│  │  ├─ domActions.ts         DOM operations with verification
│  │  └─ index.ts              message listener (entry)
│  ├─ background/
│  │  ├─ chromeDriver.ts       BrowserDriver over chrome.* APIs
│  │  ├─ runManager.ts         owns active runners, ports, recovery
│  │  └─ index.ts              service worker entry
│  ├─ storage/
│  │  ├─ db.ts                 IndexedDB schema (idb)
│  │  ├─ workflows.ts          workflow repository
│  │  ├─ runs.ts               run history + artifacts repository
│  │  └─ settings.ts           chrome.storage.local settings
│  ├─ templates/index.ts       starter templates
│  └─ ui/                      React app (pages, editor, components), popup
├─ tests/
│  ├─ unit/                    pure modules, engine with fakes, DOM actions
│  ├─ functional/              whole workflows against jsdom pages, UI flows
│  ├─ e2e/                     Playwright: built extension in real Chromium
│  └─ helpers/                 fake driver, chrome mock, jsdom browser
└─ docs/                       architecture, privacy policy, store listing
```

## 3. Workflow schema (v2)

```ts
interface Workflow {
  schemaVersion: 2;
  id: string;
  name: string;
  description: string;
  tags: string[];
  favorite: boolean;
  variables: VariableDef[];       // user-defined, reusable via {{name}}
  settings: {
    defaultTimeoutMs: number;     // per-step timeout
    defaultRetries: number;       // retries before the error policy applies
    defaultOnError: 'stop' | 'skip' | 'ask';
    stepDelayMs: number;          // pause between steps
  };
  steps: Step[];
  data?: { columns: string[]; rows: string[][] };   // input table (CSV)
  createdAt: number;
  updatedAt: number;
  lastRun?: { runId: string; status: RunStatus; finishedAt: number };
}

interface VariableDef {
  name: string;                   // [A-Za-z_][A-Za-z0-9_]*
  defaultValue: string;
  description?: string;
  askAtRunStart?: boolean;        // "text entered by the user"
  secret?: boolean;               // masked in history, never logged
}

interface StepBase {
  id: string;
  type: ActionType;
  name?: string;
  notes?: string;
  disabled?: boolean;
  timeoutMs?: number;             // overrides workflow default
  retries?: number;               // overrides workflow default
  onError?: 'stop' | 'skip' | 'ask';
  confirmBefore?: boolean;        // ask the user before this step runs
  children?: Step[];              // block body (If "then", loop body)
  elseChildren?: Step[];          // If "else"
  params: { ... }                 // action-specific, see actions.ts
}

interface Locator { strategy: 'css' | 'text' | 'label' | 'xpath'; value: string }
```

Action types: `openUrl`, `navigate`, `click`, `type`, `clear`, `select`,
`check`, `wait`, `extractText`, `capturePage`, `scroll`, `screenshot`,
`confirm`, `copyToClipboard`, `stop` (v1), and in v2 the blocks `if`, `repeat`,
`while`, `forEachElement`, `forEachRow`, plus `break`, `continue`,
`setVariable` and `addRow`.

Blocks nest up to 8 levels deep, with at most 500 steps in total. Loops bind
`{{<name>_index}}`. *For each element* also binds `{{<name>}}` (the element's
text) and `{{<name>_selector}}`. *For each data row* binds `{{<name>_<column>}}`.
Validation tracks variable scope through the tree: loop bindings exist only
inside their loop, and values set inside a block stay available after it.

Migration v1 → v2 is a no-op upgrade. Imports of v1 files and stored v1
workflows are upgraded on read.

Built-in dynamic values: `{{date}}`, `{{time}}`, `{{datetime}}`,
`{{timestamp}}`, `{{runId}}`.

Imported files use an envelope:

```json
{ "format": "flowpilot.workflows", "schemaVersion": 2, "exportedAt": "…", "workflows": [ … ] }
```

Every import goes through: size limit → JSON parse → envelope check →
migration (older versions) / rejection (newer versions) → strict structural
validation (unknown keys dropped, string and array length caps) → semantic
validation → fresh IDs. `javascript:` and `data:` URLs are rejected. There is no
action that runs arbitrary JavaScript.

### Adding a new action

1. Add the params type to `types.ts` and its zod schema to `zod.ts`.
2. Add a catalogue entry (label, fields, defaults) to `actions.ts` — the editor
   form is generated from it.
3. Add a handler to `engine/handlers.ts` (and a DOM op in
   `content/domActions.ts` if it touches the page).

## 4. Execution model

* Steps run depth-first in document order. Disabled steps, and everything
  inside a disabled block, are recorded as `skipped`.
* The runner keeps a cursor: one frame per nesting level (`index`, loop
  `iteration`, If `branch`). The cursor is persisted, so an interrupted run
  resumes in the right loop iteration and If branch without re-evaluating the
  condition.
* If conditions and loop iteration checks go through the same attempt
  machinery as other steps, so timeouts, retries and error policies apply to
  them. Break / Next iteration / Stop unwind through nested blocks as signals.
* A run is capped at 50,000 step executions in total, which guards against
  runaway loops.
* Run snapshots (persist + broadcast) are throttled to one per 100 ms, except
  that status changes, prompts and the final state are written immediately.
  This keeps tight loops from flooding IndexedDB and the UI.
* DOM steps auto-wait: the engine polls for the target element (visible and
  enabled where relevant) until the step timeout, re-injecting the content
  script after navigations.
* After steps that can navigate (`openUrl`, `navigate`, `click`), the engine
  waits for the tab to settle (`status === 'complete'`).
* Failure handling: retry up to `retries` times, then apply `onError`:
  `stop` (fail the run), `skip` (record the failure, continue) or `ask`
  (Retry / Skip / Stop prompt in the monitor).
* Verification: a step is reported successful only for what can be checked —
  e.g. typed value equals the requested value, option is selected, checkbox
  state matches. A click is reported as "clicked", never as "submitted".
* Prompts (`confirm`, `copyToClipboard`, `confirmBefore`, `ask`) are persisted
  on the run and answered from the monitor page; if no monitor is open the
  worker opens one.
* Typed values are never written to logs; values of `secret` variables are
  masked in run records; password fields are detected and never echoed.

## 5. Phased plan

| Milestone | Scope | Status |
|---|---|---|
| **M1 — Core** | Schema + validation + import/export, IndexedDB persistence, dashboard, visual editor (drag & drop, duplicate/disable/rename, generated forms, validation feedback), all 15 actions, sequential engine with timeouts/retries/error policies, pause/resume/stop, test single step, variables + built-ins + run-start inputs, execution monitor, history, templates, settings, privacy page, crash recovery, unit + functional tests | **Implemented** |
| M2 — Logic | If / Else, Repeat, While, For each element, Break / Next iteration, Set variable, success / failure conditions via If + Stop | **Implemented** |
| M3 — Data | Data tables with CSV import / grid editing / per-run CSV, For each data row, results table with CSV / JSON export, activity log | **Implemented** |
| M3b — More interactions (from the Automa comparison) | Get attribute, hover, press key, dispatch event, upload file, iframes, multi-tab, run another workflow, notifications | Planned |
| M3c — Triggers (from the Automa comparison) | Schedules (`alarms`), keyboard shortcut, context menu, on browser start, on URL visit | Planned |
| M4 — Recorder | Opt-in recorder for clicks / typing / selects on the selected tab, password and sensitive-field exclusion, review-before-save | **Implemented** — session in `chrome.storage.session`, re-attached after each page load, events folded into steps by `shared/recorder.ts` |
| M5 — Release | Playwright end-to-end tests with the unpacked extension, store assets, packaging | Partially: E2E suite, packaging script and store docs exist; store screenshots/promo images still to be made |

## 6. Future premium capabilities (no cloud required)

`src/shared/features.ts` is the single place where capabilities are declared.
In the MVP every feature is enabled and there are no restrictions. A future
local licence check can be added there without touching the engine or UI
modules.
