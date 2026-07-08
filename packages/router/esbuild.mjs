import * as esbuild from 'esbuild';
import { cpSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

function copyAssets() {
  cpSync(resolve(__dirname, '../../assets/icon-transparent.png'), resolve(__dirname, 'icon.png'));
  cpSync(resolve(__dirname, '../../LICENSE'), resolve(__dirname, 'LICENSE'));
}

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
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
  copyAssets();
  console.log('Router extension built.');
}
