import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Use relative paths for assets to support subpath hosting on GitHub Pages
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
});
