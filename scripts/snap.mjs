#!/usr/bin/env node
/**
 * Render harness URLs headlessly and save PNG screenshots.
 *
 *   node scripts/snap.mjs out.png "preset=camera.vhs&img=street" [out2.png "node=color.levels"] ...
 *
 * Prints one JSON line per shot: { file, ok, ms, width, height, errors }.
 * Uses a running dev server if SNAP_URL is set (e.g. http://localhost:5173), else starts Vite itself.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error('usage: snap.mjs <out.png> <query> [<out.png> <query> ...]');
  process.exit(1);
}

let base = process.env.SNAP_URL;
let server;
if (!base) {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/GPU stall|GL Driver Message/.test(m.text()) && logs.push(m.text()));
page.on('pageerror', (e) => logs.push(String(e)));

let failed = false;
for (let i = 0; i < args.length; i += 2) {
  const [file, query] = [args[i], args[i + 1]];
  logs.length = 0;
  await page.goto(`${base}/harness.html?${query}`);
  try {
    await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
  } catch {
    console.log(JSON.stringify({ file, ok: false, errors: { timeout: 'no result in 60s' }, logs }));
    failed = true;
    continue;
  }
  const result = await page.evaluate(() => window.__result);
  const size = await page.evaluate(() => { const c = document.getElementById('c'); return { w: c.width, h: c.height }; });
  await page.setViewportSize({ width: Math.max(1, size.w), height: Math.max(1, size.h) });
  await page.locator('#c').screenshot({ path: file });
  if (!result.ok) failed = true;
  console.log(JSON.stringify({ file, ...result, ...(logs.length ? { logs: logs.slice(0, 5) } : {}) }));
}
await browser.close();
await server?.close();
process.exit(failed ? 1 : 0);
