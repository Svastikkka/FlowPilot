# Chrome Web Store listing — FlowPilot

Copy each field below into the matching field in the Chrome Web Store
Developer Dashboard. Regenerate the images with `npm run store:assets` and
the upload zip with `npm run package`.

---

## Store listing tab

### Name (from the manifest, ≤ 75 characters)

```
FlowPilot — Local Browser Automation
```

### Summary (≤ 132 characters; also the manifest "description")

```
Build, save and run browser workflows locally. Visual editor, loops and CSV data. No account, no cloud, no tracking.
```

### Description (plain text; the store does not render Markdown)

```
FlowPilot automates repetitive work in your browser — filling in forms, collecting information from pages, checking sites after a release — without sending your data anywhere. There is no account to create, no server, no analytics and no tracking. Your workflows, run history and results stay on your device.

BUILD WORKFLOWS VISUALLY
• Add steps from a palette and configure them in plain forms: open a page, click, enter text, choose from dropdowns, tick checkboxes, wait for elements or text, read text, capture the URL or title, scroll, take screenshots, ask for confirmation, copy results, or stop the run.
• Point and click to choose the element a step works on: no CSS or XPath needed (they're still there if you want them).
• Drag and drop to reorder, duplicate, disable, rename and add notes to steps.
• Test a single step against the real page while you build.
• Or record it: press Record, use the page as usual, and FlowPilot turns your clicks, typing and choices into editable steps. Passwords and card numbers are never recorded.

LOGIC WITHOUT CODE
• If / Else: act only when an element is visible, the page shows certain text, the URL matches, or a variable has a value.
• Loops: repeat a number of times, repeat while a condition is true, or run once for every matching element on a page.
• Set variable: add numbers, append text, slice, trim, change case, or extract and replace with regular expressions.
• Variables you enter when the run starts, secret values that are never saved, and built-in dates and times.

DATA IN, DATA OUT
• Import a CSV and run the workflow once per row — for example, to enter a list of new customers into a form.
• Choose a different CSV each time you run.
• Collect results into a table and download it as CSV or JSON.

RELIABLE, TRANSPARENT RUNS
• Steps wait for elements to be ready, with timeouts and automatic retries.
• Decide what happens when a step fails: stop, skip, or ask you.
• Pause, resume, stop and re-run. A live monitor shows every step, how many times it ran, and exactly which step failed and why.
• FlowPilot reports only what it can verify — typed values are read back and selections are confirmed.
• If Chrome stops the extension's background process during a long run, you can resume from where it stopped.

YOU STAY IN CONTROL
• FlowPilot only works on sites you allow, and asks for access when a workflow needs a new site. You can revoke access any time.
• Before running steps that look like submitting, buying, deleting or sending, FlowPilot asks you to confirm.
• Typed text is never written to run history, and password and payment fields are never read.
• Workflows are shared as validated JSON files and can only use FlowPilot's built-in actions — they can never run their own scripts.
• FlowPilot never bypasses CAPTCHAs, logins or other access controls.

PRIVACY
Everything FlowPilot stores lives in your browser profile on this device and is not encrypted. FlowPilot itself sends nothing anywhere. Websites you automate receive the information entered into their forms, just as if you had typed it. Delete your run history or all FlowPilot data from Settings at any time.

Includes templates for repetitive form entry, extracting page information, visiting a list of pages, scraping a list into a table, and filling a form for every row of a CSV.
```

### Category

`Developer Tools` (alternative: `Productivity` → `Workflow & Planning`)

### Language

`English`

### Graphic assets

| Dashboard field | File | Size |
|---|---|---|
| Store icon | `store/assets/icon-128.png` | 128×128 PNG (96×96 artwork, 16 px transparent padding) |
| Global screenshots (upload in this order) | `store/assets/screenshots/01-editor.jpg` … `05-data-dark.jpg` | 1280×800 JPEG, no alpha |
| Localized screenshots (English) | Same five files. Only needed if you add other languages; otherwise the global set is shown everywhere. | 1280×800 |
| Small promo tile | `store/assets/promo/small-promo-tile-440x280.jpg` | 440×280 JPEG |
| Marquee promo tile | `store/assets/promo/marquee-promo-tile-1400x560.jpg` | 1400×560 JPEG |

