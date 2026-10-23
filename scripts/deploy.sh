#!/usr/bin/env bash
# Builds and starts a release on the server: images, migrations, then a
# rolling restart of the API so the site stays up. Run from the repository root.
#   bash infra/scripts/deploy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

compose=(docker compose -f infra/compose.prod.yml --env-file infra/.env.prod)
[[ -f infra/.env.prod ]] || { echo "infra/.env.prod is missing (see infra/.env.prod.example)." >&2; exit 1; }

echo "==> Building images"
"${compose[@]}" build api migrate caddy

echo "==> Starting the database and Redis"
"${compose[@]}" up -d --wait postgres redis

echo "==> Applying migrations"
"${compose[@]}" run --rm migrate

echo "==> Rolling out the API, worker and edge"
# --no-deps keeps postgres/redis running; compose replaces containers one service at a time.
"${compose[@]}" up -d --no-deps --wait api
"${compose[@]}" up -d --no-deps worker caddy

echo "==> Checking health"
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    echo "Release is live."; exit 0
  fi
  sleep 2
done
echo "The API did not become ready; check: docker compose -f infra/compose.prod.yml logs api" >&2
exit 1
