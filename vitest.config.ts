import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.{ts,tsx,mjs}', 'packages/**/*.test.ts', 'scripts/**/*.test.{ts,mjs}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.int.test.ts',
      '**/*.real.test.ts',
      '**/*.l08.test.ts',
    ],
    testTimeout: 15_000,
  },
});
