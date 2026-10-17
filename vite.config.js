import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // three.js is most of the bundle; one chunk is fine for a single-page study
    chunkSizeWarningLimit: 800,
  },
});
