import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
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
      'test/e2e/**/*.test.ts',
    ],
  },
});
