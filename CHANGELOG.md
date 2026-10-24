# Changelog

All notable changes to FlowPilot are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/):

- **MAJOR** (2.0.0): changes that break existing workflows or exported files,
  e.g. a workflow schema change that older versions can't import, or a
  removed action.
- **MINOR** (1.1.0): new features that keep existing workflows working.
- **PATCH** (1.0.1): bug fixes only.

## [Unreleased]

## [1.0.0] - 2026-10-24

First public release. FlowPilot builds, records and runs browser workflows
entirely on your device: no account, no cloud, no tracking.

### Build workflows

- Visual editor: add, reorder (drag and drop or keyboard), duplicate, disable
  and rename steps, with notes and inline validation.
- **Pick on page**: choose the element a step works on by clicking it. No CSS
  or XPath needed. For loops, one click selects all similar items.
- **Recorder**: record clicks, typing and choices on a page and turn them into
  editable steps. Password, one-time-code and card fields are never recorded.
- 24 actions: open pages, back/forward, click, type, clear, select, check,
  wait, extract text, capture URL or title, scroll, screenshot, ask to
  continue, copy to clipboard, stop, plus logic and data blocks.
- Logic without code: If / Else, Repeat, While, For each element, For each
  data row, Break, Next iteration, and Set variable (numbers, text, regex).
- Variables: your own, asked at run start, secret (never saved), and built-in
  dates and times.
- Data: import a CSV and run once per row, or pick a different CSV for each
  run. Collect results into a table and download it as CSV or JSON.
- Templates, plus importable examples (YouTube Shorts export, paginated
  scraping, price watch, Wikipedia tables, website health check).

### Run workflows

- Steps wait for elements automatically, with timeouts, retries and a choice
  of stop, skip or ask when a step fails.
- Pause, resume, stop, re-run, or test a single step while building.
- Live monitor with per-step results, run counts in loops, an activity log
  and clear error messages. FlowPilot only reports what it can verify.
- Runs interrupted by Chrome stopping the background worker can resume from
  where they stopped, including inside loops.

### Privacy and safety

- Everything stays in your browser profile. FlowPilot sends nothing anywhere.
- Site access is requested per site and can be revoked in Settings.
- Confirmation before steps that look like submitting, buying or deleting.
- Imported workflows are validated and can never run their own code.

[Unreleased]: https://github.com/Svastikkka/FlowPilot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Svastikkka/FlowPilot/releases/tag/v1.0.0
