import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

/**
 * Vite root for the Preact migration.
 *
 * This is deliberately NOT an HTML build. While the port is in progress the vanilla
 * `interface/index.html` is still the page users get, and it loads the bundle produced here
 * as one extra module script. So the build input is `src/main.tsx`, not `index.html`, and
 * `index.html` in this directory exists only as a dev harness (see the file itself).
 *
 * When the migration finishes and Vite owns the page, drop `rollupOptions.input` and let it
 * build `index.html` normally. See docs/FRONTEND-MIGRATION.md.
 */
export default defineConfig({
  plugins: [preact()],

  build: {
    outDir: '../interface/dist',
    emptyOutDir: true,
    sourcemap: true,

    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        // The entry filename is stable and unhashed because a static, hand-written
        // `interface/index.html` has to reference it by name. That makes it a mutable URL,
        // which is exactly why `revalidate_interface_assets` in src/api/app.py has to send
        // `no-cache` for it - otherwise upgrading the container leaves people on the old
        // bundle, which is the "I upgraded and nothing changed" bug that middleware exists
        // to prevent.
        entryFileNames: 'jimbrainz-ui.js',
        // Split chunks and assets keep their hashes and are served immutable. Same file
        // contents always mean the same URL, so caching them hard is safe.
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },

  server: {
    proxy: {
      // dev against the real FastAPI backend, so no CORS handling is needed
      '/jimbrainz': 'http://127.0.0.1:8080',
      // the dev harness reuses the real stylesheet and fonts rather than a copy that can
      // drift out of sync with what production actually serves
      '/styles': 'http://127.0.0.1:8080',
      '/assets': 'http://127.0.0.1:8080',
    },
  },
})
