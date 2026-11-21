// src/captcha.js — вход в бота только после простого примера.
//
// Одна карточка: пример, три кнопки, один ответ верный. Две ошибки — пауза на COOLDOWN_MS, счётчик
// ошибок сбрасывается, пример выдаётся заново. Пройденная проверка запоминается на диск: перезапуск
// контейнера и деплой не заставляют оператора решать заново.
//
// Состояние: data/captcha-state.json (том ./data:/app/data). Примеры живут только в памяти — после
// рестарта старые кнопки честно отвечают «кнопка устарела».
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = process.env.CAPTCHA_FILE || path.join(DATA_DIR, 'captcha-state.json');

const MAX_WRONG = Number(process.env.CAPTCHA_MAX_WRONG || 2);
const COOLDOWN_MS = Number(process.env.CAPTCHA_COOLDOWN_MS || 60000);
const BYPASS_IDS = new Set(
  String(process.env.CAPTCHA_BYPASS_IDS || '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter(Boolean)
);

const verified = new Map(); // userId -> когда прошёл
const wrong = new Map(); // userId -> сколько раз ошибся подряд
const cooldowns = new Map(); // userId -> до какого времени молчит
const challenges = new Map(); // userId -> { gen, a, op, b, options, answer }

let generation = 0;
let loaded = false;

function isBypassed(userId) {
  return BYPASS_IDS.has(Number(userId));
}

function isVerified(userId) {
  return isBypassed(userId) || verified.has(Number(userId));
}

function cooldownLeft(userId) {
  const until = cooldowns.get(Number(userId)) || 0;
  return Math.max(0, until - Date.now());
}

function attemptsLeft(userId) {
  return Math.max(0, MAX_WRONG - (wrong.get(Number(userId)) || 0));
}

// Два слагаемых до 20 — считается в голове за секунду, а варианты не угадываются по величине.
function makeChallenge() {
  const useSubtraction = Math.random() < 0.35;
  const a = 3 + Math.floor(Math.random() * 15);
  const b = 1 + Math.floor(Math.random() * (useSubtraction ? a - 1 : 12));
  const op = useSubtraction ? '−' : '+';
  const answer = useSubtraction ? a - b : a + b;

  const options = new Set([answer]);

  while (options.size < 3) {
    const delta = 1 + Math.floor(Math.random() * 4);
    const candidate = Math.random() < 0.5 ? answer - delta : answer + delta;

    if (candidate >= 0 && candidate !== answer) {
      options.add(candidate);
    }
  }

  const list = [...options];

  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }

  generation += 1;

  return { gen: generation, a, op, b, options: list, answer };
}

function challenge(userId) {
  const current = challenges.get(Number(userId));

  if (current) {
    return current;
  }

  const next = makeChallenge();
  challenges.set(Number(userId), next);
  return next;
}

function dropChallenge(userId) {
  challenges.delete(Number(userId));
}

// 'ok' | 'wrong' | 'stale'. На второй ошибке ставит паузу и обнуляет счётчик.
function submit(userId, gen, index) {
  const id = Number(userId);
  const current = challenges.get(id);

  if (!current || current.gen !== gen) {
    return { status: 'stale' };
  }

  const value = current.options[index];

  if (value === undefined) {
    return { status: 'stale' };
  }

  if (value === current.answer) {
    dropChallenge(id);
    return { status: 'ok' };
  }

  const count = (wrong.get(id) || 0) + 1;
  wrong.set(id, count);
  dropChallenge(id);

  if (count >= MAX_WRONG) {
    const until = Date.now() + COOLDOWN_MS;
    cooldowns.set(id, until);
    wrong.delete(id);
    flush();
    return { status: 'wrong', cooldown: until - Date.now(), attemptsLeft: 0 };
  }

  flush();
  return { status: 'wrong', cooldown: 0, attemptsLeft: MAX_WRONG - count };
}

function verify(userId) {
  const id = Number(userId);
  verified.set(id, Date.now());
  wrong.delete(id);
  cooldowns.delete(id);
  dropChallenge(id);
  flush();
}

function stats() {
  return {
    verified: verified.size,
    inCooldown: [...cooldowns.values()].filter((until) => until > Date.now()).length,
    maxWrong: MAX_WRONG,
    cooldownMs: COOLDOWN_MS
  };
}

/* ---------- persistence ---------- */

function load() {
  if (loaded) {
    return;
  }

  loaded = true;

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    for (const [id, at] of Object.entries(raw.verified || {})) {
      verified.set(Number(id), Number(at) || Date.now());
    }

    for (const [id, until] of Object.entries(raw.cooldowns || {})) {
      if (Number(until) > Date.now()) {
        cooldowns.set(Number(id), Number(until));
      }
    }

    for (const [id, count] of Object.entries(raw.wrong || {})) {
      wrong.set(Number(id), Number(count) || 0);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`captcha: cannot read ${path.basename(STATE_FILE)} (${error.message})`);
    }
  }
}

function snapshot() {
  return JSON.stringify({
    verified: Object.fromEntries(verified),
    cooldowns: Object.fromEntries([...cooldowns].filter(([, until]) => until > Date.now())),
    wrong: Object.fromEntries(wrong)
  });
}

// События редкие — прохождение и пауза, — поэтому пишем сразу: контейнер могут погасить в любую
// секунду, и отложенная запись потеряется вместе с пройденной проверкой.
let saving = false;
let pending = false;

async function flush() {
  if (saving) {
    pending = true;
    return;
  }

  saving = true;

  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fs.promises.writeFile(tmp, snapshot(), 'utf8');
    await fs.promises.rename(tmp, STATE_FILE);
  } catch (error) {
    console.warn(`captcha: cannot write ${path.basename(STATE_FILE)} (${error.message})`);
  } finally {
    saving = false;

    if (pending) {
      pending = false;
      await flush();
    }
  }
}

load();

module.exports = {
  MAX_WRONG,
  COOLDOWN_MS,
  isBypassed,
  isVerified,
  cooldownLeft,
  attemptsLeft,
  challenge,
  submit,
  verify,
  flush,
  stats,
  STATE_FILE
};
