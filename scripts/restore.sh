#!/usr/bin/env bash
# Restores a backup into the running database, replacing its contents.
#   bash infra/scripts/restore.sh /var/backups/bilhanah/bilhanah-....dump
# Stops the API and worker first so nothing writes during the restore.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

dump="${1:?Usage: restore.sh <file.dump>}"
[[ -f "$dump" ]] || { echo "No such file: $dump" >&2; exit 1; }
compose=(docker compose -f infra/compose.prod.yml --env-file infra/.env.prod)

read -r -p "Replace the production database with $(basename "$dump")? Type 'restore' to continue: " answer
[[ "$answer" == restore ]] || { echo "Cancelled."; exit 1; }

"${compose[@]}" stop api worker
"${compose[@]}" exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$dump"
"${compose[@]}" start api worker
echo "Restored $(basename "$dump")."
