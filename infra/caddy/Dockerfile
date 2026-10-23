# syntax=docker/dockerfile:1
# The edge: Caddy with the Cloudflare DNS module (for the wildcard certificate),
# proxying the API, the website and the dashboard containers.
# Build from the repository root: docker build -f infra/caddy/Dockerfile .

FROM caddy:2.11.7-builder AS caddy
RUN xcaddy build v2.11.7 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.7
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY infra/caddy/tls /etc/caddy/tls
