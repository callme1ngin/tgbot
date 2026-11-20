#!/usr/bin/env bash
# One-time: turn the existing bot directory on the server into a git checkout, without losing it.
#
#   cd /root/tgbot && bash deploy/adopt.sh
#
# What it does: backs the directory up, points an origin at the repo, force-checks out the branch over
# the old files, then runs the normal update. .env, logs/ and .cache/ are untracked, so they survive.
set -euo pipefail

BRANCH="${BRANCH:-dev}"
REMOTE_URL="${REMOTE_URL:-https://github.com/callme1ngin/tgbot.git}"
REMOTE="${REMOTE:-origin}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f package.json ] || die "no package.json in $ROOT — run this from the bot directory"

if [ -d .git ]; then
    say "already a checkout"
    git remote -v
    die "nothing to adopt — use deploy/update.sh"
fi

STAMP="$(date +%F-%H%M)"
BACKUP="../tgbot-backup-${STAMP}.tar.gz"

say "backup $BACKUP"
tar czf "$BACKUP" \
    --exclude=./node_modules --exclude=./.cache --exclude=./logs \
    . 2>/dev/null || true
ls -lh "$BACKUP"

say "git init"
git init -q
git config core.fileMode false
git remote add "$REMOTE" "$REMOTE_URL"
git fetch --prune "$REMOTE"

say "checkout $BRANCH"
git checkout -f -B "$BRANCH" "$REMOTE/$BRANCH"
git --no-pager log --oneline -1

say "update"
bash deploy/update.sh
