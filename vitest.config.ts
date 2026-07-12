import { defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  plugins: [
    {
      name: 'raw-powershell',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.ps1')) return null;
        return `export default ${JSON.stringify(fs.readFileSync(id, 'utf8'))};`;
      },
    },
  ],
  resolve: {
    alias: {
      'remote-notifier-shared': path.resolve(__dirname, 'shared/index.ts'),
      vscode: path.resolve(__dirname, 'packages/router/test/helpers/vscode-mock.ts'),
      'node-notifier': path.resolve(__dirname, 'packages/main/test/helpers/node-notifier-mock.ts'),
    },
  },
  test: {
    include: [
      'packages/*/test/unit/**/*.test.ts',
      'packages/*/test/integration/**/*.test.ts',
      'shared/test/**/*.test.ts',
      'test/e2e/**/*.test.ts',
    ],
  },
});
