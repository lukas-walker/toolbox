import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
    plugins: [
        VitePWA({
            registerType: "autoUpdate",
            includeAssets: [
                "vendor/qrcode.min.js"
            ],
            manifest: {
                name: "Toolbox",
                short_name: "Toolbox",
                description: "Local-first toolbox (PDF + QR) running entirely in your browser.",
                start_url: ".",
                scope: ".",
                display: "standalone",
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
                    }
                ]
            }
        })
    ]
});
