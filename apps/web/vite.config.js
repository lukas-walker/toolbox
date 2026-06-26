import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
    plugins: [
        VitePWA({
            registerType: "autoUpdate",
            injectRegister: "auto",
            includeAssets: [
                "vendor/qrcode.min.js"
            ],
            workbox: {
                // Cache the built app shell so it loads instantly and works offline.
                globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
                cleanupOutdatedCaches: true,
                clientsClaim: true,
                skipWaiting: true,
                navigateFallback: "index.html"
            },
            manifest: {
                id: "/",
                name: "Toolbox",
                short_name: "Toolbox",
                description: "Local-first toolbox (PDF + QR) running entirely in your browser.",
                start_url: "/",
                scope: "/",
                display: "standalone",
                display_override: ["standalone", "minimal-ui"],
                orientation: "portrait",
                background_color: "#ffffff",
                theme_color: "#ffffff",
                icons: [
                    {
                        src: "pwa-192x192.png",
                        sizes: "192x192",
                        type: "image/png"
                    },
                    {
                        src: "pwa-512x512.png",
                        sizes: "512x512",
                        type: "image/png"
                    },
                    {
                        src: "pwa-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "any maskable"
                    }
                ]
            }
        })
    ]
});
