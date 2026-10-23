// Zips dist/ into release/flowpilot-<version>.zip for Chrome Web Store upload.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
  process.exit(1);
}
for (const required of ['background.js', 'content.js', 'app.html', 'popup.html', 'icons/icon128.png']) {
  if (!existsSync(`dist/${required}`)) {
    console.error(`dist/${required} is missing — run npm run build`);
    process.exit(1);
  }
}
mkdirSync('release', { recursive: true });
const out = resolve(`release/flowpilot-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: 'dist', stdio: 'inherit' });
console.log(`Wrote ${out}`);
