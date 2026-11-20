// src/tracker.js — who follows whom, and what Steam says about them right now.
//
// Storage is one JSON file on a mounted volume: the bot has no database, and state kept in memory would
// vanish on every redeploy. Writes are serialised through a promise chain and land as tmp + rename, so a
// crash mid-write can never leave a half file behind.
//
// Presence comes from ISteamUser/GetPlayerSummaries: one request per 100 ids, no browser involved.
const fs = require('fs').promises;
const path = require('path');

const API_BASE = 'https://api.steampowered.com';
const POLL_MS = Number(process.env.TRACKER_POLL_MS || 60000);
const MAX_PER_USER = Number(process.env.TRACKER_MAX_PER_USER || 10);
const MAX_TOTAL = Number(process.env.TRACKER_MAX_TOTAL || 500);
const DATA_DIR = process.env.TRACKER_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracker.json');

const STATE_OFFLINE = 'offline';
const STATE_ONLINE = 'online';
const STATE_INGAME = 'ingame';

let db = { users: {}, state: {} };
let writeChain = Promise.resolve();
let timer = null;
let polling = false;

function apiKey() {
  return String(process.env.STEAM_WEB_API_KEY || '').trim();
}

function emptyDb() {
  return { users: {}, state: {} };
}

async function load() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    db = {
      users: parsed && typeof parsed.users === 'object' && parsed.users ? parsed.users : {},
      state: parsed && typeof parsed.state === 'object' && parsed.state ? parsed.state : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // A corrupt file is kept next to the fresh one; losing followers silently would be worse.
      await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
      await fs.rename(DATA_FILE, `${DATA_FILE}.broken-${Date.now()}`).catch(() => {});
      console.warn(`tracker: state file unreadable (${error.message}), started empty`);
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
      console.warn(`tracker: save failed (${error.message})`);
    });

  return writeChain;
}

function userBucket(userId) {
  const key = String(userId);

  if (!db.users[key]) {
    db.users[key] = { notify: true, profiles: {} };
  }

  db.users[key].profiles ||= {};

  return db.users[key];
}

function totalProfiles() {
  return Object.values(db.users).reduce((sum, user) => sum + Object.keys(user.profiles || {}).length, 0);
}

function subscribersOf(steamId) {
  const out = [];

  for (const [userId, user] of Object.entries(db.users)) {
    if (user.profiles && user.profiles[steamId]) {
      out.push({ userId, notify: user.notify !== false });
    }
  }

  return out;
}

// Steam's personastate: 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade,
// 6 looking to play. Only three buckets matter here, and a game always wins over the rest.
function normalizeStatus(player) {
  const state = Number(player.personastate || 0);
  const game = String(player.gameextrainfo || '').trim();

  if (state === 0) {
    return { status: STATE_OFFLINE, game: '', name: String(player.personaname || ''), avatar: String(player.avatarfull || player.avatarmedium || '') };
  }

  if (game !== '') {
    return { status: STATE_INGAME, game, name: String(player.personaname || ''), avatar: String(player.avatarfull || player.avatarmedium || '') };
  }

  return { status: STATE_ONLINE, game: '', name: String(player.personaname || ''), avatar: String(player.avatarfull || player.avatarmedium || '') };
}

