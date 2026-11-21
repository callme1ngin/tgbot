// src/ui.js — the look of the keyboards, kept out of the handlers.
//
// data/ui.json maps a callback_data to a look:
//   "template_friend": { "icon": "5368324170671202286", "style": "primary" }
//
// `icon` becomes icon_custom_emoji_id (Bot API 9.4, animated custom emoji, needs Telegram Premium on
// the bot's owner), `style` becomes the button colour. A key may be an exact callback_data or a prefix
// ending with `*`, so dynamic ones like tracker_remove_<id> are covered too.
//
// The file is read once and re-read when its mtime changes: edit ui.json on the server, send any
// command, and the next menu comes out with the new look — no restart and no code change.
const fs = require('fs');
const path = require('path');

const UI_FILE = process.env.UI_FILE || path.join(__dirname, '..', 'data', 'ui.json');

// Вид кнопок по callback_data. Если у кнопки есть иконка, ведущий юникод-эмодзи из подписи убирается:
// иначе рядом с кастомной иконкой стоял бы второй, обычный эмодзи. Подпись без эмодзи остаётся как есть.
const LEADING_EMOJI = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]+[\s\u00A0]*/u;

let cache = { mtime: 0, buttons: {}, fallback: {} };

function readFile() {
  try {
    const stat = fs.statSync(UI_FILE);

    if (stat.mtimeMs === cache.mtime) {
      return cache;
    }

    const raw = JSON.parse(fs.readFileSync(UI_FILE, 'utf8'));

    cache = {
      mtime: stat.mtimeMs,
      buttons: raw && typeof raw.buttons === 'object' && raw.buttons ? raw.buttons : {},
      fallback: raw && typeof raw.fallback === 'object' && raw.fallback ? raw.fallback : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`ui: ${path.basename(UI_FILE)} is unreadable (${error.message}), using plain buttons`);
    }

    cache = { mtime: 0, buttons: {}, fallback: {} };
  }

  return cache;
}

function look(callbackData, text) {
  const { buttons, fallback } = readFile();
  const key = String(callbackData || '');

  if (buttons[key]) {
    return buttons[key];
  }

  const prefix = Object.keys(buttons)
    .filter((candidate) => candidate.endsWith('*'))
    .find((candidate) => key.startsWith(candidate.slice(0, -1)));

  if (prefix) {
    return buttons[prefix];
  }

  if (fallback[text]) {
    return fallback[text];
  }

  return null;
}

// Mutates a copy of the markup: the same keyboard object is reused by callers, and a stale icon on it
// would leak into the next screen.
function decorateInline(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) {
    return markup;
  }

  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) =>
      (Array.isArray(row) ? row : [row]).map((button) => {
        if (!button || typeof button !== 'object') {
          return button;
        }

        const found = look(button.callback_data, button.text);

        if (!found) {
          return button;
        }

        const next = { ...button };

        if (found.icon) {
          next.icon_custom_emoji_id = String(found.icon);

          const withoutEmoji = String(button.text || '').replace(LEADING_EMOJI, '');

          if (withoutEmoji) {
            next.text = withoutEmoji;
          }
        }

        if (found.style) {
          next.style = String(found.style);
        }

        return next;
      })
    )
  };
}

function decorateReply(markup) {
  return markup;
}

module.exports = {
  UI_FILE,
  decorateInline,
  decorateReply
};
