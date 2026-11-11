// Compiles electron/main.ts (ESM) and electron/preload.ts (CJS, required by the sandbox)
// into dist-electron/ with Vite's bundler. `--watch` rebuilds on change (used by electron-dev.mjs).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Core ML helper (native/coreml-sd, Swift on Apple's ml-stable-diffusion): a universal (arm64 + x86_64) binary in
// dist-native/darkroom-coreml/, packaged via the "extraResources" entry in package.json and ad-hoc signed like the app.
// Skipped off macOS, without a Swift toolchain, in --watch mode, or with DARKROOM_SKIP_COREML=1 — the app then shows
// the engine as unavailable.
if (!watch) buildCoreMLHelper();

function buildCoreMLHelper() {
  if (process.platform !== 'darwin' || process.env.DARKROOM_SKIP_COREML) return console.log('Core ML helper: skipped');
  const pkg = resolve(root, 'native/coreml-sd');
  const outDir = resolve(root, 'dist-native/darkroom-coreml');
  const out = resolve(outDir, 'darkroom-coreml');
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: pkg, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
  let archs = ['arm64', 'x86_64'];
  try {
    const flags = archs.flatMap((a) => ['--arch', a]);
    try {
      run('swift', ['build', '-c', 'release', ...flags]);
    } catch {
      console.warn('Core ML helper: the universal build failed, building arm64 only (the engine is then disabled on Intel Macs)');
      archs = ['arm64'];
      run('swift', ['build', '-c', 'release', '--arch', 'arm64']);
    }
    const bin = resolve(run('swift', ['build', '-c', 'release', ...archs.flatMap((a) => ['--arch', a]), '--show-bin-path']), 'DarkroomCoreML');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    copyFileSync(bin, out);
    execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
    const lipo = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim().split(/\s+/);
    writeFileSync(out + '.json', JSON.stringify({ archs: lipo, mlStableDiffusion: '1.1.1 (5a170d29cf38e674b80541d7ce22929c6a11cdde)' }, null, 2));
    console.log(`built dist-native/darkroom-coreml/darkroom-coreml (${lipo.join(' + ')}, ad-hoc signed)`);
  } catch (e) {
    console.warn('Core ML helper: build failed — the app will show the built-in engine as unavailable.', e?.message ?? e);
  }
}
