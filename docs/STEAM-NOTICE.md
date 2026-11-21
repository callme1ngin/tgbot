# Steam Fake Alert

Экран «Steam Fake Alert»: готовая подложка Steam с окном «You are leaving Steam», куда подставляется
френдлинк кита. Одна ссылка — два места: адресная строка браузера и текст уведомления.

## Откуда шаблон

`templates/steam_notice.html` — присланный `steam_notice_newphoto_template_v7.html`, без правок.
Внутри: фон 1917×1032 (base64 PNG), два текстовых слоя и маленький контракт на JS.

## Контракт шаблона

| слой | id | куда попадает |
|---|---|---|
| адресная строка | `#address-url` | ссылка, разбитая на `protocol` / `host` / `path` |
| уведомление | `#notice-url` | ссылка целиком |

```js
window.setUrl(url)                 // обе строки одной ссылкой — это и вызывается
window.setUrls({addressUrl, noticeUrl})
window.setAddressUrl(url)
window.setNoticeUrl(url)
window.__renderReady === true      // шаблон поднял флаг после раскладки
```

Размер: `#shot` 1917×1032, вьюпорт тот же, скриншот снимается с `#shot`.

Текст ставится через `textContent`, поэтому HTML внутри ссылки не выполнится — экранировать нечего,
но и пропускать в шаблон что-то кроме url нельзя.

## Поток в боте

```
🎭 Профиль → 🚨 Steam Fake Alert
        ↓
«Отправь френдлинк кита — встанет в адрес и в уведомление.»
        ↓ ссылка
https:// дописывается, если схемы нет   (s.team/p/x → https://s.team/p/x)
        ↓
parseHttpUrl — только синтаксис, страница не запрашивается
        ↓
⏳ Собираю изображение…  → sendResult
        ↓
фото + 🔁 Ещё раз · ← Назад · 🏠 Меню
```

DNS здесь не проверяется намеренно: ссылка не открывается ботом, а короткие домены бывают видны не с
каждой сети. Для экранов, которые бот реально читает, остаётся `assertPublicHttpUrl`.

## Кэш

`processSteamNoticeRequest(link)` использует общий `screenshotCache` с ключом по ссылке и
`SCREENSHOT_CACHE_VERSION`. Поменял шаблон — подними версию, иначе старые картинки продолжат отдаваться.

## Проверка рендера

```js
const ready = await page.evaluate((url) => { window.setUrl(url); return window.__renderReady === true; }, link);
// ready === true
// #address-url.textContent === link
// #notice-url.textContent  === link
```

Прогон на локальном Chromium: 1917×1032, PNG ≈ 60 КБ, обе строки совпали со ссылкой.
