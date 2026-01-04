# Toolbox (Browser-Only Utilities)

A lightweight, self-hosted set of browser tools designed to run **entirely on the end user’s device**:
- No uploads
- No server-side processing (static hosting)
- Works well on mobile browsers

Current tools:
- **Combine PDFs** (merge multiple PDFs locally)
- **Split PDF** (extract page ranges locally)
- **Image to PDF** (images/PDFs/camera capture → PDF; optional image compression)
- **Compress PDF (Advanced)** (placeholder for future WASM-based compression)
- **QR Code** (SVG + PNG download; local generation)

## Tech stack

- Vanilla JS + Vite (no framework)
- `pdf-lib` for PDF creation/merging/splitting
- QR generator loaded locally from `public/vendor/qrcode.min.js`
- Static deployment (Docker + nginx)

## Local development

From the repo root:

```bash
npm install
npm run dev
```

Vite dev server runs on: `http://localhost:5173`

Build:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Project structure (monorepo)

```text
.
├─ apps/
│  └─ web/                 # Vite static frontend
├─ Dockerfile              # Builds + serves the frontend with nginx
├─ nginx.conf              # nginx config for static hosting
└─ package.json            # npm workspaces root
```

## Deployment (Coolify)

### Option A — Dockerfile deployment (recommended)

1. Push this repo to GitHub
2. In Coolify, create a new application from the repository
3. Choose **Dockerfile** build
4. Deploy

This builds the static site and serves it with nginx on port 80.

### Notes
- The app is a static site. No persistent storage is required.
- Future Tiny URL functionality will add an optional API service under `apps/tiny-api/` and route `/api/*` + `/r/*` to it via the reverse proxy.

## Licensing

This repository includes third-party dependencies. Ensure you preserve upstream licenses when redistributing:
- `pdf-lib` (MIT)
- QR generator library (see the license included with your `qrcode.min.js` source)

Add a `NOTICE` file if you want to explicitly list third-party licenses and attributions.

## Roadmap (planned)

- QR tool: import/export presets
- Advanced PDF compression using Ghostscript WASM (opt-in, lazy-loaded)
- Optional Tiny URL service (flat-file storage + minimal API)
- Optional “scan mode” (document edge detection + perspective correction) via lazy-loaded OpenCV.js
