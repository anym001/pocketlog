// jsdom so the DOM-based _escText (document.createElement) runs under Node.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['*.test.js'],
  },
});
