import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // song enrichment looks songs up on Deezer/iTunes: never from a test (the hook's own tests switch it on)
    env: { SONG_ENRICHMENT_ENABLED: '0' },
  },
});
