# syntax=docker/dockerfile:1
# The edge: Caddy (with the Cloudflare DNS module for the wildcard certificate)
# serving the website and dashboard and proxying the API.
# Build from the repository root: docker build -f infra/caddy/Dockerfile .

FROM caddy:2.11.7-builder AS caddy
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM node:24-slim AS frontends
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps/web apps/web
COPY apps/dashboard apps/dashboard
# Public origins are compiled into the bundles.
ARG VITE_API_URL
ARG VITE_ROOT_DOMAIN
ARG VITE_DASHBOARD_URL
ARG VITE_CONTACT_EMAIL
ARG VITE_CONTACT_WHATSAPP
ENV VITE_API_URL=$VITE_API_URL VITE_ROOT_DOMAIN=$VITE_ROOT_DOMAIN VITE_DASHBOARD_URL=$VITE_DASHBOARD_URL \
    VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL VITE_CONTACT_WHATSAPP=$VITE_CONTACT_WHATSAPP
RUN npm run build -w @bilhanah/contracts \
 && npm run build -w @bilhanah/web \
 && npm run build -w @bilhanah/dashboard

FROM caddy:2.11.7
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY infra/caddy/tls /etc/caddy/tls
COPY --from=frontends /app/apps/web/dist /srv/web
COPY --from=frontends /app/apps/dashboard/dist /srv/dashboard
