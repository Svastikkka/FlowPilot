# Releasing a new version

This guide walks through publishing a new FlowPilot version: from choosing the
version number to the update going live on the Chrome Web Store.

Pushing a version tag starts the automated part, which is
[`.github/workflows/release.yml`](../.github/workflows/release.yml). It runs all
the tests, builds the extension zip and publishes a GitHub Release. Uploading
that zip to the Chrome Web Store is still a manual step.

---

## Before you start

- You can push to `main` and push tags to
  `https://github.com/Svastikkka/FlowPilot`.
- Your local `main` is up to date: `git checkout main && git pull`.
- CI is green on `main`. Check the
  [Actions tab](https://github.com/Svastikkka/FlowPilot/actions).
- For the store upload: access to the
  [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 1. Choose the version number

FlowPilot follows [Semantic Versioning](https://semver.org/):
`MAJOR.MINOR.PATCH`. Look at what changed since the last release (listed under
`## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md), or run
`git log --oneline $(git describe --tags --abbrev=0)..HEAD`) and pick the bump:

| Bump | When | Example (from 1.0.0) |
|---|---|---|
| **major** | Something that worked before stops working: a workflow schema change older versions can't import, a removed or renamed action, behaviour users rely on changes | 2.0.0 |
| **minor** | New features, and existing workflows keep working | 1.1.0 |
| **patch** | Bug fixes only | 1.0.1 |

Versions must be plain `MAJOR.MINOR.PATCH`. Suffixes such as `-beta` or `-rc1`
aren't allowed, because Chrome extension versions can only contain numbers.

## 2. Bump the version

```bash
npm run version:set -- minor        # or: major | patch | an exact version like 1.4.0
```

This updates `package.json`, `package-lock.json` and `public/manifest.json`
together, and prints the old and new version. Never edit one of these files on
its own: the release fails if they disagree.

## 3. Update the changelog

In [CHANGELOG.md](../CHANGELOG.md), turn the `## [Unreleased]` notes into a
section for the new version, and leave an empty `## [Unreleased]` above it:

```markdown
## [Unreleased]

## [1.1.0] - 2026-11-15

### Added
- …

### Fixed
- …
```

Then update the comparison links at the bottom of the file:

```markdown
[Unreleased]: https://github.com/Svastikkka/FlowPilot/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Svastikkka/FlowPilot/compare/v1.0.0...v1.1.0
```

The heading must be exactly `## [x.y.z]`. The release notes are taken from this
section, and **the release fails if it's missing**. Write it for users: what
they can now do, what was fixed. The release notes add the list of commits
automatically.

## 4. Check everything locally

```bash
npm run version:check     # all three files agree
npm test                  # unit + functional tests
npm run test:e2e          # end-to-end tests in Chromium
npm run package           # builds release/flowpilot-x.y.z.zip
node scripts/release-notes.mjs 1.1.0   # preview the release notes
```

Load `dist/` in Chrome (`chrome://extensions` → **Load unpacked**, or **↻ reload**
if it's already loaded) and try the main flows once. Settings → About should
show the new version.

If anything in the store listing changed (new permissions, new data the
extension handles, new features worth describing), update
[store/LISTING.md](../store/LISTING.md) and, if needed, the privacy policy
([PRIVACY.md](../PRIVACY.md) and
[store/flowpilot-privacy-policy.md](../store/flowpilot-privacy-policy.md)). If
the UI changed noticeably, regenerate the screenshots with
`npm run store:assets`.

## 5. Commit, tag and push

```bash
git add -A
git commit -m "Release 1.1.0"
git tag -a v1.1.0 -m "FlowPilot 1.1.0"
git push origin main v1.1.0
```

The tag must be `v` + the version (`v1.1.0`), and it must point at the commit
that contains the bumped version.

## 6. Watch the release pipeline

Open the [Actions tab](https://github.com/Svastikkka/FlowPilot/actions) and
follow the **Release** run for your tag (usually 3–5 minutes). It:

1. runs the full CI suite (typecheck, unit/functional tests on Node 20 and 22,
   build, end-to-end tests),
2. checks that the tag matches the version in all three files,
3. checks that the version is higher than the previous release tag,
4. builds `flowpilot-x.y.z.zip` and `SHA256SUMS.txt`,
5. publishes the GitHub Release with notes from the changelog, install steps
   and the commits since the previous tag.

When it's green, open
[Releases](https://github.com/Svastikkka/FlowPilot/releases) and check that the
release has both files attached and that the notes read well. You can edit the
notes on GitHub if needed.

## 7. Publish on the Chrome Web Store

1. Download `flowpilot-x.y.z.zip` from the GitHub Release. Upload this file,
   not a local build, so the store gets exactly what was tested.
2. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open FlowPilot → **Package** → **Upload new package**, and choose the zip.
   The store rejects a version that isn't higher than the one already published.
3. If you changed the listing in step 4, update the **Store listing** and
   **Privacy** tabs to match [store/LISTING.md](../store/LISTING.md). If the
   privacy policy changed, update the gist too: its content must match what you
   declare on the Privacy tab.
4. Click **Submit for review**. Review usually takes from a few hours to a few
   days, and takes longer when permissions change. You get an e-mail when it's
   published.

## 8. After the release

- Users get the update automatically once the store publishes it.
- Start collecting the next changes under `## [Unreleased]` in the changelog.

---

## When something goes wrong

| Problem | What to do |
|---|---|
| **"Version mismatch"** in the release run | The tag doesn't match the files, or the files disagree. Fix with `npm run version:set -- x.y.z`, then re-tag (below). |
| **"… is not higher than the latest release …"** | You reused or lowered a version. Pick a higher one with `npm run version:set -- patch` (or minor/major), update the changelog, re-tag. |
| **"CHANGELOG.md has no "## [x.y.z]" section"** | Add the section (step 3), commit, re-tag. |
| **Tests fail in the release run** | Nothing was published. Fix the problem on `main`, then re-tag. |
| **A runner hiccup (network, timeout)** | Re-run the failed jobs from the run's page on GitHub (**Re-run failed jobs**). The tag doesn't change. |
| **Chrome Web Store rejects the upload as an older version** | A higher version is already published. Release a new patch version. |

**Re-tagging** (only if the GitHub Release was **not** created):

```bash
git tag -d v1.1.0                      # delete the local tag
git push origin :refs/tags/v1.1.0      # delete the remote tag
# fix, commit and push main, then:
git tag -a v1.1.0 -m "FlowPilot 1.1.0"
git push origin v1.1.0
```

**If a broken version was already published**, don't reuse its number. Fix the
problem and release a new patch version (e.g. 1.1.1). Versions on the Chrome
Web Store and on GitHub should never be overwritten.

---

## Quick reference

```bash
git checkout main && git pull
npm run version:set -- patch            # major | minor | patch | x.y.z
# edit CHANGELOG.md: add "## [x.y.z] - YYYY-MM-DD" and update the links
npm run version:check && npm test && npm run test:e2e
git add -A && git commit -m "Release x.y.z"
git tag -a vx.y.z -m "FlowPilot x.y.z" && git push origin main vx.y.z
# wait for the Release run → download the zip from the GitHub Release
# → Chrome Web Store dashboard → Upload new package → Submit for review
```
