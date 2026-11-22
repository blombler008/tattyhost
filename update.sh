#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCREEN_SESSION="tattyhost"
cd "$PROJECT_DIR"

if ! command -v git >/dev/null 2>&1; then
    echo "Error: Git is required to update Tattyhost." >&2
    exit 127
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required to install dependencies and build Tattyhost." >&2
    exit 127
fi

if ! command -v screen >/dev/null 2>&1; then
    echo "Error: GNU Screen is required to restart Tattyhost." >&2
    exit 127
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: this directory is not a Git working tree." >&2
    exit 1
fi

if git ls-files --error-unmatch -- .env >/dev/null 2>&1; then
    echo "Error: .env is tracked by Git. Untrack it before updating to protect its contents." >&2
    exit 1
fi

if [[ -e "$PROJECT_DIR/.env" ]] && ! git check-ignore -q -- .env; then
    echo "Error: .env exists but is not ignored by Git. Add it to .gitignore before updating." >&2
    exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Error: tracked local changes found. Commit or stash them before updating." >&2
    exit 1
fi

UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" || {
    echo "Error: the current branch has no upstream. Configure its Git remote before updating." >&2
    exit 1
}

echo "Fetching updates from Git..."
git fetch

if git ls-tree -r --name-only "$UPSTREAM_REF" -- .env | grep -Fxq '.env'; then
    echo "Error: the upstream contains a tracked .env file. Refusing to update." >&2
    exit 1
fi

echo "Fast-forwarding to $UPSTREAM_REF..."
git merge --ff-only "$UPSTREAM_REF"

echo "Installing dependencies..."
npm ci --include=dev

export NODE_ENV=production
echo "Building Tattyhost for production..."
npm run build

screen_session_exists() {
    screen -ls 2>/dev/null | grep -Eq "[[:space:]][0-9]+[.]${SCREEN_SESSION}([[:space:]]|$)"
}

if screen_session_exists; then
    echo "Stopping current Screen session '${SCREEN_SESSION}'..."
    screen -S "$SCREEN_SESSION" -X quit

    for attempt in {1..10}; do
        if ! screen_session_exists; then
            break
        fi
        sleep 1
    done

    if screen_session_exists; then
        echo "Error: Screen session '${SCREEN_SESSION}' did not stop." >&2
        exit 1
    fi
fi

echo "Starting Tattyhost in screen session '${SCREEN_SESSION}'..."
screen -dmS "$SCREEN_SESSION" \
    "$PROJECT_DIR/node_modules/.bin/tsx" \
    --tsconfig "$PROJECT_DIR/tsconfig.json" \
    "$PROJECT_DIR/server.ts"

sleep 1
if ! screen_session_exists; then
    echo "Error: the server exited during startup. Check the application logs." >&2
    exit 1
fi

echo "Update complete. Attach with 'screen -r ${SCREEN_SESSION}'."
