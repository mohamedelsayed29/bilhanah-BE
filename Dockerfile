# syntax=docker/dockerfile:1
# Build from the repository root: docker build .

FROM node:24-slim AS base
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

# Every workspace manifest, so npm ci can validate the lockfile.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/

FROM manifests AS build
RUN npm ci --ignore-scripts
COPY packages packages
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src src
RUN npm run build:packages && npm run build

# Runs `prisma migrate deploy` as a one-off container before each release.
FROM build AS migrate
WORKDIR /app/packages/database
CMD ["npx", "prisma", "migrate", "deploy"]

# Packages the lockfile marks devOptional (the Prisma CLI, Studio and
# TypeScript, which @prisma/client lists as optional peers) are removed after
# the install. --omit=optional is not used because sharp's native binaries are
# optional dependencies.
FROM manifests AS prod-deps
RUN npm ci --ignore-scripts --omit=dev \
 && node -e "const fs=require('fs');const p=require('./package-lock.json').packages;for(const[k,v]of Object.entries(p))if(v.devOptional&&k.startsWith('node_modules/'))fs.rmSync(k,{recursive:true,force:true})"

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*
COPY assets/reports assets/reports
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/contracts/package.json packages/contracts/
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/database/package.json packages/database/
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/dist dist
# Mount point for STORAGE_DRIVER=local. A new named volume takes this ownership,
# so the unprivileged user can write uploads.
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# The worker runs from this image with: node dist/worker.js
CMD ["node", "dist/main.js"]
