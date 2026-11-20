# Friend page: шапка

Экран «Страница друга» собирается из `template-sources/friendpage/` в
`templates/friendpage.bundle.html` скриптом `npm run bundle:friendpage`.

Важно: `scripts/` и `template-sources/` исключены в `.dockerignore`, поэтому сборщик бандла в образ не
попадает и в `Dockerfile` шага сборки нет — образ берёт **закоммиченный** `templates/friendpage.bundle.html`.
После правок в `template-sources` бандл надо пересобрать и закоммитить вместе с ними:

```bash
npm run bundle:friendpage
git add template-sources templates/friendpage.bundle.html
```

## Что добавлено

Сохранённая страница была в «мобильной» разметке Steam: узкая полоса с гамбургером и логотипом, без
верхнего меню и без правого блока. Сверху вставлена настоящая шапка Steam — та же, что на `/auth`
из панели (`ch/v2/eu/auth/view.html`), с нашими правками колокола.

Итог: логотип, `STORE / COMMUNITY / <ник> / CHAT / SUPPORT`, справа серая кнопка `Install Steam`,
плашка с колоколом, ник со стрелкой и аватар 32×32.

## Как вставлено

Блок `<div role="banner" id="global_header">…</div>` вырезан из `view.html` целиком и вставлен в
`friendpage.html` сразу после `<div class="responsive_page_content">`. Стили колокола и плашки
(`#green_envelope_menu_root`, `.header_notification_link`) добавлены в `<head>` перед `</head>`.

Плейсхолдеры панели заменены на плейсхолдеры бота:

| было (страница `/auth`) | стало (страница друга) |
|---|---|
| `{{NICK}}` | `{{PROFILE_NAME}}` |
| `{{AVATAR}}` | `{{AVATAR_URL}}` |
| `{{ACCOUNT}}` | `{{PROFILE_NAME}}` |
| `https://steamcommunity.com/profiles/{{PROFILE_ID}}/` | `{{PROFILE_URL}}` |

Логотип шапки ссылался на `/auth/cdn/…svg` — путь есть только на панели. Файл скопирован в
`template-sources/friendpage/friendpage_files/logo_steam.svg`, ссылка стала относительной, бандлер
вшивает его как data URI вместе с остальными ассетами (21 штука).

## Проверка

Локальный рендер бандла с подставленными ником и аватаром: шапка на месте, меню и правый блок как на
образце, контент «Add a Friend» не съехал.

## Функционал

Не менялся: те же плейсхолдеры, тот же ввод кода друга, та же кнопка `COPY` и та же ссылка на Quick
Invite. Шапка — только разметка и стили.
