import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Der Kern liegt als TS-Quelle im Workspace; Vite soll ihn nicht vorab bündeln.
  optimizeDeps: { exclude: ["@okg/core"] },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: false,
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "OKG Chat - Antworten mit Wikidata und DBpedia",
        short_name: "OKG Chat",
        description:
          "Chat, dessen Prompt vor dem Modellaufruf mit Wikidata und DBpedia angereichert wird.",
        lang: "de",
        start_url: "/",
        display: "standalone",
        background_color: "#0d3b2e",
        theme_color: "#0d3b2e",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
