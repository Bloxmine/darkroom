// pnpm electron:dev — Vite dev server (HMR for the renderer) + Electron pointed at it.
// electron/*.ts is rebuilt on change; main-process changes restart Electron, preload changes reload the window.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import electronPath from 'electron';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, mode: 'development' });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`;
server.printUrls();

const compile = () =>
  new Promise((ok, fail) =>
    spawn(process.execPath, [resolve(root, 'scripts/build-electron.mjs')], { cwd: root, stdio: 'inherit' }).on('exit', (c) =>
      c ? fail(new Error('electron compile failed')) : ok(),
    ),
  );

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let quitting = false;
function start() {
  const env = { ...process.env, DARKROOM_DEV_URL: url };
  delete env.ELECTRON_RUN_AS_NODE; // set by some hosts (e.g. editors built on Electron); would start Electron as plain Node
  child = spawn(String(electronPath), ['.'], { cwd: root, stdio: 'inherit', env });
  child.on('exit', () => {
    child = null;
    if (!quitting && !restarting) shutdown(); // window closed / Cmd+Q → stop the dev server too
  });
}
let restarting = false;
async function restart() {
  restarting = true;
  try {
    await compile();
    if (child) {
      const old = child;
      await new Promise((r) => (old.once('exit', r), old.kill()));
    }
    start();
  } catch (e) {
    console.error(e.message);
  } finally {
    restarting = false;
  }
}
async function shutdown() {
  quitting = true;
  child?.kill();
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await compile();
start();
let t;
watch(resolve(root, 'electron'), () => {
  clearTimeout(t);
  t = setTimeout(restart, 200);
});
