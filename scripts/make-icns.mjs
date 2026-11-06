// Builds build/icon.icns (macOS app icon) from docs/media/logo.svg.
// The round logo is rendered at ~82% of the 1024px canvas (macOS icon grid margin),
// then downscaled with `sips` into an .iconset and packed with `iconutil`.
// Usage: node scripts/make-icns.mjs   (macOS only; needs Playwright's Chromium)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const svg = readFileSync(join(root, 'docs/media/logo.svg'), 'utf8');
const work = join(tmpdir(), 'darkroom-icon-' + process.pid);
const set = join(work, 'icon.iconset');
mkdirSync(set, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
const body = svg.replace(/width="\d+" height="\d+"/, 'width="840" height="840"');
await page.setContent(
  `<html><body style="margin:0;background:transparent;width:1024px;height:1024px;display:grid;place-items:center">${body}</body></html>`,
);
const master = join(work, 'icon_1024.png');
await page.screenshot({ path: master, omitBackground: true });
await browser.close();

for (const s of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(s), String(s), master, '--out', join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(s * 2), String(s * 2), master, '--out', join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
}
mkdirSync(join(root, 'build'), { recursive: true });
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build/icon.icns')]);
execFileSync('cp', [master, join(root, 'build/icon.png')]);
rmSync(work, { recursive: true, force: true });
console.log('wrote build/icon.icns and build/icon.png');
