import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 90000,
    hookTimeout: 60000,
    fileParallelism: false,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'dist/**'],
      thresholds: {
        'src/routes/bills/**': {
          lines: 85,
        },
        'src/services/sync*/**': {
          lines: 85,
        },
        'src/auth/**': {
          lines: 85,
        },
      },
    },
  },
});
