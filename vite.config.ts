import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      includeAssets: ['haven-icon.svg', 'push-sw.js'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Add push + notification-click handlers to the generated Workbox worker.
        importScripts: ['push-sw.js'],
      },
    }),
  ],
})
