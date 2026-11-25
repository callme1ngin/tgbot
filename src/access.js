// src/access.js — кто что может: роли, сроки подписки, промокоды.
//
// Хранилище — один JSON рядом с остальным состоянием: база не нужна, а пережить редеплой надо.
// Срок подписки проверяется лениво, при каждом обращении: таймер не нужен, истёкшая роль просто
// перестаёт считаться активной.
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.ACCESS_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'access.json');

const ROLE_NONE = 'none';
const ROLE_WORKER = 'worker';
const ROLE_CHATTER = 'chatter';
const ROLE_ADMIN = 'admin';

// Порядок ролей: всё, что выше по числу, включает всё, что ниже.
const LEVEL = {
  [ROLE_NONE]: 0,
  [ROLE_WORKER]: 1,
  [ROLE_CHATTER]: 2,
  [ROLE_ADMIN]: 3
};

const LABEL = {
  [ROLE_NONE]: 'Подписка не активна',
  [ROLE_WORKER]: 'Воркер',
  [ROLE_CHATTER]: 'Чаттер',
  [ROLE_ADMIN]: 'Админ'
};

const PROMO_LIMIT = Number(process.env.PROMO_MAX_USES || 1);
const CODE_MAX = Number(process.env.PROMO_CODE_MAX || 20);
const DAY = 86400;

let db = { users: {}, promos: {} };
let writeChain = Promise.resolve();

function now() {
  return Math.floor(Date.now() / 1000);
}

function emptyDb() {
  return { users: {}, promos: {} };
}

// Владелец бота перечисляется в ADMIN_IDS: это единственный способ выдать первую админку,
// когда промокодов ещё нет.
function adminIds() {
  return String(process.env.ADMIN_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    db = {
      users: parsed && typeof parsed.users === 'object' && parsed.users ? parsed.users : {},
      promos: parsed && typeof parsed.promos === 'object' && parsed.promos ? parsed.promos : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
      await fs.rename(DATA_FILE, `${DATA_FILE}.broken-${Date.now()}`).catch(() => {});
      console.warn(`access: state file unreadable (${error.message}), started empty`);
    }

    db = emptyDb();
  }

  return db;
}

function save() {
  const snapshot = JSON.stringify(db, null, 2);

  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, DATA_FILE);
    })
    .catch((error) => {
      console.warn(`access: save failed (${error.message})`);
    });

  return writeChain;
}

function level(role) {
  return LEVEL[role] || 0;
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

// Роль на сейчас: админ из окружения старше всего, дальше — запись с живым сроком.
function roleOf(userId) {
  const id = String(userId);

  if (adminIds().includes(id)) {
    return { role: ROLE_ADMIN, until: null, forever: true, source: 'env' };
  }

  const entry = db.users[id];

  if (!entry || !entry.role || entry.role === ROLE_NONE) {
    return { role: ROLE_NONE, until: null, forever: false, source: '' };
  }

  if (entry.until && Number(entry.until) <= now()) {
    return { role: ROLE_NONE, until: Number(entry.until), forever: false, expired: entry.role, source: 'expired' };
  }

  return {
    role: entry.role,
    until: entry.until ? Number(entry.until) : null,
    forever: !entry.until,
    source: entry.grantedBy ? `granted:${entry.grantedBy}` : 'granted'
  };
}

function atLeast(userId, role) {
  return level(roleOf(userId).role) >= level(role);
}

function canRenderVAC(userId) {
  return atLeast(userId, ROLE_CHATTER);
}

function isAdmin(userId) {
  return atLeast(userId, ROLE_ADMIN);
}

// days = 0 или null — бессрочно.
async function setRole(userId, role, days, grantedBy) {
  const id = String(userId);
  const until = days ? now() + Number(days) * DAY : null;

  db.users[id] = {
    role,
    until,
    grantedBy: String(grantedBy || ''),
    grantedAt: now()
  };

  await save();
  return db.users[id];
}

async function clearRole(userId) {
  const id = String(userId);

  if (!db.users[id]) {
    return false;
  }

  delete db.users[id];
  await save();
  return true;
}

async function createPromo({ code, role, days, createdBy, maxUses }) {
  const key = normalizeCode(code);

  if (!key) {
    return { ok: false, reason: 'empty' };
  }

  if (key.length > CODE_MAX) {
    return { ok: false, reason: 'too_long' };
  }

  // Только латиница, цифры и дефис: код набирают в чате руками, а он же уезжает в callback_data.
  if (!/^[A-Z0-9-]+$/.test(key)) {
    return { ok: false, reason: 'symbols' };
  }

  if (!LEVEL[role] || role === ROLE_NONE) {
    return { ok: false, reason: 'role' };
  }

  if (db.promos[key]) {
    return { ok: false, reason: 'exists' };
  }

  db.promos[key] = {
    role,
    days: days ? Number(days) : null,
    maxUses: Number(maxUses || PROMO_LIMIT),
    usedBy: [],
    createdBy: String(createdBy || ''),
    createdAt: now()
  };

  await save();
  return { ok: true, code: key, promo: db.promos[key] };
}

async function revokePromo(code) {
  const key = normalizeCode(code);

  if (!db.promos[key]) {
    return false;
  }

  delete db.promos[key];
  await save();
  return true;
}

function promoInfo(code) {
  const key = normalizeCode(code);
  const promo = db.promos[key];

  if (!promo) {
    return null;
  }

  return {
    code: key,
    role: promo.role,
    days: promo.days ? Number(promo.days) : null,
    maxUses: Number(promo.maxUses || PROMO_LIMIT),
    uses: (promo.usedBy || []).length,
    createdBy: promo.createdBy || '',
    createdAt: Number(promo.createdAt || 0)
  };
}

function listPromos() {
  return Object.keys(db.promos)
    .map((code) => promoInfo(code))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function redeemPromo(userId, rawCode) {
  const key = normalizeCode(rawCode);
  const promo = db.promos[key];
  const id = String(userId);

  if (!promo) {
    return { ok: false, reason: 'missing' };
  }

  promo.usedBy = Array.isArray(promo.usedBy) ? promo.usedBy : [];

  if (promo.usedBy.includes(id)) {
    return { ok: false, reason: 'used_by_you' };
  }

  if (promo.usedBy.length >= Number(promo.maxUses || PROMO_LIMIT)) {
    return { ok: false, reason: 'used_up' };
  }

  promo.usedBy.push(id);
  const entry = await setRole(id, promo.role, promo.days, `promo:${key}`);

  return {
    ok: true,
    code: key,
    role: promo.role,
    days: promo.days ? Number(promo.days) : null,
    until: entry.until
  };
}

function status() {
  const users = Object.values(db.users);
  const byRole = { worker: 0, chatter: 0, admin: 0 };

  for (const user of users) {
    if (byRole[user.role] !== undefined) {
      byRole[user.role] += 1;
    }
  }

  return { users: users.length, byRole, promos: Object.keys(db.promos).length };
}

module.exports = {
  ROLE_NONE,
  ROLE_WORKER,
  ROLE_CHATTER,
  ROLE_ADMIN,
  LABEL,
  CODE_MAX,
  load,
  save,
  level,
  roleOf,
  atLeast,
  isAdmin,
  canRenderVAC,
  setRole,
  clearRole,
  createPromo,
  revokePromo,
  promoInfo,
  listPromos,
  redeemPromo,
  normalizeCode,
  status
};
