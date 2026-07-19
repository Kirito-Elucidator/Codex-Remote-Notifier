import * as esbuild from 'esbuild';
import { cpSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

function copyAssets() {
  cpSync(resolve(__dirname, '../../assets/icon-transparent.png'), resolve(__dirname, 'icon.png'));
  cpSync(resolve(__dirname, '../../LICENSE'), resolve(__dirname, 'LICENSE'));
}

function verifySidecarBundle() {
  const bundle = readFileSync(resolve(__dirname, 'dist/codex-notifier-sidecar.js'), 'utf8');
  if (/require\((['"])vscode\1\)/.test(bundle)) {
    throw new Error('Codex sidecar bundle must not depend on the VS Code extension host');
  }
}

const buildOptions = {
  entryPoints: {
    extension: 'src/extension.ts',
    'codex-notifier-sidecar': 'src/sidecar/codex-notifier-sidecar.ts',
  },
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !isWatch,
  loader: {
    '.sh': 'text',
    '.cmd': 'text',
    '.py': 'text',
  },
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyAssets();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  verifySidecarBundle();
  copyAssets();
  console.log('Router extension built.');
}
