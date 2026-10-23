import { defineConfig } from 'vitest/config';

// Own config, so Vitest does not pick up the API's from the repository root.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
