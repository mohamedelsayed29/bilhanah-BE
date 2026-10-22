# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile .

FROM node:24-slim AS base
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

# Every workspace manifest, so npm ci can validate the lockfile.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

FROM manifests AS build
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps/api apps/api
RUN npm run build -w @bilhanah/contracts -w @bilhanah/database -w @bilhanah/backend

# Runs `prisma migrate deploy` as a one-off container before each release.
FROM build AS migrate
WORKDIR /app/packages/database
CMD ["npx", "prisma", "migrate", "deploy"]

# Only the API's workspaces: npm ci ignores -w filters, so the web manifest is
# left out to keep its dependencies out. --omit=optional drops the Prisma CLI
# and TypeScript, which @prisma/client lists as optional peers.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts --omit=dev --omit=optional

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/contracts/package.json packages/contracts/
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/database/package.json packages/database/
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# The worker runs from this image with: node dist/worker.js
CMD ["node", "dist/main.js"]
