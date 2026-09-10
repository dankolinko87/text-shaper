/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': src },
  },
  /*
   * The port is load-bearing, and moving off it silently loses work.
   *
   * This used to float: "nothing here depends on a fixed port — there are no
   * OAuth callbacks, webhooks, or CORS origins to match." That missed the one
   * thing that does. `localStorage` is partitioned by ORIGIN, and an origin is
   * scheme + host + PORT — so `localhost:5174` is a different storage bucket
   * from `localhost:5173`, holding nothing.
   *
   * With Vite's default `strictPort: false`, a restart while the old process
   * still holds 5173 comes up on 5174 instead, and the app opens on an empty
   * autosave. Nothing has been deleted — the document is intact under the old
   * origin — but every symptom says otherwise: a blank canvas, no history, and
   * an autosave that then starts filling the new bucket.
   *
   * So: fail loudly instead. "Port 5173 is already in use" is a message you can
   * act on; a blank canvas is not. `PORT` still moves it deliberately, which is
   * a choice rather than an accident — and work saved under one port stays
   * there, so keep the same one to come back to it.
   */
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
  test: {
    // The geometry and typography engines are DOM-free by design: paper.js
    // (via paper-core) and js-angusj-clipper both run headless in Node, so the
    // engines are testable without jsdom.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