Uncaptioned app screens are in `store/assets/screenshots/raw/` if you prefer
plain screenshots. The demo data shown is fictional (Brightside Supply,
`*.example.com`).

### Additional fields

- **Official URL / Homepage URL:** the project's GitHub repository (optional)
- **Support URL:** the repository's Issues page

---

## Privacy tab

### Single purpose

```
FlowPilot lets users build (or record) and run their own step-by-step browser automation workflows (opening pages, clicking, typing, reading text, waiting for elements) on websites they choose. Everything runs locally on the user's device; no data is sent to any server.
```

### Permission justifications

| Permission | Justification to paste |
|---|---|
| `storage` | Saves the user's preferences (theme, execution defaults) locally in chrome.storage.local. |
| `unlimitedStorage` | Stores the user's workflows, run history, results tables and screenshots locally in IndexedDB; screenshots and large CSV data can exceed the default quota. Nothing is uploaded. |
| `scripting` | Injects the extension's own bundled content script into the single tab a workflow is running in (to perform the user-configured steps: click, type, read text), or into the single tab the user chose to record (to capture their clicks and typing while a visible Recording badge is shown). Only on sites the user has granted. No remote code. |
| `activeTab` | Lets the user run a saved workflow on, or start recording, the page they are currently viewing from the toolbar button, without granting permanent access to that site. |
| Host permission `<all_urls>` (optional) | Optional host permission requested at run time, per site, only for sites the user's workflow opens; the user can choose "all sites" (needed for screenshots and for URLs built from variables) and can revoke access in Settings. |

### Remote code

```
No, I am not using remote code.
```
All JavaScript is bundled in the package. Workflows are data validated against
a fixed schema. There is no eval, no remote scripts and no code execution from
workflows.

### Data usage

The Chrome Web Store requires disclosure even when data is only processed or
stored on the device. Tick these five, matching the privacy policy:

| Category | Tick | Why |
|---|---|---|
| Personally identifiable information | ✅ | Users may put names or e-mails in variables and CSV data |
| Health information | ⬜ | Not handled |
| Financial and payment information | ⬜ | Not handled; payment fields are never read |
| Authentication information | ✅ | Login workflows can use secret variables (memory only, never stored) |
| Personal communications | ⬜ | Not handled |
| Location | ⬜ | Not handled |
| Web history | ✅ | Run history keeps URLs and titles of pages workflows open, with timestamps |
| User activity | ✅ | The opt-in recorder captures clicks, typed text and choices in the recorded tab while recording (never password, one-time-code or payment fields) |
| Website content | ✅ | Extracted text, screenshots and results tables |

Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

Publish `store/flowpilot-privacy-policy.md` as a **public** GitHub Gist with
the file name `flowpilot-privacy-policy.md`, and paste the gist URL
(`https://gist.github.com/<user>/<id>`).

---

## Distribution tab

- **Payments:** Free. The Chrome Web Store no longer supports paid items or
  in-store payments, so a paid listing isn't possible through the store.
- **Visibility:** Public (or Unlisted for a soft launch)
- **Regions:** All regions

---

## Pre-submission checklist

- [ ] `npm test` and `npm run test:e2e` pass
- [ ] Upload `flowpilot-<version>.zip` from the [GitHub release](https://github.com/Svastikkka/FlowPilot/releases) (or `npm run package` → `release/flowpilot-<version>.zip`)
- [ ] `npm run store:assets` → upload the images above
- [ ] Version matches in `public/manifest.json` and `package.json`
- [ ] Privacy policy gist is public and its URL is entered
- [ ] Install the zip unpacked in a fresh Chrome profile and complete one run on a real site
