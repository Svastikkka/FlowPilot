// Prints release notes for a version: its CHANGELOG.md section, then the
// commits since the previous release tag.
//
//   node scripts/release-notes.mjs 1.0.0 > notes.md
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n`, 'm');
const match = heading.exec(changelog);
if (!match) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Add one before releasing.`);
  process.exit(1);
}
const rest = changelog.slice(match.index + match[0].length);
const next = rest.search(/^## \[/m);
const section = (next === -1 ? rest : rest.slice(0, next)).replace(/^\[[^\]]+\]: .*$/gm, '').trim();

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
// Before the tag exists (previewing), measure from HEAD instead.
let tagExists = true;
try {
  git('rev-parse', '--verify', `refs/tags/v${version}`);
} catch {
  tagExists = false;
}
const ref = tagExists ? `v${version}` : 'HEAD';
let previous = '';
try {
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', tagExists ? `${ref}^` : ref);
} catch {
  // First release: no earlier tag.
}
if (previous === `v${version}`) previous = '';
const commits = git('log', '--no-merges', '--pretty=format:- %s (%h)', previous ? `${previous}..${ref}` : ref);

console.log(`${section}

## Install

1. Download \`flowpilot-${version}.zip\` below.
2. Unzip it, open \`chrome://extensions\`, turn on **Developer mode**, and choose **Load unpacked** on the unzipped folder.

Check the download with \`SHA256SUMS.txt\` (\`shasum -a 256 -c SHA256SUMS.txt\`).

## Commits${previous ? ` since ${previous}` : ''}

${commits}
`);
