#!/usr/bin/env node
/**
 * Open the Darkroom editor headlessly, optionally run scripted interactions,
 * and save a screenshot.
 *
 *   node scripts/app-snap.mjs out.png                     # initial load (fresh storage)
 *   node scripts/app-snap.mjs out.png --script steps.mjs  # steps.mjs: export default async ({ page, dr }) => {...}
 *   node scripts/app-snap.mjs out.png --eval "dr.actions.selectAll()"
 *   options: --size 1440x900  --keep (keep IndexedDB autosave between runs is the default for a single run;
 *            each run uses a fresh browser profile, so storage always starts empty)
 *
 * Uses SNAP_URL (e.g. http://localhost:5199) if set, else starts Vite itself.
 * Prints console errors/warnings and exits 1 if any page errors occurred.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const out = args[0];
if (!out) {
  console.error('usage: app-snap.mjs <out.png> [--script file.mjs] [--eval "js"] [--size WxH]');
  process.exit(1);
}
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const [vw, vh] = (opt('--size') ?? '1440x900').split('x').map(Number);

let base = process.env.SNAP_URL;
let server;
if (!base) {
  const { createServer } = await import('vite');
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, '');
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
const logs = [];
let pageErrors = 0;
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall|GL Driver Message|WebGL/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => {
  pageErrors++;
  logs.push('[pageerror] ' + String(e?.stack ?? e));
});

await page.goto(base + '/');
await page.waitForFunction(() => window.__darkroom && !document.querySelector('.loading'), null, { timeout: 60000 });
await page.waitForTimeout(800);

const helpers = {
  /** Wait for the viewer to settle (no pending async nodes). */
  settle: async (ms = 400) => {
    await page.waitForTimeout(ms);
    await page.waitForFunction(() => window.__darkroom.ui.getState().pending.length === 0, null, { timeout: 20000 }).catch(() => {});
  },
};

const script = opt('--script');
if (script) {
  const mod = await import(pathToFileURL(resolve(script)).href);
  try {
    await mod.default({ page, base, ...helpers });
  } catch (e) {
    pageErrors++;
    logs.push('[script] ' + String(e?.message ?? e).split('\n')[0]);
  }
}
const ev = opt('--eval');
if (ev) {
  const r = await page.evaluate(`(async () => { const dr = window.__darkroom; return (${ev}); })()`);
  if (r !== undefined) console.log('eval →', JSON.stringify(r));
}
await helpers.settle();
await page.screenshot({ path: out });
console.log(JSON.stringify({ file: out, logs }));
await browser.close();
await server?.close();
process.exit(pageErrors ? 1 : 0);
