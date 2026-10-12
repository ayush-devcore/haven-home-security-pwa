
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),

    VitePWA({
      registerType: 'autoUpdate',

      // We already created public/manifest.webmanifest.
      // Keep using our existing manifest instead of generating another.
      manifest: false,

      includeAssets: ['haven-icon.svg'],

      workbox: {
        globPatterns: [
          '**/*.{js,css,html,ico,png,svg,webmanifest}',
        ],
      },
    }),
  ],
})
