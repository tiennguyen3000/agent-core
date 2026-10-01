import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Invariant 10: tests must be offline and must not depend on wall-clock timing.
    testTimeout: 5_000,
    hookTimeout: 5_000,
    sequence: { shuffle: false },
  },
});
