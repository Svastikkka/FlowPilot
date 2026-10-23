# FlowPilot Privacy Policy

_Last updated: 23 October 2026_

FlowPilot is a browser extension for automating tasks in Google Chrome. This
policy describes what data FlowPilot handles and where that data goes.

## Summary

FlowPilot does not collect, transmit, sell or share any personal data. It has
no servers, accounts, analytics, advertising or remote logging. Everything
FlowPilot stores stays in your Chrome profile on your device.

## Data FlowPilot stores on your device

| Data | Purpose | Location | Retention |
|---|---|---|---|
| Workflow definitions (steps, selectors, variable names and default values, notes, data tables / imported CSV rows) | Run your workflows | IndexedDB in your Chrome profile | Until you delete the workflow or all data |
| Run history (status, timings, step messages, errors) | Show results and errors | IndexedDB | Your most recent runs, 200 by default (configurable) |
| Extracted values, results tables, activity logs and screenshots | Show and export run results | IndexedDB | Deleted with the run they belong to |
| Settings (theme, defaults) | Remember preferences | `chrome.storage.local` | Until you delete all data or uninstall |

This data is **not encrypted** by FlowPilot. Anyone with access to your Chrome
profile on your device could read it.

## Data FlowPilot does not store

- Text that workflows type into web pages is not recorded in run history.
- Values of variables marked *secret* are held in memory only while a run is
  in progress.
- FlowPilot does not read password, one-time-code or payment-card fields.
- FlowPilot does not read your browsing history, cookies or network traffic.

## Data sent to websites

When a workflow types into or submits a form on a website, that website
receives the data, just as it would if you had typed it yourself. How the
website handles it is governed by that website's own privacy policy. FlowPilot
asks for confirmation before steps that look like submissions, purchases or
deletions.

## Permissions

FlowPilot can access only the sites you allow. You grant access per site when
needed, or for the current tab when you start a run from the toolbar button.
You can review and revoke site access in FlowPilot → Settings → Site access, or
in Chrome's extension settings.

## Deleting your data

- FlowPilot → Settings → **Delete run history** removes runs, extracted values
  and screenshots.
- FlowPilot → Settings → **Delete all FlowPilot data** removes everything.
- Uninstalling FlowPilot removes all of its data from Chrome.

## Changes

If this policy changes, the updated version will ship with the extension and
its "Last updated" date will change. FlowPilot will not begin collecting data
without a new version that clearly discloses it.

## Contact

For privacy questions, contact the publisher through the support link on the
Chrome Web Store listing.
