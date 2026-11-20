# Git: ветка, заливка, обновление на сервере

Репозиторий: `https://github.com/callme1ngin/tgbot`. Рабочая ветка — `dev`, `main` остаётся тем, что
было до нас.

## Схема

```
локально: правки → commit → push origin dev
сервер:   bash deploy/update.sh  →  pull dev → npm ci → шаблоны → restart → /health
```

Сервер ничего не редактирует. Всё, что живёт только на сервере — `.env`, `logs/`, `.cache/` — в
репозиторий не попадает (`.gitignore`) и обновлением не затрагивается.

## Первый раз на сервере

Старая версия лежит обычной папкой, без `.git`. Один запуск превращает её в чекаут, ничего не теряя:

```bash
cd /root/tgbot
bash deploy/adopt.sh
```

Скрипт сначала делает `../tgbot-backup-<дата>.tar.gz` (без `node_modules`, `logs`, `.cache`), потом
`git init` + `origin` + принудительный чекаут `dev` и сразу обычное обновление. Если что-то пошло не
так — распаковать бэкап обратно в папку.

`.env` не тронется: он untracked, чекаут его не перезаписывает.

Приватный репозиторий? Тогда `REMOTE_URL=git@github.com:callme1ngin/tgbot.git bash deploy/adopt.sh`
и ключ на сервере.

## Дальше — каждая выкатка

```bash
cd /root/tgbot
bash deploy/update.sh
```

Что делает по шагам:

1. отказывается работать, если в папке есть незакоммиченные правки (на сервере их быть не должно);
2. `git fetch --prune` и `git checkout -f -B dev origin/dev` — рабочая копия становится ровно тем, что
   в ветке;
3. `npm ci --omit=dev`;
4. `npm run bundle:friendpage` — пересобирает `templates/friendpage.bundle.html` из `template-sources`;
5. `npx playwright install chromium` (с `WITH_DEPS=1` — ещё и системные пакеты, нужен root);
6. перезапуск тем, чем бот реально запущен: docker compose → docker-compose → pm2 `tg-html-bot` →
   systemd `tg-html-bot.service`. Если ничего не найдено — код 4 и подсказка;
7. ждёт `http://127.0.0.1:3000/health` до 40 секунд, иначе падает с ненулевым кодом.

Переменные: `BRANCH`, `REMOTE`, `PORT`, `WITH_DEPS`, `HEALTH_TIMEOUT`.

## Локально

```bash
git switch dev          # рабочая ветка
git add -A
git commit -m "…"
git push origin dev
```

Первый `push` спросит логин и пароль GitHub — вместо пароля нужен **personal access token** с правом
`repo` (Settings → Developer settings → Personal access tokens). Сохранить его можно так, чтобы не
спрашивало каждый раз:

```bash
git config --global credential.helper store   # токен ляжет в ~/.git-credentials открытым текстом
```

## Откат

```bash
cd /root/tgbot
git log --oneline -10
git checkout -f -B dev <хороший-коммит>
bash deploy/update.sh
```

Или вернуть ветку назад и обновить остальных: `git push -f origin dev`.

## Полезное

```bash
git -C /root/tgbot log --oneline -5      # что сейчас на сервере
git -C /root/tgbot status --short        # не наследил ли кто-то правками
systemctl status tg-html-bot             # или: pm2 status / docker compose ps
curl -s localhost:3000/health
```
