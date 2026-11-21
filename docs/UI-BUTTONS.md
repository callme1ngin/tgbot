# Rich buttons

Все инлайн-кнопки бота проходят через один декоратор: он читает `data/ui.json` и добавляет к кнопке
`icon_custom_emoji_id` и `style`. Обработчики и клавиатуры про это не знают — правки вида делаются
в одном файле.

## ui.json

```json
{
  "buttons": {
    "cs2_menu": { "icon": "5206607081334906820", "style": "primary" },
    "tracker_remove_*": { "style": "danger" }
  },
  "fallback": { "Сменить шаблон": { "style": "" } }
}
```

- ключ — `callback_data` кнопки;
- ключ с `*` на конце — префикс, ловит динамические (`tracker_remove_<steamid>`);
- `fallback` — по тексту кнопки, для тех, у кого `callback_data` нет;
- `icon` — `custom_emoji_id` премиум-эмодзи (Bot API 9.4);
- `style` — `primary` | `success` | `danger`, пустая строка = без стиля.

## Полный список ключей

Разделы и навигация: `section_profile`, `section_codes`, `tracker_menu`, `root_menu`, `again`.

Профиль: `template_friend`, `qr_friend`, `template_add_error`, `template_error`, `template_steam_china`,
`friend_variant_pc`, `friend_variant_mobile`, `add_error_profile`, `add_error_friendlink`,
`add_error_phone`, `add_friend_code`.

Коды: `cs2_menu`, `dota_menu`, `cs2_fake_code`, `cs2_not_found`, `cs2_ban`, `cs2b_custom`,
`dota_fake_code`, `dota_not_found`, `dota_not_friends`. Время бана (`cs2b_30m` … `cs2b_7d`) стиля не
имеет специально: восемь красных кнопок — это шум, а не акцент.

Трекер: `tracker_add`, `tracker_list`, `tracker_notify`, `tracker_confirm`, `tracker_open_*`,
`tracker_refresh_*`, `tracker_remove_*`.

Файл перечитывается, когда меняется его mtime: правишь `ui.json` на сервере, отправляешь `/start` — и
следующее меню уже с новым видом. Перезапуск контейнера не нужен.

## Условия для иконок

`icon_custom_emoji_id` рисуется только если **владелец бота** (аккаунт из BotFather) с Telegram Premium.
Без подписки поле игнорируется, кнопки остаются обычными — ошибки нет.

Анимация эмодзи видна тем, у кого Premium; остальные видят статичную версию.

## Как получить ID

Переслать премиум-эмодзи боту и отправить `/emoji` — ответ придёт списком `custom_emoji_id`. Дальше
вставить в `ui.json` напротив нужного `callback_data`.

## Порядок применения

1. `icon` пустой → кнопка без иконки, только стиль.
2. Стиль `primary` у главных действий, `danger` у разрушительных, пусто у служебных.
3. Если `ui.json` битый или отсутствует — бот работает с обычными кнопками и пишет в лог одну строку.
