#!/usr/bin/env bash
# Runs Bilhanah locally: Docker services, migrations, then the API and the
# background worker, plus the website and the dashboard when their repositories
# are cloned next to this one (../bilhanah-client-FE, ../bilhanah-dashboard-FE).
# Ctrl+C stops the apps; the Docker services keep running (stop them with
# `npm run services:down`).
#
#   bash scripts/dev.sh            # or: npm run dev
#   WEB_PORT=5190 bash scripts/dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WEB_DIR="$(dirname "$ROOT")/bilhanah-client-FE"
DASHBOARD_DIR="$(dirname "$ROOT")/bilhanah-dashboard-FE"

WEB_PORT="${WEB_PORT:-5180}"
# Fixed: the API allows this origin (CORS_ORIGINS) and email links point at it (DASHBOARD_URL).
DASHBOARD_PORT=5174

bold=$'\e[1m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' blue=$'\e[34m' magenta=$'\e[35m' cyan=$'\e[36m' reset=$'\e[0m'
step() { printf '%s==>%s %s\n' "$bold$blue" "$reset" "$*"; }
fail() { printf '%sError:%s %s\n' "$bold$red" "$reset" "$*" >&2; exit 1; }

# --- Prerequisites ----------------------------------------------------------
command -v node >/dev/null || fail "Node.js is not installed (version 24 or newer is required)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 24 )) || fail "Node.js 24 or newer is required; found $(node -v)."
command -v docker >/dev/null || fail "Docker is not installed."
docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop (and its engine), then try again."

# --- Environment ------------------------------------------------------------
if [[ ! -f .env ]]; then
  step "Creating .env from .env.example"
  secret="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  sed -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$secret|" \
      -e "s|^RESTAURANT_URL_TEMPLATE=.*|RESTAURANT_URL_TEMPLATE=http://{subdomain}.localhost:$WEB_PORT|" \
      .env.example > .env
fi
API_PORT="$(sed -n 's/^PORT=//p' .env | tail -1)"
API_PORT="${API_PORT:-3000}"

port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
for port in "$API_PORT" "$WEB_PORT" "$DASHBOARD_PORT"; do
  if port_in_use "$port"; then
    holder="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
    detail=""
    [[ -n "$holder" ]] && detail=" by: $(ps -o args= -p "$holder" | cut -c1-120)"
    fail "Port $port is already in use$detail. Stop it, or choose another port (WEB_PORT=... or PORT in .env)."
  fi
done

# --- Dependencies -----------------------------------------------------------
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  step "Installing dependencies"
  npm install
elif [[ ! -f packages/contracts/dist/index.js || ! -f packages/database/dist/index.js ]]; then
  step "Building shared packages"
  npm run build:packages
fi
frontends=()
for dir in "$WEB_DIR" "$DASHBOARD_DIR"; do
  if [[ -f "$dir/package.json" ]]; then
    frontends+=("$dir")
    if [[ ! -d "$dir/node_modules" || "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]]; then
      step "Installing dependencies in $(basename "$dir")"
      (cd "$dir" && npm install)
    fi
  else
    printf '%sNote:%s %s is not cloned next to this repository; skipping it.\n' "$yellow" "$reset" "$(basename "$dir")"
  fi
done

# --- Services and database --------------------------------------------------
step "Starting PostgreSQL, Redis and Mailpit"
npm run --silent services:up
step "Applying database migrations"
npm run --silent db:deploy >/dev/null

# --- Apps -------------------------------------------------------------------
pids=()
cleanup() {
  trap - INT TERM EXIT
  if ((${#pids[@]})); then
    printf '\n'
    step "Stopping the apps"
    for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
  fi
}
trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

# Each app runs in its own process group so the whole tree (npm, nest --watch,
# node) stops together. Output is prefixed with the app's name.
start() {
  local name="$1" color="$2" command="$3"
  setsid bash -c "$command 2>&1 | sed -u 's/^/$color[$name]$reset /'" &
  pids+=("$!")
}

step "Starting the API and worker${frontends:+, website and dashboard}"
start api "$green" "npm run --silent start:dev"
start worker "$magenta" "npm run --silent start:worker:dev"
if [[ -f "$WEB_DIR/package.json" ]]; then
  start web "$cyan" "cd '$WEB_DIR' && VITE_API_URL=http://127.0.0.1:$API_PORT VITE_ROOT_DOMAIN=localhost \
    VITE_DASHBOARD_URL=http://127.0.0.1:$DASHBOARD_PORT npm run --silent dev -- --port $WEB_PORT --strictPort"
fi
if [[ -f "$DASHBOARD_DIR/package.json" ]]; then
  start dashboard "$yellow" "cd '$DASHBOARD_DIR' && VITE_API_URL=http://127.0.0.1:$API_PORT npm run --silent dev"
fi

# Wait for the API, then print where everything is.
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$API_PORT/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if curl -sf "http://127.0.0.1:$API_PORT/health/ready" >/dev/null 2>&1; then
  cat <<EOF

${bold}${green}Bilhanah is running${reset}
  Website            http://127.0.0.1:$WEB_PORT
  Restaurant pages   http://<subdomain>.localhost:$WEB_PORT
  Dashboard          http://127.0.0.1:$DASHBOARD_PORT
  API                http://127.0.0.1:$API_PORT  (health: /health/ready)
  Email (Mailpit)    http://127.0.0.1:8025
  Database           postgresql://127.0.0.1:55432/bilhanah  (npm run db:studio)

Press Ctrl+C to stop.

EOF
else
  printf '%sThe API did not become ready; see the [api] output above.%s\n' "$yellow" "$reset"
fi

# Stop everything as soon as any app exits.
wait -n
printf '%sAn app exited; stopping the rest.%s\n' "$yellow" "$reset"
