#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCREEN_SESSION="tattyhost"
cd "$PROJECT_DIR"

if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required to build Tattyhost." >&2
    exit 127
fi

if [[ ! -x "$PROJECT_DIR/node_modules/.bin/vite" || ! -x "$PROJECT_DIR/node_modules/.bin/tsc" || ! -x "$PROJECT_DIR/node_modules/.bin/tsx" ]]; then
    echo "Error: dependencies are missing. Run 'npm ci --include=dev' first." >&2
    exit 1
fi

if ! command -v screen >/dev/null 2>&1; then
    echo "Error: GNU Screen is required to start Tattyhost." >&2
    exit 127
fi

ensure_no_existing_session() {
    if screen -ls 2>/dev/null | grep -Eq "[[:space:]][0-9]+[.]${SCREEN_SESSION}([[:space:]]|$)"; then
        echo "Error: Screen session '${SCREEN_SESSION}' already exists. Attach with 'screen -r ${SCREEN_SESSION}'." >&2
        exit 1
    fi
}

ensure_no_existing_session

export NODE_ENV=production

echo "Building Tattyhost for production..."
npm run build

ensure_no_existing_session

echo "Starting Tattyhost in screen session '${SCREEN_SESSION}'..."
screen -dmS "$SCREEN_SESSION" \
    "$PROJECT_DIR/node_modules/.bin/tsx" \
    --tsconfig "$PROJECT_DIR/tsconfig.json" \
    "$PROJECT_DIR/server.ts"
echo "Started. Attach with 'screen -r ${SCREEN_SESSION}' and detach with Ctrl+A, then D."
