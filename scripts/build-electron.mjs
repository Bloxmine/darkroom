// Compiles electron/main.ts (ESM) and electron/preload.ts (CJS, required by the sandbox)
// into dist-electron/ with Vite's bundler. `--watch` rebuilds on change (used by electron-dev.mjs).
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const watch = process.argv.includes('--watch');
const external = ['electron', /^electron\//, ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/** @param {{ entry: string; fileName: string; format: 'es' | 'cjs' }} o */
const config = ({ entry, fileName, format }) => ({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    sourcemap: true,
    reportCompressedSize: false,
    watch: watch ? {} : null,
    lib: { entry: resolve(root, entry), formats: [format], fileName: () => fileName },
    rollupOptions: { external, output: { exports: 'auto' } },
  },
});

await build(config({ entry: 'electron/main.ts', fileName: 'main.mjs', format: 'es' }));
await build(config({ entry: 'electron/preload.ts', fileName: 'preload.cjs', format: 'cjs' }));
if (!watch) console.log('built dist-electron/main.mjs + preload.cjs');
