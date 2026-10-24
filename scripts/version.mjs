// Keeps the version identical in package.json, package-lock.json and the
// extension manifest.
//
// Versions follow Semantic Versioning (MAJOR.MINOR.PATCH).
//
//   node scripts/version.mjs set 1.1.0          update all three files
//   node scripts/version.mjs set major|minor|patch   bump by semver rules
//   node scripts/version.mjs check 1.1.0        fail unless all three equal 1.1.0
//   node scripts/version.mjs check              fail unless all three agree
//   node scripts/version.mjs check-newer 1.1.0  fail unless 1.1.0 is higher than the latest release tag
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILES = ['package.json', 'package-lock.json', 'public/manifest.json'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const parse = (v) => v.split('.').map(Number);
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
function bump(current, part) {
  const [major, minor, patch] = parse(current);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

function versions() {
  const lock = read('package-lock.json');
  return {
    'package.json': read('package.json').version,
    'package-lock.json': lock.version,
    'package-lock.json (root package)': lock.packages?.['']?.version,
    'public/manifest.json': read('public/manifest.json').version,
  };
}

const [command, wanted] = process.argv.slice(2);

if (command === 'set') {
  const current = read('package.json').version;
  const target = ['major', 'minor', 'patch'].includes(wanted) ? bump(current, wanted) : wanted;
  // Plain MAJOR.MINOR.PATCH only: Chrome manifest versions can't carry pre-release suffixes.
  if (!SEMVER.test(target ?? '')) {
    console.error(`Usage: node scripts/version.mjs set <major|minor|patch|x.y.z>  (got "${wanted ?? ''}"; versions must be MAJOR.MINOR.PATCH)`);
    process.exit(1);
  }
  const wantedVersion = target;
  for (const file of FILES) {
    const data = read(file);
    data.version = wantedVersion;
    if (file === 'package-lock.json' && data.packages?.['']) data.packages[''].version = wantedVersion;
    write(file, data);
  }
  console.log(`Version set to ${wantedVersion} (was ${current}) in ${FILES.join(', ')}`);
} else if (command === 'check') {
  const found = versions();
  const expected = wanted ?? found['package.json'];
  const wrong = Object.entries(found).filter(([, v]) => v !== expected);
  if (wrong.length) {
    console.error(`Version mismatch (expected ${expected}):`);
    for (const [file, v] of Object.entries(found)) console.error(`  ${v === expected ? '✓' : '✗'} ${file}: ${v}`);
    process.exit(1);
  }
  console.log(`All versions are ${expected}`);
} else if (command === 'check-newer') {
  if (!SEMVER.test(wanted ?? '')) {
    console.error(`Not a MAJOR.MINOR.PATCH version: "${wanted ?? ''}"`);
    process.exit(1);
  }
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => SEMVER.test(t) && t !== wanted);
  const latest = tags.sort(compare).at(-1);
  if (latest && compare(wanted, latest) <= 0) {
    console.error(`Version ${wanted} is not higher than the latest release ${latest}. Bump with: npm run version:set -- major|minor|patch`);
    process.exit(1);
  }
  console.log(latest ? `${wanted} is higher than the latest release ${latest}` : `${wanted} is the first release`);
} else {
  console.error('Usage: node scripts/version.mjs <set|check|check-newer> [version]');
  process.exit(1);
}
