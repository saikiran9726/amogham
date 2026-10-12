import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'dist/**'],
      thresholds: {
        'src/money/**': {
          lines: 90,
        },
      },
    },
  },
});
