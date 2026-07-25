import { defineConfig } from 'vitest/config';

export default defineConfig({
  // This config is separate from vite.config.js and does not inherit its
  // `define` block, so any test importing a component that reaches Header
  // (which reads these build-time constants) would fail at import time.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __GIT_REVISION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
