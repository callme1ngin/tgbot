#!/usr/bin/env bash
# One-time: turn the existing bot directory on the server into a git checkout, without losing it.
#
#   git clone -b dev https://github.com/callme1ngin/tgbot.git /root/tgbot-src
#   bash /root/tgbot-src/deploy/adopt.sh /root/tgbot
#
# The first argument is the directory that already runs the bot; without it the current directory is
# used. What happens: a tarball of that directory is written next to it, then git init + origin +
# forced checkout of the branch over the old files, then the normal update. .env, logs/ and .cache/
# are untracked, so the checkout leaves them alone.
set -euo pipefail

TARGET="${1:-$PWD}"
BRANCH="${BRANCH:-dev}"
REMOTE_URL="${REMOTE_URL:-https://github.com/callme1ngin/tgbot.git}"
REMOTE="${REMOTE:-origin}"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -d "$TARGET" ] || die "no such directory: $TARGET"
ROOT="$(cd "$TARGET" && pwd)"
cd "$ROOT"

[ -f package.json ] || die "no package.json in $ROOT — point this at the bot directory"
[ -f src/bot.js ] || die "no src/bot.js in $ROOT — point this at the bot directory"

if [ -d .git ]; then
    say "already a checkout"
    git remote -v
    die "nothing to adopt — use deploy/update.sh"
fi

PARENT="$(dirname "$ROOT")"
STAMP="$(date +%F-%H%M)"
BACKUP="$PARENT/tgbot-backup-${STAMP}.tar.gz"

say "backup $BACKUP"
tar czf "$BACKUP" -C "$ROOT" \
    --exclude=./node_modules --exclude=./.cache --exclude=./logs . 2>/dev/null || true
ls -lh "$BACKUP"

say "git init in $ROOT"
git init -q
git config core.fileMode false
git remote add "$REMOTE" "$REMOTE_URL" 2>/dev/null || git remote set-url "$REMOTE" "$REMOTE_URL"
git fetch --prune "$REMOTE"

say "checkout $BRANCH"
git checkout -f -B "$BRANCH" "$REMOTE/$BRANCH"
git --no-pager log --oneline -1

say "update"
bash deploy/update.sh
