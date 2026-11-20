#!/usr/bin/env bash
# Server-side update for a machine that already runs this bot from a git checkout.
#
#   bash deploy/update.sh              # pull dev, install, rebuild templates, restart
#   BRANCH=main bash deploy/update.sh  # same, from another branch
#
# The script never touches .env, logs/ or .cache/ — they are not tracked and stay where they are.
# It refuses to run on a dirty tree: a server is not a place to resolve conflicts, and a half-merged
# bot is worse than an old one.
set -euo pipefail

BRANCH="${BRANCH:-dev}"
REMOTE="${REMOTE:-origin}"
PORT="${PORT:-3000}"
WITH_DEPS="${WITH_DEPS:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-40}"

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

say "dependencies"
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
if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1 \
    && docker compose ps -q 2>/dev/null | grep -q .; then
    docker compose up -d --build
    echo "restarted: docker compose"
elif command -v docker-compose >/dev/null 2>&1 && docker-compose ps -q 2>/dev/null | grep -q .; then
    docker-compose up -d --build
    echo "restarted: docker-compose"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe tg-html-bot >/dev/null 2>&1; then
    pm2 restart tg-html-bot --update-env
    pm2 save >/dev/null
    echo "restarted: pm2 tg-html-bot"
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 'tg-html-bot.service' 2>/dev/null | grep -q '^tg-html-bot\.service'; then
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
