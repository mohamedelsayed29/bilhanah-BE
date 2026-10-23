#!/usr/bin/env bash
# Copies packages/contracts (and packages/config, which it builds with) into the
# website and dashboard repositories. This repository is the source of truth:
# change contracts here, run this, then commit in each repository.
#
#   bash scripts/sync-contracts.sh                 # or: npm run contracts:sync
#   bash scripts/sync-contracts.sh ../web ../dash  # other checkout paths
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
targets=("$@")
((${#targets[@]})) || targets=("$(dirname "$ROOT")/bilhanah-client-FE" "$(dirname "$ROOT")/bilhanah-dashboard-FE")
source_commit="$(git -C "$ROOT" rev-parse --short HEAD)"
[[ -z "$(git -C "$ROOT" status --porcelain -- packages/contracts packages/config)" ]] || source_commit="$source_commit + uncommitted changes"

# Updates the copy in place: built output (dist) and node_modules are never deleted, so a running
# dev server keeps resolving the package while files change.
copy() {
  local from="$1" to="$2" files
  mkdir -p "$to"
  files="$(cd "$from" && git ls-files --cached --others --exclude-standard -- .)"
  (cd "$to" && find . -type f -not -path './dist/*' -not -path './node_modules/*' | sed 's|^\./||') | while read -r file; do
    grep -qxF "$file" <<<"$files" || rm -f "$to/$file"
  done
  while read -r file; do
    mkdir -p "$to/$(dirname "$file")" && cp "$from/$file" "$to/$file"
  done <<<"$files"
}

for target in "${targets[@]}"; do
  [[ -f "$target/package.json" ]] || { echo "Not a repository checkout: $target" >&2; exit 1; }
  copy "$ROOT/packages/contracts" "$target/packages/contracts"
  copy "$ROOT/packages/config" "$target/packages/config"
  cat > "$target/packages/README.md" <<NOTE
# Shared packages (copied, do not edit here)

\`contracts\` and \`config\` are copied from **bilhanah-BE** (\`packages/\`), which
owns them. Change them there, then run \`npm run contracts:sync\` in bilhanah-BE
and commit the result here.

Copied from bilhanah-BE at $source_commit.
NOTE
  # Rebuild there too, so the app sees the change immediately.
  if [[ -d "$target/node_modules" ]]; then (cd "$target" && npm run --silent build -w @bilhanah/contracts); fi
  echo "Synced contracts into $target"
done
