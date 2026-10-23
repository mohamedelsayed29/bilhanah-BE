#!/usr/bin/env bash
# Nightly database backup (cron: 0 3 * * * /opt/bilhanah/infra/scripts/backup.sh).
# Keeps BACKUP_DAYS of local dumps in BACKUP_DIR and, when an rclone remote is
# configured (BACKUP_REMOTE, e.g. r2:bilhanah-backups), copies each dump off the server.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

BACKUP_DIR="${BACKUP_DIR:-/var/backups/bilhanah}"
BACKUP_DAYS="${BACKUP_DAYS:-30}"
compose=(docker compose -f infra/compose.prod.yml --env-file infra/.env.prod)

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/bilhanah-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Custom format: compressed, and restorable table by table with pg_restore.
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$file.partial"
mv "$file.partial" "$file"
echo "Wrote $file ($(du -h "$file" | cut -f1))"

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rclone copy "$file" "$BACKUP_REMOTE/"
  echo "Copied to $BACKUP_REMOTE"
fi
find "$BACKUP_DIR" -name 'bilhanah-*.dump' -mtime +"$BACKUP_DAYS" -delete
