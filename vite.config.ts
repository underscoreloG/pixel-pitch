import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so the build works under any path (GitHub Pages serves it at /pixel-pitch/).
  base: './',
  server: { port: 5180 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
