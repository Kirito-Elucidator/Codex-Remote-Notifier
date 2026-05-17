import * as esbuild from 'esbuild';
import { cpSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isWatch = process.argv.includes('--watch');

function copyAssets() {
  const notifierDir = dirname(require.resolve('node-notifier/package.json'));
  cpSync(resolve(notifierDir, 'vendor'), resolve(__dirname, 'dist/vendor'), {
    recursive: true,
    force: true,
  });
  cpSync(resolve(__dirname, '../../assets/icon.png'), resolve(__dirname, 'dist/icon.png'));
  cpSync(
    resolve(__dirname, '../../assets/icon-transparent.png'),
    resolve(__dirname, 'dist/icon-transparent.png'),
  );
  cpSync(
    resolve(__dirname, '../../assets/notification.wav'),
    resolve(__dirname, 'dist/notification.wav'),
  );
  cpSync(resolve(__dirname, '../../assets/icon-transparent.png'), resolve(__dirname, 'icon.png'));
  cpSync(resolve(__dirname, '../../LICENSE'), resolve(__dirname, 'LICENSE'));
  cpSync(resolve(__dirname, '../../README.md'), resolve(__dirname, 'README.md'));
}

// Plugin to rewrite node-notifier's __dirname-based vendor paths
// to point to our copied vendor/ directory next to the bundle output.
const vendorPathPlugin = {
  name: 'vendor-path',
  setup(build) {
    build.onLoad({ filter: /node-notifier[\\/]notifiers[\\/]/ }, async (args) => {
      const fs = await import('fs');
      let contents = fs.readFileSync(args.path, 'utf8');
      // Replace: path.resolve(__dirname, '../vendor/...')
      // Or:      path.join(__dirname, '../vendor/...')
      // With:    path.resolve(__dirname, 'vendor/...')
      // Because in the bundle, __dirname is dist/ and vendor/ is at dist/vendor/
      contents = contents.replace(
        /path\.(resolve|join)\(\s*__dirname\s*,\s*['"]\.\.\/vendor\//g,
        (match, fn) => `path.${fn}(__dirname, 'vendor/`,
      );
      return { contents, loader: 'js' };
    });
  },
};

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
  plugins: [vendorPathPlugin],
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyAssets();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  copyAssets();
  console.log('Main extension built.');
}
