# Project Handoff — Browser‑Only Toolbox

This document captures the **idea, constraints, architecture, and current implementation state**
of the project so a future ChatGPT instance (or human) can immediately continue work without
re-discovery.

---

## 1. Core Idea & Goals

A **self‑hosted, browser‑only toolbox** providing document and utility functions:

- Runs **entirely on the end user’s device**
- **No uploads**, no background processing
- Works **offline after initial page load**
- High compatibility, especially **mobile browsers**
- Cheap to host (static site)
- Modular and easily extendable

Primary motivation:
- Privacy (documents never leave device)
- Zero server cost
- Simple deployment
- Long‑term extensibility

---

## 2. Current Tools Implemented

### PDF / Document Tools
- **Combine PDFs**
- **Split PDF**
- **Image to PDF**
  - Accepts:
    - Multiple images (JPEG/PNG)
    - PDFs (appended as-is)
    - Camera photos (mobile browsers)
  - Optional image compression
  - File reordering (Up / Down / Remove)
  - Drag & drop + file picker
- **Compress PDF (Advanced)** (placeholder for future WASM-based compression)

### QR Code Tool
- Based on `qrcode-svg`
- Fully local generation
- Outputs:
  - SVG (Download SVG button)
  - PNG (Download PNG button via canvas rendering)
- QR code library is loaded lazily from `/public/vendor/qrcode.min.js`
- No bundling of QR library (max compatibility)

---

## 3. Non‑Goals (By Design)

- No authentication
- No database (for now)
- No server-side PDF/image processing
- No external APIs required

---

## 4. Architecture Overview

### Monorepo Structure
```text
.
├─ apps/
│  └─ web/                 # Static frontend (Vite)
│     ├─ src/
│     │  ├─ tools/         # Each tool is a self-contained module
│     │  │  ├─ image-to-pdf/
│     │  │  ├─ combine-pdf/
│     │  │  ├─ split-pdf/
│     │  │  ├─ compress-pdf/
│     │  │  ├─ qr/
│     │  │  └─ shell/      # Tab system + async tool loader
│     │  └─ shared/
│     │     ├─ download.js
│     │     ├─ loadScript.js
│     │     └─ pdf.js helpers
│     ├─ public/
│     │  └─ vendor/
│     │     └─ qrcode.min.js
│     └─ style.css
├─ Dockerfile
├─ nginx.conf
└─ README.md
```

### Key Design Decisions
- **Each tool exports a factory**
  ```js
  {
    id,
    label,
    init(container),
    destroy()
  }
  ```
- Shell handles:
  - Tabs
  - Tool lifecycle
  - Async initialization (important for lazy-loaded libs)
- Zero shared state between tools (except shared helpers)

---

## 5. Tool Shell (Important)

The shell supports **async `init()`** to allow:
- Lazy loading of large libraries (QR, future WASM)
- Safe tab switching during async loads

Key properties:
- Uses an `activationToken` to cancel outdated renders
- Displays a loading indicator
- Calls `destroy()` on tool switch

This is critical for future tools.

---

## 6. Deployment Architecture

### Current Deployment
- **Static build**
- Served via **nginx**
- Dockerized
- Hosted on **Coolify**

### Docker Notes
- Container listens on **port 80**
- Coolify must be configured to route traffic to **container port 80**
- “Bad Gateway” issues usually mean the port was misconfigured in Coolify

### Files
- `Dockerfile`: multi-stage (Node build → nginx runtime)
- `nginx.conf`: static serving + security headers

---

## 7. Licensing & Compliance

- All computation happens client-side
- No SaaS usage
- All third-party libraries must preserve their licenses:
  - `pdf-lib` (MIT)
  - `qrcode-svg` (MIT-style, see upstream)
- Project is intended to be open-source friendly

---

## 8. Planned / Future Extensions

### A) Tiny URL Service (Optional Server Side)
- Minimal API
- Very low traffic
- Flat-file storage (JSON or CSV)
- Endpoints:
  - create short URL
  - redirect
  - delete
- Would live as:
  ```text
  apps/tiny-api/
  ```
- Reverse-proxied via nginx or Coolify

### B) Advanced PDF Compression
- WASM-based (Ghostscript or similar)
- Loaded lazily only when tab is opened
- Must degrade gracefully if WASM blocked

### C) Document Scan Mode
- Detect page borders
- Perspective correction
- Crop to A4/Letter
- Likely via OpenCV.js (lazy loaded)
- Optional checkbox per image

---

## 9. UX Principles Followed

- Explicit buttons for downloads (no hidden click actions)
- Mobile-first compatibility
- Drag & drop always optional
- No modal traps
- All actions reversible (clear, reorder)

---

## 10. How to Continue This Project

A future ChatGPT instance should:
1. Read this file
2. Inspect `apps/web/src/tools/`
3. Follow existing tool patterns
4. Keep all heavy logic client-side
5. Lazy-load anything > ~50 KB
6. Never introduce server-side processing unless explicitly required

---

## 11. Keywords for Future Context Recall

browser-only tools  
client-side PDF  
WASM optional  
static hosting  
Coolify Docker nginx  
privacy-first utilities  
monorepo Vite  
tool shell async init  

---

End of handoff.
