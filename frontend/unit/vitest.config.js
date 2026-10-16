// jsdom so the DOM-based _escText (document.createElement) runs under Node.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['*.test.js'],
    // West of Greenwich, so date helpers that parse 'YYYY-MM-DD' through
    // new Date() (UTC midnight) would land on the previous day and fail —
    // under a UTC runner such a bug passes unnoticed.
    env: { TZ: 'America/Los_Angeles' },
  },
});
