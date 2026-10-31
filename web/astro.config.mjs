import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  output: 'static',
  integrations: [svelte()],
  devToolbar: { enabled: false },
  vite: {
    server: {
      fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    },
  },
});
