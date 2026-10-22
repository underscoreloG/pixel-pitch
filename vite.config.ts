import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  // Relative asset URLs so the build works under any path (GitHub Pages serves it at /pixel-pitch/).
  base: './',
  // package.json is the single source of the version shown on the main menu.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5180 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
