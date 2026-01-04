# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app

# Copy workspace manifests first for better caching
COPY package.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web/vite.config.js ./apps/web/vite.config.js

# Install dependencies (workspace-aware)
RUN npm install

# Copy the rest of the web app
COPY apps/web ./apps/web

# Build static assets
RUN npm --workspace apps/web run build

# --- Runtime stage ---
FROM nginx:alpine AS runtime

# Optional: tighter nginx defaults
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built site
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
