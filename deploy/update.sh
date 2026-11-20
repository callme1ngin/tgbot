#!/usr/bin/env bash
# Server-side update for a machine that already runs this bot from a git checkout.
#
#   bash deploy/update.sh              # pull dev and restart the bot
#   BRANCH=main bash deploy/update.sh  # same, from another branch
#
# The runtime decides what "install" means here:
#   docker   — the image builds itself (Dockerfile runs npm ci), the host needs no Node at all;
#   pm2      — Node lives on the host, so npm ci + templates + playwright run here;
#   systemd  — same as pm2, unit tg-html-bot.service.
#
# .env, logs/ and .cache/ are untracked and stay where they are. The script refuses to run on a dirty
# tree: a server is not a place to resolve conflicts, and a half-merged bot is worse than an old one.
set -euo pipefail

BRANCH="${BRANCH:-dev}"
REMOTE="${REMOTE:-origin}"
PORT="${PORT:-3000}"
WITH_DEPS="${WITH_DEPS:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT is not a git checkout — run deploy/adopt.sh once"

if [ -n "$(git status --porcelain)" ]; then
    git status --short >&2
    die "working tree is dirty; commit, stash or revert before updating"
fi

say "fetch $REMOTE"
git fetch --prune "$REMOTE"

say "checkout $BRANCH"
git checkout -f -B "$BRANCH" "$REMOTE/$BRANCH"
git --no-pager log --oneline -1

# One helper for both compose generations, so the checks below stay readable.
compose() {
    if docker compose version >/dev/null 2>&1; then
        docker compose "$@"
    else
        docker-compose "$@"
    fi
}

RUNNER="node"

if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1 \
    && compose ps -aq 2>/dev/null | grep -q .; then
    RUNNER="docker"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe tg-html-bot >/dev/null 2>&1; then
    RUNNER="pm2"
elif command -v systemctl >/dev/null 2>&1 \
    && systemctl list-unit-files 'tg-html-bot.service' 2>/dev/null | grep -q '^tg-html-bot\.service'; then
    RUNNER="systemd"
fi

say "runtime: $RUNNER"

if [ "$RUNNER" = "docker" ]; then
    # The image carries Node, Playwright and the browsers; nothing is installed on the host.
    say "build and restart"
    compose up -d --build

    say "health"
    cid="$(compose ps -q | head -n 1)"
    [ -n "$cid" ] || cid="$(compose ps -aq | head -n 1)"
    [ -n "$cid" ] || die "compose did not report a container"

    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while :; do
        state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
        case "$state" in
            healthy) echo "healthy"; exit 0 ;;
            unhealthy) docker logs --tail 40 "$cid" >&2 || true; die "container is unhealthy" ;;
        esac
        [ "$(date +%s)" -lt "$deadline" ] || { docker logs --tail 40 "$cid" >&2 || true; die "container not healthy after ${HEALTH_TIMEOUT}s (state: $state)"; }
        sleep 3
    done
fi

say "dependencies"
command -v npm >/dev/null 2>&1 || die "npm is missing on the host — if the bot runs in docker, start the compose project first so this script can detect it"
npm ci --omit=dev

say "templates"
npm run bundle:friendpage

say "playwright chromium"
if [ "$WITH_DEPS" = "1" ]; then
    npx playwright install --with-deps chromium
else
    npx playwright install chromium
fi

say "restart"
if [ "$RUNNER" = "pm2" ]; then
    pm2 restart tg-html-bot --update-env
    pm2 save >/dev/null
    echo "restarted: pm2 tg-html-bot"
elif [ "$RUNNER" = "systemd" ]; then
    systemctl restart tg-html-bot
    echo "restarted: systemd tg-html-bot.service"
else
    echo "no docker, pm2 or systemd unit found — start the bot yourself (npm start)" >&2
    exit 4
fi

say "health :$PORT/health"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
    if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        echo "healthy"
        exit 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || die "health check did not answer in ${HEALTH_TIMEOUT}s"
    sleep 2
done
