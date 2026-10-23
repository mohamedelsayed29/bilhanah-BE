#!/usr/bin/env bash
# Runs all of Bilhanah on this computer: the API and worker (this repository),
# the website and the dashboard. The website and dashboard repositories are
# cloned next to this one if they are missing. Then scripts/dev.sh starts
# PostgreSQL, Redis and Mailpit in Docker, applies migrations and runs the apps.
#
#   bash run.sh             # start everything
#   bash run.sh --update    # first pull the latest main in all three repositories
#   bash run.sh --demo      # also create the demo restaurant (koshary-demo)
#
# Needs git, Node.js 24+ and Docker. On Windows, run it inside WSL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT="$(dirname "$ROOT")"
cd "$ROOT"

update=false demo=false
for arg in "$@"; do
  case "$arg" in
    --update) update=true ;;
    --demo) demo=true ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see bash run.sh --help)" >&2; exit 1 ;;
  esac
done

bold=$'\e[1m' red=$'\e[31m' blue=$'\e[34m' reset=$'\e[0m'
step() { printf '%s==>%s %s\n' "$bold$blue" "$reset" "$*"; }
fail() { printf '%sError:%s %s\n' "$bold$red" "$reset" "$*" >&2; exit 1; }

command -v git >/dev/null || fail "git is not installed."

# The sibling repositories live where this one came from (same owner, same
# protocol), so forks and SSH clones keep working.
origin="$(git remote get-url origin 2>/dev/null || echo https://github.com/mohamedelsayed29/bilhanah-BE)"
for repo in bilhanah-client-FE bilhanah-dashboard-FE; do
  if [[ ! -d "$PARENT/$repo/.git" ]]; then
    [[ -e "$PARENT/$repo" ]] && fail "$PARENT/$repo exists but is not a git repository; move it away and run again."
    url="${origin%/bilhanah-BE*}/$repo"
    step "Cloning $repo next to this repository"
    git clone "$url" "$PARENT/$repo"
  fi
done

if $update; then
  for dir in "$ROOT" "$PARENT/bilhanah-client-FE" "$PARENT/bilhanah-dashboard-FE"; do
    step "Updating $(basename "$dir")"
    [[ "$(git -C "$dir" branch --show-current)" == main ]] || fail "$(basename "$dir") is not on main; switch to main or update it yourself."
    git -C "$dir" pull --ff-only
  done
fi

if $demo; then
  # Once the API answers, create the demo restaurant (it is skipped if it already exists).
  api_port="$( [[ -f .env ]] && sed -n 's/^PORT=//p' .env | tail -1 || true)"
  (
    for _ in $(seq 1 300); do
      curl -sf "http://127.0.0.1:${api_port:-3000}/health/ready" >/dev/null 2>&1 && break
      sleep 1
    done
    sleep 3
    npm run --silent seed:demo 2>&1 | sed 's/^/[demo] /'
  ) &
fi

exec bash scripts/dev.sh
