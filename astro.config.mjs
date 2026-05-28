import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  site: 'https://maticorv.github.io',
  base: '/rcm-csv',
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ['pdfjs-dist'],
    },
    worker: {
      format: 'es',
    },
  },
});
