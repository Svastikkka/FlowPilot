# FlowPilot vs Automa: feature gap analysis

Source: Automa's repository (`src/utils/shared.js` block catalogue and
`src/manifest.chrome.json`), its README and its Chrome Web Store listing, as of
October 2026. Automa is dual-licensed under AGPL-3.0 and a commercial licence.
FlowPilot reimplements features from their descriptions only. **No Automa code
may be copied into FlowPilot.** Doing so would put FlowPilot under the AGPL.

## Key differences in approach

| | Automa | FlowPilot |
|---|---|---|
| Editor model | Free-form graph canvas (blocks connected by edges) | Linear step list. Proposed: nested blocks for logic (If / Else, Repeat, Loop) |
| Custom code | JavaScript code block runs arbitrary JS in pages | No arbitrary code, by design |
| Network | HTTP requests, Google Sheets/Drive, marketplace, AI workflows | No external servers |
| Permissions | `tabs`, `proxy`, `debugger`, `webNavigation`, `alarms`, `offscreen`, `<all_urls>` at install; optional `cookies`, `downloads`, `notifications`, `contextMenus`, `clipboardRead` | `storage`, `scripting`, `activeTab`, `unlimitedStorage`; host access requested per site |
| Store privacy disclosure | Declares handling of personally identifiable information and authentication information | Handles data on the device only; transmits nothing |

## Block-by-block mapping

### Already covered by FlowPilot

| Automa block | FlowPilot equivalent |
|---|---|
| New tab / Active tab | Open URL (dashboard runs open a new tab; popup runs use the active tab) |
| Go back, Go forward, Reload tab | Back / Forward (back, forward, reload) |
| Click element, Link | Click |
| Forms (text, select, checkbox, radio) | Enter text, Clear field, Select option, Check / uncheck |
| Get text | Extract text |
| Get tab URL | Capture URL / title |
| Scroll element | Scroll |
| Take screenshot | Screenshot |
| Delay | Wait → Fixed duration |
| Element exists (as a wait) | Wait → Element to appear / disappear |
| Export data (JSON, CSV) | Monitor → Download JSON / CSV |
| Parameter prompt | Variables with "Ask at run start" |
| Note | Step notes |
| Clipboard (write) | Copy to clipboard |

### Gaps compatible with FlowPilot's principles (candidates to add)

| Automa feature | Proposed FlowPilot version | Extra permission | Effort |
|---|---|---|---|
| **Control flow**: Conditions, Element exists (branch), Repeat task, While loop, Loop elements, Loop breakpoint | Nested blocks: **If / Else** (element exists or visible, text present, URL contains, variable equals / contains / matches / greater than), **Repeat N times**, **While** (with an iteration cap), **For each element** (binds `{{item}}` / `{{index}}`), **Break / Continue** | none | L |
| **Loop data** over a table | **Data table** per workflow (import CSV, edit grid) + **For each row**, plus "run once per CSV record" | none | L |
| Insert data, Delete data, Increase variable, Slice variable, RegEx variable, Data mapping, Sort data | **Set variable** step with safe transforms (set, append, increment, slice, regex extract / replace, trim, upper / lower case, split / join), and **Add row to results table** | none | M |
| Attribute value | **Get attribute / property** (href, src, value, data-*) | none | S |
| Hover element | **Hover** (mouseover / mouseenter events) | none | S |
| Press key | **Press key** (synthetic key events for Enter, Tab, Escape, arrows and shortcuts). Without `debugger` these are untrusted events, which is a documented limitation | none | S |
| Trigger event | **Dispatch event** (fixed list: click, dblclick, input, change, focus, blur, mouse events, submit) | none | S |
| Switch frame | **Switch to frame** (same-origin and permitted cross-origin iframes, by selector) | none (per-site access already needed) | M |
| New window, Switch tab, Close tab | **Tab steps**: open in new tab, switch to tab by URL / title match or index (among tabs opened by this run), close tab | none for tabs FlowPilot opens; `tabs` only to match tabs it didn't open | M |
| Upload file | **Upload file**: choose a file stored in the workflow (size-capped) and set it through a DataTransfer | none | M |
| Save assets, Handle download | **Download** a link or image URL from the page | optional `downloads` | M |
| Notification | **Notify** (desktop notification, mainly for scheduled runs) | optional `notifications` | S |
| Execute workflow | **Run another workflow** (sub-workflow with input and output variables, depth-limited) | none | M |
| Blocks group | Collapsible **Group** of steps | none | S–M |
| **Triggers / scheduling**: manual, interval, specific date, days of week + time, visit URL, keyboard shortcut, context menu, on browser start | **Schedules**: interval, date / time, weekly (`alarms`); keyboard shortcut (`commands`); right-click menu (optional `contextMenus`); on browser start. Scheduled runs pause on confirmation steps and send a notification | `alarms`; optional `contextMenus`, `notifications` | M |
| "Visit web" trigger | **Run when I visit a URL** (only on sites already granted) | `webNavigation` or `tabs` | M |
| Element selector / picker | **Pick element** on the page, generating a robust selector (also the basis of the recorder) | none | M |
| Recording | **Recorder** (already planned as M4) | none | L |
| Workflow logs, Get log data | Already in run history; add a per-step **debug log view** | none | S |
| Export as plain text | Add a **plain text** export format | none | S |
| Handle dialog (alert / confirm / prompt) | Defer. Automa uses the `debugger` permission (shows Chrome's "is debugging this browser" banner). Without it this needs main-world script overrides | `debugger` | L, risky |

### Conflicts with FlowPilot's stated principles (recommend **not** adding)

| Automa feature | Why it conflicts |
|---|---|
| JavaScript code | "Never execute arbitrary JavaScript supplied by an imported workflow." It also brings Chrome Web Store remote-code scrutiny, and shared workflows could run anything. |
| HTTP request / webhook | Sends page data to external servers, which breaks local-first and the "no external servers" promise. |
| Google Sheets / Drive | Cloud service with OAuth. Data leaves the device. (Local CSV import / export covers the same need.) |
| Marketplace, cloud sync, AI workflow | Need accounts, servers or external AI APIs. |
| Cookie get / set | Can read session and auth cookies; "do not capture authentication tokens". |
| Proxy | Broad `proxy` permission that changes all browser traffic. Out of scope. |
| Create element | Injects arbitrary HTML into pages (script-injection risk). |
| Chrome Extension Builder | Out of scope. |

## Recommended order

Decisions (23 October 2026): features that conflict with FlowPilot's
principles are excluded, logic uses nested blocks in the step list rather than
a graph canvas, and logic & data is built first.

1. ✅ **Logic & data (Milestone 2 + 3), implemented**: If / Else, Repeat, While, For each element, Break; Set variable with transforms; data tables with CSV import and For each row; plain-text export. *Highest value; already on the roadmap.*
2. **More interactions**: Get attribute, Hover, Press key, Dispatch event, Upload file, Switch frame, multi-tab steps, Run another workflow, Notify.
3. **Triggers**: schedules (`alarms`), keyboard shortcut, context menu, on browser start, visit URL.
4. **Element picker → Recorder (Milestone 4).**
