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
NPM_PREFIX="$(npm prefix)"
NPM_BIN="$NPM_PREFIX/node_modules/.bin"
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
# Web Push keys for order-ready alerts; older .env files get them too.
if ! grep -q '^VAPID_PUBLIC_KEY=' .env; then
  step "Adding Web Push keys to .env"
  { printf '\n# Web Push (order-ready alerts). Keep them: new keys orphan existing subscriptions.\n'; node scripts/generate-vapid-keys.mjs; } >> .env
fi
# --paymob-sandbox (run.sh) or PAYMOB_SANDBOX=1: online payments through the local stand-in
# for Paymob (scripts/paymob-sandbox.mjs), unless real Paymob keys are already set.
API_PORT_DEFAULT="$(sed -n 's/^PORT=//p' .env | tail -1)"; API_PORT_DEFAULT="${API_PORT_DEFAULT:-3000}"
if [[ "${PAYMOB_SANDBOX:-}" == 1 ]] && ! grep -q '^PAYMOB_SECRET_KEY=' .env; then
  step "Pointing online payments at the local Paymob sandbox"
  cat >> .env <<SANDBOX

# Online payments through the local Paymob sandbox (npm run paymob:sandbox). Replace with real keys to use Paymob.
API_PUBLIC_URL=http://127.0.0.1:$API_PORT_DEFAULT
PAYMOB_API_URL=http://127.0.0.1:4010
PAYMOB_CHECKOUT_URL=http://127.0.0.1:4010/checkout
PAYMOB_SECRET_KEY=sandbox-secret-key
PAYMOB_PUBLIC_KEY=sandbox-public-key
PAYMOB_HMAC_SECRET=sandbox-hmac-secret
PAYMOB_INTEGRATION_IDS=1
SANDBOX
fi
# Stand-shop customers return here from online payments; older .env files get it too.
if ! grep -q '^WEBSITE_URL=' .env; then
  printf '\n# The website (stand-shop orders return here from Paymob).\nWEBSITE_URL=http://127.0.0.1:%s\n' "$WEB_PORT" >> .env
fi
API_PORT="$(sed -n 's/^PORT=//p' .env | tail -1)"
API_PORT="${API_PORT:-3000}"

# The process listening on a port, if any (ss on Linux, lsof on macOS).
port_holder() {
  if command -v ss >/dev/null; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -q . || return 1
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 | grep . || return 1
  fi
}
for port in "$API_PORT" "$WEB_PORT" "$DASHBOARD_PORT"; do
  if holder="$(port_holder "$port")"; then
    detail=""
    [[ -n "$holder" ]] && detail=" by: $(ps -o args= -p "$holder" | cut -c1-120)"
    fail "Port $port is already in use$detail. Stop it, or choose another port (WEB_PORT=... or PORT in .env)."
  fi
done

# --- Dependencies -----------------------------------------------------------
if [[ "$NPM_PREFIX" == "$ROOT" ]]; then
  if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
    step "Installing dependencies"
    npm install
  fi
else
  # When nested in a larger workspace, npm can resolve these packages from the
  # parent checkout. Link this app's own copies to keep its types and schema in sync.
  [[ -d "$NPM_PREFIX/node_modules" ]] || fail "Dependencies are missing from the enclosing workspace at $NPM_PREFIX."
  mkdir -p node_modules/@bilhanah
  ln -sfn "$NPM_BIN" node_modules/.bin
  for package in config contracts database; do
    ln -sfn "$ROOT/packages/$package" "node_modules/@bilhanah/$package"
  done
fi
if [[ ! -f packages/contracts/dist/index.js || ! -f packages/database/dist/index.js ]]; then
  step "Building shared packages"
  if [[ "$NPM_PREFIX" == "$ROOT" ]]; then
    npm run build:packages
  else
    "$NPM_BIN/tsc" -p packages/contracts/tsconfig.json
    (cd packages/database && "$NPM_BIN/prisma" generate --config prisma.config.ts && "$NPM_BIN/tsc" -p tsconfig.json)
  fi
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

# The dashboard is nested in the backend's enclosing npm workspace, so npm
# resolves @bilhanah/contracts to the root package (an older, partial copy).
# Link its repository-local contracts before typechecking or serving it.
if [[ -f "$DASHBOARD_DIR/packages/contracts/tsconfig.json" ]]; then
  mkdir -p "$DASHBOARD_DIR/node_modules/@bilhanah"
  ln -sfn ../../packages/contracts "$DASHBOARD_DIR/node_modules/@bilhanah/contracts"
  ln -sfn "$ROOT/packages/config" "$DASHBOARD_DIR/node_modules/@bilhanah/config"
  "$NPM_BIN/tsc" -p "$DASHBOARD_DIR/packages/contracts/tsconfig.json"
fi

# --- Services and database --------------------------------------------------
step "Starting PostgreSQL, Redis and Mailpit"
docker compose -f "$ROOT/infra/compose.dev.yml" up -d --wait
step "Applying database migrations"
(cd packages/database && "$NPM_BIN/prisma" migrate deploy --config prisma.config.ts >/dev/null)

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
# node) stops together: setsid on Linux, job control where it is missing (macOS).
# Output is prefixed with the app's name.
command -v setsid >/dev/null || set -m
start() {
  local name="$1" color="$2" command="$3"
  # A shell loop, not sed or awk: those buffer piped input on some systems.
  local run=(bash -c "$command 2>&1 | while IFS= read -r line || [[ -n \$line ]]; do printf '%s\n' \"$color[$name]$reset \$line\"; done")
  if command -v setsid >/dev/null; then setsid "${run[@]}" & else "${run[@]}" & fi
  pids+=("$!")
}

step "Starting the API and worker${frontends:+, website and dashboard}"
start api "$green" "npm run --silent start:dev"
start worker "$magenta" "npm run --silent start:worker:dev"
if grep -q '^PAYMOB_API_URL=http://127.0.0.1:4010' .env; then
  start paymob "$blue" "node scripts/paymob-sandbox.mjs"
fi
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
  Database           PostgreSQL at 127.0.0.1:55432  (npm run db:studio)

Press Ctrl+C to stop.

EOF
else
  printf '%sThe API did not become ready; see the [api] output above.%s\n' "$yellow" "$reset"
fi

# Stop everything as soon as any app exits. Bash 3.2 (the macOS system Bash)
# does not support `wait -n`, so poll the process groups and reap the first one
# that exits.
while :; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || true
      printf '%sAn app exited; stopping the rest.%s\n' "$yellow" "$reset"
      exit 1
    fi
  done
  sleep 1
done
