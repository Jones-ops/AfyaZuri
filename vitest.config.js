import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.js', 'apps/api/test/unit/**/*.test.js'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/api/test/integration/**/*.test.js'],
          environment: 'node',
          globalSetup: ['apps/api/test/global-setup.js'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