async function steamJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (!response.ok) {
    throw new Error(`Steam API HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchSummaries(steamIds) {
  if (steamIds.length === 0) {
    return [];
  }

  const url =
    `${API_BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey())}` +
    `&steamids=${steamIds.join(',')}`;
  const payload = await steamJson(url);

  return payload?.response?.players || [];
}

async function resolveVanity(vanity) {
  const url =
    `${API_BASE}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey())}` +
    `&vanityurl=${encodeURIComponent(vanity)}`;
  const payload = await steamJson(url);

  return payload?.response?.success === 1 ? String(payload.response.steamid || '') : '';
}

// A link, a bare vanity, or a SteamID64 — all three arrive in the same message.
async function resolveProfileInput(input) {
  const value = String(input || '').trim();

  if (/^7656119[0-9]{10}$/.test(value)) {
    return value;
  }

  const byLink = value.match(/steamcommunity\.com\/profiles\/(7656119[0-9]{10})/i);

  if (byLink) {
    return byLink[1];
  }

  const byVanityLink = value.match(/steamcommunity\.com\/id\/([A-Za-z0-9_.-]{2,32})/i);
  const vanity = byVanityLink ? byVanityLink[1] : value;

  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(vanity)) {
    return '';
  }

  return resolveVanity(vanity);
}

async function freshStatus(steamId) {
  const players = await fetchSummaries([steamId]);

  if (players.length === 0) {
    return null;
  }

  const status = normalizeStatus(players[0]);

  return { steamId, ...status };
}

async function addProfile(userId, steamId, status) {
  const user = userBucket(userId);

  if (user.profiles[steamId]) {
    return { ok: false, reason: 'exists' };
  }

  if (Object.keys(user.profiles).length >= MAX_PER_USER) {
    return { ok: false, reason: 'limit_user' };
  }

  if (totalProfiles() >= MAX_TOTAL) {
    return { ok: false, reason: 'limit_total' };
  }

  user.profiles[steamId] = {
    added: Math.floor(Date.now() / 1000),
    name: status.name,
    avatar: status.avatar
  };
  db.state[steamId] = { status: status.status, game: status.game, checked: Math.floor(Date.now() / 1000) };

  await save();

  return { ok: true };
}

async function removeProfile(userId, steamId) {
  const user = db.users[String(userId)];

  if (!user || !user.profiles || !user.profiles[steamId]) {
    return false;
  }

  delete user.profiles[steamId];

  if (subscribersOf(steamId).length === 0) {
    delete db.state[steamId];
  }

  await save();

  return true;
}

function listProfiles(userId) {
  const user = db.users[String(userId)];

  if (!user || !user.profiles) {
    return [];
  }

  return Object.entries(user.profiles).map(([steamId, meta]) => ({
    steamId,
    name: meta.name || steamId,
    avatar: meta.avatar || '',
    added: Number(meta.added || 0),
    ...(db.state[steamId] || { status: STATE_ONLINE, game: '' })
  }));
}

function notifyEnabled(userId) {
  const user = db.users[String(userId)];

  return !user || user.notify !== false;
}

async function setNotify(userId, value) {
  const user = userBucket(userId);
  user.notify = Boolean(value);

  await save();

  return user.notify;
}

// One pass: ask Steam about everybody once, diff against what is stored, hand the changes over.
async function pollOnce() {
  const ids = Object.keys(db.state);

  if (ids.length === 0) {
    return [];
  }

  const players = await fetchSummaries(ids.slice(0, 100));
  const seen = new Set();
  const changes = [];

  for (const player of players) {
    const steamId = String(player.steamid || '');

    if (!steamId) {
      continue;
    }

    seen.add(steamId);

    const next = normalizeStatus(player);
    const previous = db.state[steamId] || null;

    if (previous && previous.status === next.status && previous.game === next.game) {
      db.state[steamId] = { ...previous, checked: Math.floor(Date.now() / 1000), name: next.name };
      continue;
    }

    db.state[steamId] = {
      status: next.status,
      game: next.game,
      checked: Math.floor(Date.now() / 1000),
      name: next.name
    };

    // The first observation is a baseline, not news: a profile added a minute ago would otherwise
    // announce "went online" the moment it is first polled.
    if (previous) {
      changes.push({ steamId, from: previous, to: next });
    }
  }

  // Ids Steam did not answer for keep their previous state; they are retried next cycle.
  for (const id of ids) {
    if (!seen.has(id) && db.state[id]) {
      db.state[id].checked = Math.floor(Date.now() / 1000);
    }
  }

  if (changes.length > 0) {
    await save();
  }

  return changes;
}

function start(onChanges) {
  if (!apiKey()) {
    console.warn('tracker: STEAM_WEB_API_KEY is not set, presence is not tracked');
    return false;
  }

  if (timer) {
    return true;
  }

  const tick = async () => {
    if (polling) {
      return;
    }

    polling = true;

    try {
      const changes = await pollOnce();

      if (changes.length > 0 && typeof onChanges === 'function') {
        await onChanges(changes).catch((error) => {
          console.warn(`tracker: notification failed (${error.message})`);
        });
      }
    } catch (error) {
      console.warn(`tracker: poll failed (${error.message})`);
    } finally {
      polling = false;
    }
  };

  timer = setInterval(tick, POLL_MS);
  tick();

  return true;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  STATE_OFFLINE,
  STATE_ONLINE,
  STATE_INGAME,
  POLL_MS,
  MAX_PER_USER,
  load,
  addProfile,
  removeProfile,
  listProfiles,
  notifyEnabled,
  setNotify,
  subscribersOf,
  resolveProfileInput,
  freshStatus,
  pollOnce,
  start,
  stop
};
