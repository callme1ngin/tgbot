const { Telegraf } = require('telegraf');
const { parse } = require('node-html-parser');
const dns = require('dns').promises;
const fs = require('fs').promises;
const http = require('http');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config');
const tracker = require('./tracker');
const captcha = require('./captcha');
const ui = require('./ui');
const BrowserPool = require('./browser-pool');
const RequestQueue = require('./request-queue');
const ScreenshotCache = require('./screenshot-cache');

if (!config.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

const bot = new Telegraf(config.BOT_TOKEN);

// Проверка на входе. Стоит первой в цепочке, поэтому всё, что регистрируется ниже — команды, кнопки,
// текст — уже за ней: до правильного ответа бот не показывает ни одного экрана.
//
// Пока идёт пауза, любое действие получает только всплывающее уведомление: ни новых сообщений, ни
// новых карточек. Единственное, что правится, — сама карточка паузы, и то на месте.
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;

  if (!userId || captcha.isVerified(userId)) {
    return next();
  }

  const left = captcha.cooldownLeft(userId);
  const isCaptchaAnswer = String(ctx.callbackQuery?.data || '').startsWith('captcha_');

  if (isCaptchaAnswer && left === 0) {
    return next();
  }

  if (ctx.callbackQuery) {
    if (left > 0) {
      await ctx.answerCbQuery(cooldownText(left), { show_alert: true }).catch(() => {});
      return undefined;
    }

    await ctx.answerCbQuery().catch(() => {});
    return showCaptcha(ctx);
  }

  if (ctx.message) {
    await deleteIncomingMessage(ctx).catch(() => {});
  }

  if (left > 0) {
    return refreshCooldownCard(ctx, left);
  }

  return showCaptcha(ctx);
});

const DEFAULT_SCREENSHOT_VIEWPORT = {
  width: Number(process.env.SCREENSHOT_WIDTH || 1920),
  height: Number(process.env.SCREENSHOT_HEIGHT || 1080)
};
const FRIEND_SCREENSHOT_VIEWPORT = {
  width: Number(process.env.FRIEND_SCREENSHOT_WIDTH || 1280),
  height: Number(process.env.FRIEND_SCREENSHOT_HEIGHT || 720)
};

// The CS2 templates draw into a canvas of a fixed size and scale it to the viewport, so the viewport
// is set from the canvas itself right before the screenshot — one size per template, none hardcoded.
const CS2_CANVAS = 'canvas';

const browserPool = new BrowserPool({
  maxContexts: Number(process.env.BROWSER_CONTEXTS || 2),
  maxPagesPerContext: Number(process.env.PAGES_PER_CONTEXT || 3),
  viewport: DEFAULT_SCREENSHOT_VIEWPORT
});

const requestQueue = new RequestQueue({
  maxConcurrent: Number(process.env.MAX_CONCURRENT_REQUESTS || 4)
});

const screenshotCache = new ScreenshotCache({
  maxSize: Number(process.env.CACHE_SIZE || 100),
  ttl: Number(process.env.CACHE_TTL_MS || 60 * 60 * 1000)
});

const userState = new Map();
const templateCache = new Map();
const fragmentCache = new Map();

const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 3);
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 2);
const FETCH_RETRY_DELAY_MS = Number(process.env.FETCH_RETRY_DELAY_MS || 500);
const IMAGE_LOAD_TIMEOUT_MS = Number(process.env.IMAGE_LOAD_TIMEOUT_MS || 5000);
const IMAGE_RETRY_COUNT = Number(process.env.IMAGE_RETRY_COUNT || 1);
const SCREENSHOT_CACHE_VERSION = 'cs2-frame-v34';const HEALTH_PORT = Number(process.env.PORT || process.env.HEALTH_PORT || 3000);
const PROJECT_ROOT = path.join(__dirname, '..');
const FRIENDPAGE_EXAMPLE_PATH = path.join(PROJECT_ROOT, 'assets', 'friendpage_example.png');
const BROWSERERROR_EXAMPLE_PATH = path.join(PROJECT_ROOT, 'assets', 'BrowserError.png');
const SILENTLOGO_PATH = path.join(PROJECT_ROOT, 'assets', 'silentlogo.png');
// The Dota fake-code screen is a finished picture, not a template: it is sent as is.
const DOTA_FAKE_CODE_PATH = path.join(PROJECT_ROOT, 'assets', 'dota_fake_code.png');
const RUNTIME_CACHE_DIR = path.join(PROJECT_ROOT, '.cache');
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const INVITE_BANNER_MODAL_OFFSET_PX = Number(process.env.INVITE_BANNER_MODAL_OFFSET_PX || 114);
const ADD_FRIEND_ERROR_STYLE = `<style id="add_friend_error_bot_styles">.add_friend_error_modal{position:fixed;z-index:1000;outline:none;max-width:1071px;left:50%;top:calc(50% + var(--invite-banner-offset,0px));transform:translate(-50%,-50%);}</style>`;
const photoAssets = {
  friendpageExample: {
    path: FRIENDPAGE_EXAMPLE_PATH,
    filename: 'friendpage_example.png',
    fileIdPath: path.join(RUNTIME_CACHE_DIR, 'friendpage-example-file-id.txt'),
    buffer: null,
    fileId: null
  },
  browserErrorExample: {
    path: BROWSERERROR_EXAMPLE_PATH,
    filename: 'BrowserError.png',
    fileIdPath: path.join(RUNTIME_CACHE_DIR, 'browser-error-example-file-id.txt'),
    buffer: null,
    fileId: null
  },
  silentLogo: {
    path: SILENTLOGO_PATH,
    filename: 'silentlogo.png',
    fileIdPath: path.join(RUNTIME_CACHE_DIR, 'silentlogo-png-file-id.txt'),
    buffer: null,
    fileId: null
  }
};

// Шрифт для CS2-экранов. Шаблоны ждут Stratum2 — шрифт клиента Steam, в Linux его нет, поэтому в
// assets лежит Stratum2 Regular (тот же файл, что в chromotion). Заменить — положить другой файл и
// указать путь: CS2_FONT_PATH=/app/assets/stratum2.ttf.
const CS2_FONT_PATH = process.env.CS2_FONT_PATH || path.join(PROJECT_ROOT, 'assets', 'cs2_font.ttf');
let cs2FontDataUrl;

async function loadCs2Font() {
  if (cs2FontDataUrl !== undefined) {
    return cs2FontDataUrl;
  }

  try {
    const bytes = await fs.readFile(CS2_FONT_PATH);
    cs2FontDataUrl = `data:font/ttf;base64,${bytes.toString('base64')}`;
    console.log(`CS2 font: ${path.basename(CS2_FONT_PATH)} (${bytes.length} bytes)`);
  } catch (error) {
    cs2FontDataUrl = '';
    console.warn(`CS2 font is unavailable (${path.basename(CS2_FONT_PATH)}): ${error.message}`);
  }

  return cs2FontDataUrl;
}

async function loadTemplate(templateName) {
  const templatePath = await resolveTemplatePath(templateName);
  const cached = templateCache.get(templatePath);

  if (cached) {
    return cached;
  }

  const html = await fs.readFile(templatePath, 'utf8');
  const htmlWithBase = ensureBaseHref(html, templatePath);
  const template = {
    html: await inlineLocalImageSources(htmlWithBase, templatePath),
    path: templatePath
  };

  templateCache.set(templatePath, template);
  return template;
}

async function loadFragment(filename) {
  const fragmentPath = path.join(PROJECT_ROOT, 'templates', 'fragments', filename);
  const cached = fragmentCache.get(fragmentPath);

  if (cached) {
    return cached;
  }

  const html = await fs.readFile(fragmentPath, 'utf8');
  fragmentCache.set(fragmentPath, html);
  return html;
}

async function resolveTemplatePath(templateName) {
  const templateFileName = templateName === config.TEMPLATES.STEAM_CHINA
    ? config.TEMPLATES.FRIEND
    : templateName;
  const candidates = [
    path.join(PROJECT_ROOT, 'templates', `${templateFileName}.html`)
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next template location.
    }
  }

  throw new Error(`Template not found: ${templateName}`);
}

function ensureBaseHref(html, templatePath) {
  if (/<base\s/i.test(html)) {
    return html;
  }

  const baseHref = pathToFileURL(path.dirname(templatePath) + path.sep).href;
  return ensureBaseHrefValue(html, baseHref);
}

function ensureBaseHrefValue(html, baseHref) {
  if (/<base\s/i.test(html)) {
    return html;
  }

  if (/<head([^>]*)>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
  }

  return `<base href="${baseHref}">${html}`;
}

function getAssetMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.png') {
    return 'image/png';
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg';
  }

  if (ext === '.gif') {
    return 'image/gif';
  }

  if (ext === '.webp') {
    return 'image/webp';
  }

  if (ext === '.svg') {
    return 'image/svg+xml';
  }

  return 'application/octet-stream';
}

async function inlineLocalImageSources(html, templatePath) {
  const templateDir = path.dirname(templatePath);
  const replacements = new Map();
  const matches = html.matchAll(/\bsrc=(["'])(\.{1,2}\/[^"']+\.(?:png|jpe?g|gif|webp|svg))\1/gi);

  for (const match of matches) {
    const [source, quote, imageUrl] = match;

    if (replacements.has(source)) {
      continue;
    }

    const imagePath = path.resolve(templateDir, decodeURIComponent(imageUrl));

    if (!imagePath.startsWith(PROJECT_ROOT)) {
      continue;
    }

    try {
      const buffer = await fs.readFile(imagePath);
      const dataUri = `data:${getAssetMimeType(imagePath)};base64,${buffer.toString('base64')}`;
      replacements.set(source, `src=${quote}${dataUri}${quote}`);
    } catch {
      // Leave the original src in place if the local asset is missing.
    }
  }

  let result = html;

  for (const [source, replacement] of replacements) {
    result = replaceAll(result, source, replacement);
  }

  return result;
}

function isPrivateIp(address) {
  const ipVersion = net.isIP(address);

  if (ipVersion === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }

  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed');
  }

  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed');
  }

  if (net.isIP(parsed.hostname)) {
    if (isPrivateIp(parsed.hostname)) {
      throw new Error('Private IP URLs are not allowed');
    }

    return parsed;
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('Private network URLs are not allowed');
  }

  return parsed;
}

function parseHttpUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed');
  }

  return parsed;
}

function stripSteamCommunityPrefix(title) {
  return normalizeText(title).replace(/^Steam Community\s*::\s*/i, '');
}

function getBrowserTitleFallback(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  return parsed.hostname;
}

function getSteamProfileLookupUrl(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  const hostname = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);

  if ((hostname === 's.team' || hostname.endsWith('.s.team')) && parts[0] === 'p' && parts[1]) {
    return `${parsed.protocol}//${parsed.host}/p/${parts[1]}`;
  }

  if (
    (hostname === 'steamcommunity.com' || hostname.endsWith('.steamcommunity.com')) &&
    parts[0] === 'user' &&
    parts[1]
  ) {
    return `${parsed.protocol}//${parsed.host}/user/${parts[1]}/`;
  }

  return rawUrl;
}

async function getBrowserTabTitle(rawUrl) {
  const lookupUrl = getSteamProfileLookupUrl(rawUrl);

  try {
    const { html } = await loadHtml(lookupUrl);
    const root = parse(html);
    const steamProfile = parseSteamProfileData(html);
    const title =
      normalizeText(steamProfile.personaname) ||
      stripSteamCommunityPrefix(getMetaContent(root, ['og:title', 'twitter:title'])) ||
      stripSteamCommunityPrefix(root.querySelector('title')?.text);

    return title || getBrowserTitleFallback(rawUrl);
  } catch (error) {
    console.warn('Failed to resolve browser tab title:', error.message);
    return getBrowserTitleFallback(rawUrl);
  }
}

async function formatBrowserErrorData(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  const displayUrl = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
    .replace(/\/$/, '') || parsed.host;
  const tabTitle = await getBrowserTabTitle(rawUrl);

  return {
    browserUrlProtocol: parsed.protocol.replace(':', ''),
    browserUrlDisplay: displayUrl,
    browserTabTitle: tabTitle,
    title: tabTitle,
    description: rawUrl,
    sentUrl: rawUrl
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableFetchError(error) {
  const code = error?.cause?.code || error?.code;

  return (
    error?.name === 'AbortError' ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)
  );
}

async function fetchOnceWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    return await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegramHtmlBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(url) {
  let lastError;

  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchOnceWithTimeout(url);
    } catch (error) {
      lastError = error;

      if (!isRetryableFetchError(error) || attempt >= FETCH_RETRIES) {
        throw error;
      }

      await delay(FETCH_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError;
}

async function loadHtml(rawUrl) {
  let currentUrl = (await assertPublicHttpUrl(rawUrl)).href;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetchWithTimeout(currentUrl);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect without location: ${response.status}`);
      }

      currentUrl = (await assertPublicHttpUrl(new URL(location, currentUrl).href)).href;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/html|xml|text/i.test(contentType)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    return {
      html: await response.text(),
      finalUrl: currentUrl
    };
  }

  throw new Error('Too many redirects');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Шапка экрана: первая строка — раздел и вариант, вторая — состояние. Больше двух строк не бывает.
function formatHint(title, text) {
  return `<blockquote><b>${escapeHtml(title)}</b>\n${escapeHtml(text)}</blockquote>`;
}

// То же, но заголовок — готовый HTML (в нём может стоять <tg-emoji>). Данные в заголовок не попадают:
// вызывающий экранирует их сам.
function formatHintRaw(titleHtml, text) {
  return `<blockquote><b>${titleHtml}</b>\n${escapeHtml(text)}</blockquote>`;
}

// Свои эмодзи у разделов — те же ID, что у кнопок в корне. В тексте они ставятся через <tg-emoji>,
// потому что это не кнопка. Глиф внутри тега обычный: он же и фолбэк, если боту custom emoji запрещены.
const SECTION_ICONS = {
  menu: '5769662403188892779',
  profile: '5769485643809824170',
  codes: '5767203933843890630',
  tracker: '5769443797943475946'
};

function sectionLabel(name, glyph, title) {
  return `<tg-emoji emoji-id="${SECTION_ICONS[name]}">${glyph}</tg-emoji> ${title}`;
}

const MENU_LABEL = sectionLabel('menu', '🏠', 'Меню');
const PROFILE_LABEL = sectionLabel('profile', '🎭', 'Профиль');
const CODES_LABEL = sectionLabel('codes', '🎮', 'Коды');
const TRACKER_LABEL = sectionLabel('tracker', '📡', 'Трекер');

function addErrorModeLabel(mode) {
  if (mode === 'profile') {
    return 'Профиль';
  }

  if (mode === 'friendlink') {
    return 'Френдлинк';
  }

  if (mode === 'phone') {
    return 'Телефон';
  }

  return '';
}

// Шапки экранов со своим премиум-эмодзи — те же ID, что у кнопок, ведущих на экран. В тексте эмодзи
// идёт через <tg-emoji>, глиф внутри тега остаётся фолбэком, если боту custom emoji запрещены.
const SCREEN_ICONS = {
  [config.TEMPLATES.FRIEND]: { id: '5769615089829160389', glyph: '📨', title: 'Страница друга · ПК' },
  [config.TEMPLATES.FRIEND_MOBILE]: { id: '5769615089829160389', glyph: '📨', title: 'Страница друга · Телефон' },
  [config.TEMPLATES.QR_FRIEND]: { id: '5769163860565041689', glyph: '📷', title: 'QR-страница' },
  [config.TEMPLATES.STEAM_NOTICE]: { id: '5769318599646781593', glyph: '🚨', title: 'Steam Fake Alert' },
  [config.TEMPLATES.ADD_ERROR]: { id: '5769180082656518775', glyph: '🫂', title: 'Ошибка добавления' },
  [config.TEMPLATES.ERROR]: { id: '5766962281803948850', glyph: '⚠️', title: 'Ошибка браузера' },
  [config.TEMPLATES.STEAM_CHINA]: { id: '5769172811276887156', glyph: '🇨🇳', title: 'Steam China' },
  [config.TEMPLATES.CS2_WRONG_CODE]: { id: '5769364285213909331', glyph: '🎯', title: 'CS2 Fake Code' },
  [config.TEMPLATES.CS2_NOT_FOUND]: { id: '5767296748087157309', glyph: '❓', title: 'CS2 Code Not Found' },
  [config.TEMPLATES.CS2_BAN]: { id: '5769362077600719279', glyph: '⛔', title: 'CS2 Ban' },
  [config.TEMPLATES.DOTA_NOT_FOUND]: { id: '5769128663308054068', glyph: '❓', title: 'D2 Not Found' },
  [config.TEMPLATES.DOTA_NOT_FRIENDS]: { id: '5769182848615463136', glyph: '🚫', title: 'D2 Not Friends' }
};

// Экрана нет в шаблонах — это готовая картинка, но эмодзи у неё свой, из того же набора.
const D2_FAKE_CODE_LABEL = '<tg-emoji emoji-id="5769339808195290055">🎯</tg-emoji> D2 Fake Code';

// Выбор варианта — не шаблон, но шапка та же, что у самого экрана.
const FRIEND_LABEL = `<tg-emoji emoji-id="${SCREEN_ICONS[config.TEMPLATES.FRIEND].id}">📨</tg-emoji> Страница друга`;

function screenTitle(templateName, mode) {
  const custom = SCREEN_ICONS[templateName];
  const modeLabel = templateName === config.TEMPLATES.ADD_ERROR ? addErrorModeLabel(mode) : '';
  const base = custom
    ? `<tg-emoji emoji-id="${custom.id}">${custom.glyph}</tg-emoji> ${custom.title}`
    : escapeHtml(templateLabel(templateName));

  return modeLabel ? `${base} · ${escapeHtml(modeLabel)}` : base;
}

function formatTemplateHint(templateName, text, mode) {
  return formatHintRaw(screenTitle(templateName, mode), text);
}

function formatStateHint(state, text) {
  return formatTemplateHint(state.template, text, state.addErrorMode);
}

function getMetaContent(root, names) {
  for (const name of names) {
    const el =
      root.querySelector(`meta[property="${name}"]`) ||
      root.querySelector(`meta[name="${name}"]`);

    const content = el?.getAttribute('content');
    if (content) {
      return normalizeText(content);
    }
  }

  return '';
}

function getImageUrlFromElement(el, sourceUrl) {
  if (!el) {
    return '';
  }

  const srcset = el.getAttribute('srcset');
  const content = el.getAttribute('content');
  const src = srcset ? srcset.split(',')[0]?.trim().split(/\s+/)[0] : el.getAttribute('src');
  const imageUrl = src || content;

  if (!imageUrl) {
    return '';
  }

  try {
    return new URL(imageUrl, sourceUrl).href;
  } catch {
    return imageUrl;
  }
}

function getImageFromSelectors(root, selectors, sourceUrl) {
  for (const selector of selectors) {
    const imageUrl = getImageUrlFromElement(root.querySelector(selector), sourceUrl);

    if (imageUrl) {
      return imageUrl;
    }
  }

  return '';
}

function parseSteamProfileData(html) {
  const match = html.match(/g_rgProfileData\s*=\s*(\{[^;]+\});/);
  if (!match) {
    return {};
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}

function getSteamProfileName(root, html) {
  const steamProfile = parseSteamProfileData(html);
  const metaTitle = stripSteamCommunityPrefix(getMetaContent(root, ['og:title', 'twitter:title']));

  return (
    normalizeText(root.querySelector('.actual_persona_name')?.text) ||
    normalizeText(root.querySelector('.profile_header .persona_name')?.text) ||
    normalizeText(root.querySelector('.profile_header_centered_persona .persona_name')?.text) ||
    normalizeText(root.querySelector('.profile_header_summary .persona_name')?.text) ||
    normalizeText(root.querySelector('.friends_header_name a')?.text) ||
    normalizeText(steamProfile.personaname) ||
    metaTitle ||
    'Steam User'
  );
}

function parsePageData(html, selectors, sourceUrl) {
  const root = parse(html);
  const data = {};
  const steamProfile = parseSteamProfileData(html);

  if (selectors?.title) {
    const el = root.querySelector(selectors.title);
    data.title = normalizeText(el?.text);
  }

  if (selectors?.description) {
    const el = root.querySelector(selectors.description);
    data.description = normalizeText(el?.text);
  }

  if (selectors?.image) {
    data.imageUrl = getImageUrlFromElement(root.querySelector(selectors.image), sourceUrl);
  }

  const friendCount = normalizeText(root.querySelector('#menu_friends_ct')?.text);
  const metaTitle = getMetaContent(root, ['og:title', 'twitter:title']);
  const metaDescription = getMetaContent(root, ['og:description', 'description', 'twitter:description']);
  const metaImage = getMetaContent(root, ['og:image', 'twitter:image']);
  const titleEl = root.querySelector('h1') || root.querySelector('title');
  const avatarEl =
    root.querySelector('.profile_avatar_frame img') ||
    root.querySelector('.friends_header_avatar img') ||
    root.querySelector('img');

  data.title = data.title || normalizeText(steamProfile.personaname) || metaTitle || normalizeText(titleEl?.text) || 'Без заголовка';
  data.description =
    data.description ||
    metaDescription ||
    (friendCount ? `Друзей в Steam: ${friendCount}` : 'Нет описания');
  data.imageUrl = data.imageUrl || metaImage || getImageUrlFromElement(avatarEl, sourceUrl);
  data.friendCount = friendCount;
  data.profileUrl = steamProfile.url || sourceUrl;
  data.steamId = steamProfile.steamid || '';
  data.friendCode = normalizeText(root.querySelector('[data-userinfo]')?.getAttribute('data-userinfo')).match(/"accountid":(\d+)/)?.[1] || '';

  return data;
}

function parseFriendTemplateData(html, sourceUrl, sentUrl) {
  const root = parse(html);
  const steamProfile = parseSteamProfileData(html);
  const profileName = getSteamProfileName(root, html);
  let avatarUrl = getImageFromSelectors(root, [
    '.profile_header .playerAvatar.profile_header_size > .playerAvatarAutoSizeInner > picture > img',
    '.profile_header .playerAvatar.profile_header_size > .playerAvatarAutoSizeInner img',
    '.playerAvatar.profile_header_size > .playerAvatarAutoSizeInner > picture > img',
    '.playerAvatar.profile_header_size > .playerAvatarAutoSizeInner img',
    '.profile_avatar img',
    'meta[property="og:image"]'
  ], sourceUrl);
  let avatarFrameUrl = getImageFromSelectors(root, [
    '.profile_header .playerAvatar.profile_header_size > .profile_avatar_frame picture img',
    '.profile_header .playerAvatar.profile_header_size > .profile_avatar_frame img',
    '.profile_header .playerAvatar.profile_header_size > .profile_avatar_frame source',
    '.playerAvatar.profile_header_size > .profile_avatar_frame picture img',
    '.playerAvatar.profile_header_size > .profile_avatar_frame img',
    '.playerAvatar.profile_header_size > .profile_avatar_frame source',
    '.profile_avatar_frame img',
    '.profile_avatar_frame source'
  ], sourceUrl);

  if (avatarUrl && avatarFrameUrl && avatarUrl === avatarFrameUrl) {
    const metaAvatarUrl = getImageFromSelectors(root, ['meta[property="og:image"]'], sourceUrl);

    if (metaAvatarUrl && metaAvatarUrl !== avatarFrameUrl) {
      avatarUrl = metaAvatarUrl;
    } else {
      avatarFrameUrl = '';
    }
  }

  return {
    profileName,
    title: profileName,
    description: profileName,
    avatarUrl: avatarUrl || TRANSPARENT_PIXEL,
    avatarFrameUrl: avatarFrameUrl || TRANSPARENT_PIXEL,
    avatarFrameDisplay: avatarFrameUrl ? '' : 'display:none;',
    profileUrl: steamProfile.url || sourceUrl,
    steamId: steamProfile.steamid || '',
    sentUrl,
    friendCodeInput: '',
    friendCodeInputPlaceholder: 'Enter a Friend Code'
  };
}

function replaceAll(source, search, replacement) {
  return source.split(search).join(replacement);
}

function injectDataIntoTemplate(template, data) {
  const values = {
    TITLE: data.title || 'Без заголовка',
    DESCRIPTION: data.description || 'Нет описания',
    IMAGE_URL: data.imageUrl || '',
    PROFILE_NAME: data.profileName || data.title || 'Без ника',
    AVATAR_URL: data.avatarUrl || data.imageUrl || TRANSPARENT_PIXEL,
    AVATAR_FRAME_URL: data.avatarFrameUrl || TRANSPARENT_PIXEL,
    AVATAR_FRAME_DISPLAY: data.avatarFrameDisplay || '',
    FRIEND_COUNT: data.friendCount || '',
    PROFILE_URL: data.profileUrl || '',
    STEAM_ID: data.steamId || '',
    FRIEND_CODE: data.friendCode || '',
    FRIEND_CODE_INPUT: data.friendCodeInput || '',
    FRIEND_CODE_INPUT_PLACEHOLDER: data.friendCodeInputPlaceholder || '',
    BROWSER_TAB_TITLE: data.browserTabTitle || data.browserUrlDisplay || '',
    BROWSER_URL_PROTOCOL: data.browserUrlProtocol || 'https',
    BROWSER_URL_DISPLAY: data.browserUrlDisplay || '',
    SENT_URL: data.sentUrl || ''
  };

  let result = template.html;

  for (const [key, placeholder] of Object.entries(config.PLACEHOLDERS)) {
    result = replaceAll(result, placeholder, escapeHtml(values[key] || ''));
  }

  return result;
}

function injectBeforeBody(html, fragment) {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${fragment}</body>`);
  }

  return `${html}${fragment}`;
}

function injectBeforeHeadEnd(html, fragment) {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${fragment}</head>`);
  }

  return `${fragment}${html}`;
}

function removeSteamHeaderActions(root) {
  const selectors = [
    '#global_actions',
    '.global_actions',
    '.supernav_container .global_actions',
    '.header_installsteam_btn'
  ];

  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach(el => el.remove());
  }

  root.querySelectorAll('a, span, div').forEach(el => {
    if (!normalizeText(el.text).includes('Install Steam')) {
      return;
    }

    const actionsBlock =
      el.closest('#global_actions') ||
      el.closest('.global_actions') ||
      el.closest('.header_installsteam_btn');

    (actionsBlock || el).remove();
  });
}

function injectInviteBanner(root, bannerFragment) {
  const currentBanner = root.querySelector('#invite_banner');
  const nextBanner = parse(bannerFragment).querySelector('#invite_banner');

  if (!nextBanner) {
    return;
  }

  if (currentBanner) {
    currentBanner.replaceWith(nextBanner);
    return;
  }

  const pageContent = root.querySelector('#responsive_page_template_content');

  if (pageContent) {
    pageContent.insertAdjacentHTML('beforebegin', nextBanner.toString());
    return;
  }

  const profileHeader = root.querySelector('.profile_header_bg');

  if (profileHeader) {
    profileHeader.insertAdjacentHTML('beforebegin', nextBanner.toString());
    return;
  }

  root.appendChild(nextBanner);
}

function buildAddFriendErrorDialog(profileName) {
  const titleName = escapeHtml(profileName || 'Steam User');

  return `<dialog class="newmodal add_friend_error_modal" data-panel="{&quot;onCancelButton&quot;:&quot;CModal.DismissActiveModal()&quot;}" open=""><div class="modal_top_bar"></div><div class="newmodal_header_border"><div class="newmodal_header"><div class="newmodal_close" data-panel="{&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}"></div><div class="title_text">Add Friend - ${titleName}</div></div></div><div class="newmodal_content_border"><div class="newmodal_content" style="max-height: 803px;"><div>Couldn't send invitation. Please, try again later.</div><div class="newmodal_buttons" data-panel="{&quot;flow-children&quot;:&quot;row&quot;}"><div class="btn_grey_steamui btn_medium" data-panel="{&quot;autoFocus&quot;:true,&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}"><span>OK</span></div></div></div></div></dialog>`;
}

// Шапка «мы в аккаунте» для страниц ошибки добавления.
//
// Ничего своего: берём шаблон страницы друга целиком и показываем его верхние 104 px в iframe. Так
// шапка совпадает с ним до пикселя — та же разметка, тот же CSS, тот же JS, который включает зелёную
// кнопку Install и рисует колокольчик. Iframe изолирует её от стилей страницы кита (правила с
// !important бьют даже инлайн-стили — проверено).
const FRIEND_HEADER_HEIGHT = 104;
let friendHeaderTemplate;

async function loadFriendHeaderTemplate() {
  if (friendHeaderTemplate !== undefined) {
    return friendHeaderTemplate;
  }

  try {
    friendHeaderTemplate = await fs.readFile(
      path.join(PROJECT_ROOT, 'templates', `${config.TEMPLATES.FRIEND}.html`),
      'utf8'
    );
  } catch (error) {
    friendHeaderTemplate = '';
    console.warn(`friend header template is unavailable: ${error.message}`);
  }

  return friendHeaderTemplate;
}

async function buildAddErrorHeader(ownPageData) {
  if (!ownPageData || (!ownPageData.profileName && !ownPageData.avatarUrl)) {
    return '';
  }

  const template = await loadFriendHeaderTemplate();

  if (!template) {
    return '';
  }

  const nick = escapeHtml(ownPageData.profileName || 'Steam User');
  const pic = escapeHtml(await inlineAvatar(ownPageData.avatarUrl || ''));

  const doc = template.split('{{PROFILE_NAME}}').join(nick).split('{{AVATAR_URL}}').join(pic);

  // Внутри srcdoc экранируем разметку целиком: иначе последующие вставки по строке попадут внутрь.
  const srcdoc = doc
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<iframe id="aeHeader" title="Steam" scrolling="no" srcdoc="${srcdoc}" style="display:block;width:100%;height:${FRIEND_HEADER_HEIGHT}px;border:0;margin:0;padding:0;position:relative;z-index:5;background:#171a21"></iframe>`;
}

function injectAddFriendErrorContent(html, finalUrl, actionsFragment, inviteBannerFragment = '', headerHtml = '') {
  const htmlWithBase = ensureBaseHrefValue(html, finalUrl);
  const root = parse(htmlWithBase);
  const profileName = getSteamProfileName(root, html);
  const currentActions = root.querySelector('.profile_header_actions');
  const nextActions = parse(actionsFragment).querySelector('.profile_header_actions');

  removeSteamHeaderActions(root);

  if (inviteBannerFragment) {
    injectInviteBanner(root, inviteBannerFragment);
  }

  let result = root.toString();

  if (currentActions && nextActions) {
    currentActions.replaceWith(nextActions);
    result = root.toString();
  } else if (nextActions) {
    result = injectBeforeBody(result, nextActions.toString());
  }

  // Своя шапка встаёт первой в body, а родная шапка страницы кита убирается: иначе их две.
  if (headerHtml) {
    result = result.replace(/<body([^>]*)>/i, (match) => `${match}${headerHtml}`);

    if (result === html) {
      result = headerHtml + result;
    }

    result = injectBeforeHeadEnd(
      result,
      '<style>#global_header{display:none!important}</style>'
    );

    // Страница не должна подтягивать свою шапку скриптом.
    result = result.replace(/<body([^>]*)>/i, (match) => `${match}`);
  }

  const inviteBannerOffset = inviteBannerFragment ? INVITE_BANNER_MODAL_OFFSET_PX : 0;
  result = injectBeforeHeadEnd(result, ADD_FRIEND_ERROR_STYLE);

  return injectBeforeBody(
    result,
    `<div style="--invite-banner-offset:${inviteBannerOffset}px">${buildAddFriendErrorDialog(profileName)}</div>`
  );
}

function injectSteamChinaProfileCard(html, cardFragment) {
  const root = parse(html);
  const target =
    root.querySelector('#subpage_container > div > div > div > div:nth-child(2) > div._3nmSpgo_T_V0-Er7h8J2Ar') ||
    root.querySelector('._3nmSpgo_T_V0-Er7h8J2Ar');
  const nextCard = parse(cardFragment).querySelector('._28a_CNvDls7VgWoPW2-9Kz');

  if (!target || !nextCard) {
    return html;
  }

  const currentCard = target.querySelector('._28a_CNvDls7VgWoPW2-9Kz');

  if (currentCard) {
    currentCard.replaceWith(nextCard);
  } else {
    target.appendChild(nextCard);
  }

  return root.toString();
}

async function getBrokenVisibleImages(page) {
  return page.evaluate(() => {
    function isVisibleImage(img) {
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);

      return (
        rect.width > 2 &&
        rect.height > 2 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0
      );
    }

    return Array.from(document.images)
      .filter(isVisibleImage)
      .filter((img) => !img.complete || img.naturalWidth === 0 || img.naturalHeight === 0)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          src: img.currentSrc || img.src,
          alt: img.alt || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
      .slice(0, 10);
  });
}

async function waitForVisibleImages(page) {
  await page
    .waitForFunction(
      () => {
        function isVisibleImage(img) {
          const rect = img.getBoundingClientRect();
          const style = window.getComputedStyle(img);

          return (
            rect.width > 2 &&
            rect.height > 2 &&
            rect.bottom >= 0 &&
            rect.right >= 0 &&
            rect.top <= window.innerHeight &&
            rect.left <= window.innerWidth &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0
          );
        }

        return Array.from(document.images)
          .filter(isVisibleImage)
          .every((img) => img.complete);
      },
      undefined,
      { timeout: IMAGE_LOAD_TIMEOUT_MS }
    )
    .catch(() => {});

  return getBrokenVisibleImages(page);
}

async function retryBrokenVisibleImages(page) {
  return page.evaluate(() => {
    function isVisibleImage(img) {
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);

      return (
        rect.width > 2 &&
        rect.height > 2 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0
      );
    }

    let retried = 0;

    for (const img of Array.from(document.images).filter(isVisibleImage)) {
      if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        continue;
      }

      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) {
        continue;
      }

      const picture = img.closest('picture');
      if (picture) {
        picture.querySelectorAll('source').forEach((source) => source.removeAttribute('srcset'));
      }

      img.removeAttribute('srcset');

      try {
        const retryUrl = new URL(src, document.baseURI);
        retryUrl.searchParams.set('bot_img_retry', `${Date.now()}_${retried}`);
        img.src = retryUrl.href;
        retried++;
      } catch {
        img.src = src;
        retried++;
      }
    }

    return retried;
  });
}

async function screenshotModifiedHtml(html, viewport = DEFAULT_SCREENSHOT_VIEWPORT) {
  const page = await browserPool.getPage();

  try {
    await page.setViewportSize(viewport);

    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    let brokenImages = [];

    for (let attempt = 0; attempt <= IMAGE_RETRY_COUNT; attempt++) {
      brokenImages = await waitForVisibleImages(page);

      if (!brokenImages.length || attempt >= IMAGE_RETRY_COUNT) {
        break;
      }

      const retried = await retryBrokenVisibleImages(page);
      if (!retried) {
        break;
      }
    }

    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: false
    });

    return {
      imageBuffer,
      hasBrokenImages: brokenImages.length > 0,
      brokenImages
    };
  } finally {
    await browserPool.releasePage(page);
  }
}

function isFriendLikeTemplate(templateName) {
  return (
    templateName === config.TEMPLATES.FRIEND ||
    templateName === config.TEMPLATES.FRIEND_MOBILE ||
    templateName === config.TEMPLATES.STEAM_CHINA
  );
}

function isFriendPageTemplate(templateName) {
  return (
    templateName === config.TEMPLATES.FRIEND ||
    templateName === config.TEMPLATES.FRIEND_MOBILE
  );
}

async function loadFriendPageData(url) {
  const { html: originalHtml, finalUrl } = await loadHtml(url);
  return parseFriendTemplateData(originalHtml, finalUrl, url);
}

// The phone variant is a fixed 875×1798 frame with its own render function, so it is neither templated
// by placeholders nor screenshotted as a page: setContent, call renderSteamFriend, shoot the frame.
const PHONE_FRIEND_VIEWPORT = { width: 875, height: 1798 };

async function screenshotPhoneFriend(html, data) {
  const page = await browserPool.getPage();

  try {
    await page.setViewportSize(PHONE_FRIEND_VIEWPORT);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

    await page.waitForFunction(() => typeof window.renderSteamFriend === 'function', undefined, {
      timeout: 15000
    });

    const payload = {
      friend_code: String(data.friendCodeInput || ''),
      invite_link: String(data.sentUrl || '')
    };

    if (data.profileName) {
      payload.profile_name = String(data.profileName);
    }

    if (data.avatarUrl) {
      payload.user_pic = await inlineAvatar(data.avatarUrl);
    } else {
      console.warn(`phone friend: no avatar parsed for ${data.sentUrl || '?'}, the baked default stays`);
    }

    if (data.friendCode) {
      payload.own_code = String(data.friendCode);
    }

    const rendered = await page.evaluate((values) => {
      try {
        window.renderSteamFriend(values);
        return true;
      } catch (error) {
        return String(error?.message || error);
      }
    }, payload);

    if (rendered !== true) {
      throw new Error(String(rendered));
    }

    // Аватар приходит с внешнего CDN и грузится асинхронно: без этого ожидания в кадр попадает
    // дефолтная картинка, запечённая в шаблон, и выглядит это как «аватар не меняется».
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images).map((img) =>
          img.complete
            ? true
            : new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
              })
        )
      )
    );

    // One frame so the avatar and the scaled frame are painted before the element screenshot.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));

    const frame = await page.$('#frame');

    if (!frame) {
      throw new Error('phone frame #frame is missing');
    }

    return await frame.screenshot({ type: 'png' });
  } finally {
    await browserPool.releasePage(page);
  }
}

async function processRequest(url, templateName, options = {}) {
  const isFriendPage = isFriendLikeTemplate(templateName);
  const isPhoneFriend = templateName === config.TEMPLATES.FRIEND_MOBILE;
  const isBrowserError = templateName === config.TEMPLATES.ERROR;
  const isAddFriendError = templateName === config.TEMPLATES.ADD_ERROR;
  const cacheKey = screenshotCache.generateKey(url, templateName, {
    renderVersion: SCREENSHOT_CACHE_VERSION,
    selectors: config.SELECTORS,
    addErrorMode: options.addErrorMode || '',
    ownUrl: options.ownPageData?.sentUrl || ''
  });
  const cachedResult = screenshotCache.get(cacheKey);

  if (cachedResult) {
    console.log(`Cache hit for ${templateName}: ${url}`);
    return cachedResult;
  }

  let pageData;
  let finalHtml;

  if (isAddFriendError) {
    const { html: originalHtml, finalUrl } = await loadHtml(url);
    const actionsFragment = await loadFragment('add-friend-actions.html');
    const inviteBannerFragment = options.addErrorMode === 'friendlink'
      ? await loadFragment('add-friend-invite-banner.html')
      : '';
    const headerHtml = await buildAddErrorHeader(options.ownPageData);
    pageData = {
      title: '🫂Ошибка добавления',
      description: finalUrl,
      profileUrl: finalUrl,
      sentUrl: url
    };
    finalHtml = injectAddFriendErrorContent(
      originalHtml,
      finalUrl,
      actionsFragment,
      inviteBannerFragment,
      headerHtml
    );
  } else {
    const template = await loadTemplate(templateName);

    if (isBrowserError) {
      pageData = await formatBrowserErrorData(url);
    } else if (isFriendPage) {
      pageData = await loadFriendPageData(url);
    } else {
      const { html: originalHtml, finalUrl } = await loadHtml(url);
      pageData = parsePageData(originalHtml, config.SELECTORS, finalUrl);
    }

    finalHtml = injectDataIntoTemplate(template, pageData);
  }

  if (isPhoneFriend) {
    const imageBuffer = await screenshotPhoneFriend(finalHtml, pageData);

    screenshotCache.set(cacheKey, { imageBuffer, pageData });
    console.log(`Screenshot created for ${templateName}: ${url}`);

    return { imageBuffer, pageData };
  }

  const screenshot = await screenshotModifiedHtml(
    finalHtml,
    isFriendPage ? FRIEND_SCREENSHOT_VIEWPORT : DEFAULT_SCREENSHOT_VIEWPORT
  );
  const result = { imageBuffer: screenshot.imageBuffer, pageData };

  if (screenshot.hasBrokenImages) {
    console.warn(`Screenshot has broken images, skip cache for ${templateName}: ${url}`, screenshot.brokenImages);
  } else {
    screenshotCache.set(cacheKey, result);
  }

  console.log(`Screenshot created for ${templateName}: ${url}`);
  return result;
}

async function processFriendCodeRequest(pageData, friendCodeInput, templateName = config.TEMPLATES.FRIEND) {
  const data = {
    ...pageData,
    friendCodeInput,
    friendCodeInputPlaceholder: ''
  };
  const cacheKey = screenshotCache.generateKey(
    data.sentUrl || data.profileUrl || '',
    `${templateName}:friend-code:${friendCodeInput}`,
    {
      ...data,
      renderVersion: SCREENSHOT_CACHE_VERSION
    }
  );
  const cachedImage = screenshotCache.get(cacheKey);

  if (cachedImage) {
    return cachedImage;
  }

  const template = await loadTemplate(templateName);
  let finalHtml = injectDataIntoTemplate(template, data);

  if (templateName === config.TEMPLATES.STEAM_CHINA) {
    const cardFragment = await loadFragment('steam-china-profile-card.html');
    finalHtml = injectSteamChinaProfileCard(finalHtml, cardFragment);
  }

  if (templateName === config.TEMPLATES.FRIEND_MOBILE) {
    const imageBuffer = await screenshotPhoneFriend(finalHtml, data);

    screenshotCache.set(cacheKey, imageBuffer);
    return imageBuffer;
  }

  const screenshot = await screenshotModifiedHtml(finalHtml, FRIEND_SCREENSHOT_VIEWPORT);

  if (screenshot.hasBrokenImages) {
    console.warn(
      `Friend code screenshot has broken images, skip cache for ${templateName}: ${data.sentUrl || data.profileUrl || ''}`,
      screenshot.brokenImages
    );
  } else {
    screenshotCache.set(cacheKey, screenshot.imageBuffer);
  }

  return screenshot.imageBuffer;
}

function isCs2Template(templateName) {
  return (
    templateName === config.TEMPLATES.CS2_WRONG_CODE ||
    templateName === config.TEMPLATES.CS2_NOT_FOUND ||
    templateName === config.TEMPLATES.CS2_BAN
  );
}

// The CS2 templates hand the avatar to an <img> inside the page. Steam's CDN answers without CORS
// headers, and a canvas that has drawn such an image cannot be exported — so the bytes are fetched
// here and passed in as a data URL. The screen then renders the same way with or without the CDN.
async function fetchImageDataUrl(url) {  if (!url || !/^https?:/i.test(url)) {
    return '';
  }

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`avatar HTTP ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();

  if (contentType && !/^image\//i.test(contentType)) {
    throw new Error(`avatar content type ${contentType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error('avatar is larger than 8 MB');
  }

  return `data:${contentType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
}

// Only the nickname and the avatar of the fake page: the CS2 screens carry neither a frame nor a
// friend count, and the friend code is typed by the operator, not parsed.
async function loadCs2Profile(url) {
  const { html, finalUrl } = await loadHtml(url);
  const data = parseFriendTemplateData(html, finalUrl, url);

  return {
    nickname: data.profileName || 'Steam User',
    avatarUrl: data.avatarUrl || '',
    sentUrl: url
  };
}

// Аватар в телефонный шаблон и в QR уходит data-URL'ом: если из контейнера CDN Steam не открывается,
// картинка не грузится, <img> остаётся пустым — и под ним проступает дефолтная аватарка, запечённая в
// шаблон. Внешне это выглядит как «аватар не меняется». Свои байты снимают зависимость от CDN.
// Если забрать не удалось, отдаём исходный URL: пусть попробует сам браузер.
const avatarDataCache = new Map();
const AVATAR_CACHE_LIMIT = 50;

async function inlineAvatar(url) {
  const value = String(url || '');

  if (!/^https?:/i.test(value)) {
    return value;
  }

  const cached = avatarDataCache.get(value);

  if (cached) {
    return cached;
  }

  try {
    const dataUrl = await fetchImageDataUrl(value);

    if (dataUrl) {
      if (avatarDataCache.size >= AVATAR_CACHE_LIMIT) {
        avatarDataCache.delete(avatarDataCache.keys().next().value);
      }

      avatarDataCache.set(value, dataUrl);
      return dataUrl;
    }
  } catch (error) {
    console.warn(`avatar inline failed (${error.message}), leaving the remote url`);
  }

  return value;
}

async function renderCs2Screenshot({ templateName, payload }) {
  const template = await loadTemplate(templateName);
  const page = await browserPool.getPage();

  try {
    await page.setContent(template.html, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    await page.waitForFunction(
      () =>
        typeof window.renderProfile === 'function' ||
        typeof window.renderCS2 === 'function' ||
        typeof window.setCS2 === 'function',
      undefined,
      { timeout: 15000 }
    );

    // The canvas carries the real size, so the viewport is set from it instead of a table of guesses.
    // After the resize the page lays the canvas out at 1:1 and the element screenshot stays sharp.
    const size = await page.evaluate((selector) => {
      const canvas = document.querySelector(selector);

      return canvas ? { width: canvas.width, height: canvas.height } : null;
    }, CS2_CANVAS);

    if (!size || !size.width || !size.height) {
      throw new Error(`no canvas in ${templateName}`);
    }

    await page.setViewportSize(size);

    // renderProfile resolves only after the background, the avatar and the fonts are ready.
    // The templates name that entry point differently — renderProfile, renderCS2, setCS2 — so whichever
    // one is there is called with the same payload.
    const rendered = await page.evaluate(async (data) => {
      const render = window.renderProfile || window.renderCS2 || window.setCS2;

      try {
        return await render(data);
      } catch (error) {
        return `render error: ${error?.message || error}`;
      }
    }, payload);

    if (rendered !== true) {
      throw new Error(String(rendered || 'template refused to render'));
    }

    const canvas = await page.$(CS2_CANVAS);

    if (!canvas) {
      throw new Error(`canvas ${CS2_CANVAS} is missing in ${templateName}`);
    }

    return await canvas.screenshot({ type: 'png' });
  } finally {
    await browserPool.releasePage(page);
  }
}

async function processCs2Request(templateName, url, options = {}) {
  const friendCode = String(options.friendCode || '');
  const banText = String(options.banText || '');
  const cacheKey = screenshotCache.generateKey(url, `${templateName}:${friendCode}:${banText}`, {
    renderVersion: SCREENSHOT_CACHE_VERSION
  });
  const cached = screenshotCache.get(cacheKey);

  if (cached) {
    console.log(`Cache hit for ${templateName}: ${url}`);
    return cached;
  }

  const profile = await loadCs2Profile(url);
  let avatarDataUrl = '';

  try {
    avatarDataUrl = await fetchImageDataUrl(profile.avatarUrl);
  } catch (error) {
    console.warn(`CS2 avatar fetch failed (${templateName}): ${error.message}`);
  }

  // One payload for every CS2 screen: each template reads the keys it knows and ignores the rest.
  // `friendCode`/`code` are the two names the code screens use; the ban screen reads `cooldown`,
  // falls back to `time`, then `text` — all three carry the same label.
  // Один шрифт под тремя именами: шаблоны называют поле по-разному — wrong_code читает fontDataUrl,
  // not_found и ban — stratum2FontDataUrl. Лишние ключи шаблоны игнорируют.
  const fontDataUrl = await loadCs2Font();

  const imageBuffer = await renderCs2Screenshot({
    templateName,
    payload: {
      nickname: profile.nickname,
      avatarDataUrl,
      friendCode,
      code: friendCode,
      banText,
      text: banText,
      time: banText,
      cooldown: banText,
      fontDataUrl,
      fontUrl: fontDataUrl,
      stratum2FontDataUrl: fontDataUrl,
      stratum2FontUrl: fontDataUrl
    }
  });

  screenshotCache.set(cacheKey, imageBuffer);
  console.log(`Screenshot created for ${templateName}: ${url}`);

  return imageBuffer;
}

function isDotaTemplate(templateName) {
  return (
    templateName === config.TEMPLATES.DOTA_NOT_FOUND ||
    templateName === config.TEMPLATES.DOTA_NOT_FRIENDS
  );
}

// The Dota screens are plain SVG: the friend code goes into <text id="friend-id">, everything else is
// baked into the background. No canvas, no render function, so the screenshot is of the <svg> element
// at its own viewBox size.
async function renderDotaScreenshot(templateName, friendCode) {
  const template = await loadTemplate(templateName);
  const page = await browserPool.getPage();

  try {
    await page.setContent(template.html, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    const size = await page.evaluate(() => {
      const svg = document.querySelector('svg.profile') || document.querySelector('svg');

      if (!svg) {
        return null;
      }

      const box = svg.viewBox?.baseVal;

      return box && box.width && box.height
        ? { width: Math.round(box.width), height: Math.round(box.height) }
        : null;
    });

    if (!size) {
      throw new Error(`no svg viewBox in ${templateName}`);
    }

    await page.setViewportSize(size);

    const filled = await page.evaluate((code) => {
      const node = document.getElementById('friend-id');

      if (!node) {
        return false;
      }

      node.textContent = code;

      return true;
    }, friendCode);

    if (!filled) {
      throw new Error(`friend-id is missing in ${templateName}`);
    }

    // One frame, so the browser repaints the text before the element screenshot.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));

    const svg = await page.$('svg');

    if (!svg) {
      throw new Error(`svg is missing in ${templateName}`);
    }

    return await svg.screenshot({ type: 'png' });
  } finally {
    await browserPool.releasePage(page);
  }
}

async function processDotaRequest(templateName, friendCode) {
  const code = String(friendCode || '').trim();
  const cacheKey = screenshotCache.generateKey(`${templateName}:${code}`, 'dota', {
    renderVersion: SCREENSHOT_CACHE_VERSION
  });
  const cached = screenshotCache.get(cacheKey);

  if (cached) {
    console.log(`Cache hit for ${templateName}: ${code}`);
    return cached;
  }

  const imageBuffer = await renderDotaScreenshot(templateName, code);

  screenshotCache.set(cacheKey, imageBuffer);
  console.log(`Screenshot created for ${templateName}: ${code}`);

  return imageBuffer;
}

// The QR screen: the friend page plus a QR of the link, both drawn from the same template. Its four
// placeholders are lowercase — {{user_nick}}, {{user_pic}}, {{qr_code}}, {{invite_link}} — so they are
// replaced here instead of going through the uppercase placeholder set the other templates use.
const QR_FRIEND_VIEWPORT = { width: 871, height: 1806 };

async function processQrFriendRequest(url) {
  const cacheKey = screenshotCache.generateKey(url, config.TEMPLATES.QR_FRIEND, {
    renderVersion: SCREENSHOT_CACHE_VERSION
  });
  const cached = screenshotCache.get(cacheKey);

  if (cached) {
    console.log(`Cache hit for ${config.TEMPLATES.QR_FRIEND}: ${url}`);
    return cached;
  }

  const pageData = await loadFriendPageData(url);
  const QRCode = require('qrcode');

  // 530 px for a 265 px box: the QR stays sharp when the picture is opened at full size.
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 530, errorCorrectionLevel: 'M' });

  const template = await loadTemplate(config.TEMPLATES.QR_FRIEND);
  const avatar = await inlineAvatar(pageData.avatarUrl || '');

  const html = template.html
    .split('{{user_nick}}')
    .join(escapeHtml(pageData.profileName || 'Steam User'))
    .split('{{user_pic}}')
    .join(escapeHtml(avatar))
    .split('{{qr_code}}')
    .join(qrDataUrl)
    .split('{{invite_link}}')
    .join(escapeHtml(url));

  const page = await browserPool.getPage();

  let imageBuffer;

  try {
    await page.setViewportSize(QR_FRIEND_VIEWPORT);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // The avatar is a remote image: wait for it, or shoot a hole where the face should be.
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images).map((img) =>
          img.complete
            ? true
            : new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
              })
        )
      )
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));

    const capture = await page.$('#capture');

    if (!capture) {
      throw new Error('QR template has no #capture element');
    }

    imageBuffer = await capture.screenshot({ type: 'png' });
  } finally {
    await browserPool.releasePage(page);
  }

  screenshotCache.set(cacheKey, imageBuffer);
  console.log(`Screenshot created for ${config.TEMPLATES.QR_FRIEND}: ${url}`);

  return imageBuffer;
}

// «Steam Fake Alert»: готовая подложка с двумя текстовыми слоями — адресная строка и строка уведомления.
// Ссылка одна, а мест два: шаблон сам раскладывает её на protocol/host/path для адреса и пишет целиком
// в уведомление (window.setUrl). Данные идут через textContent, поэтому HTML из ссылки не выполнится.
const STEAM_NOTICE_VIEWPORT = { width: 1917, height: 1032 };

async function processSteamNoticeRequest(link) {
  const cacheKey = screenshotCache.generateKey(link, config.TEMPLATES.STEAM_NOTICE, {
    renderVersion: SCREENSHOT_CACHE_VERSION
  });
  const cached = screenshotCache.get(cacheKey);

  if (cached) {
    console.log(`Cache hit for ${config.TEMPLATES.STEAM_NOTICE}: ${link}`);
    return cached;
  }

  const template = await loadTemplate(config.TEMPLATES.STEAM_NOTICE);
  const page = await browserPool.getPage();

  let imageBuffer;

  try {
    await page.setViewportSize(STEAM_NOTICE_VIEWPORT);
    await page.setContent(template.html, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const ready = await page.evaluate((url) => {
      window.setUrl(url);
      return window.__renderReady === true;
    }, link);

    if (!ready) {
      throw new Error('steam notice template did not report render ready');
    }

    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));

    const shot = await page.$('#shot');

    if (!shot) {
      throw new Error('steam notice template has no #shot element');
    }

    imageBuffer = await shot.screenshot({ type: 'png' });
  } finally {
    await browserPool.releasePage(page);
  }

  screenshotCache.set(cacheKey, imageBuffer);
  console.log(`Screenshot created for ${config.TEMPLATES.STEAM_NOTICE}: ${link}`);

  return imageBuffer;
}

// Phone version of the add-friend error screen. Its data is not the uppercase placeholder set either:
// six lowercase keys, and the friend card is the profile from the link while the code is typed by the
// operator — the same code that "failed" to send an invitation.
const ADD_ERROR_PHONE_VIEWPORT = { width: 851, height: 1849 };

// Телефонная ошибка добавления собирается из двух профилей: верх страницы (обе верхние аватарки и
// ник) — с фейка, то есть «мы залогинены»; карточка друга и её ник — с профиля кита; ссылка внизу —
// снова фейк, потому что именно её отправляли.
async function renderAddErrorPhone(kitPage, fakePage, code) {
  const template = await loadTemplate(config.TEMPLATES.ADD_ERROR_PHONE);
  const userNick = escapeHtml(fakePage.profileName || 'Steam User');
  const userPic = escapeHtml(await inlineAvatar(fakePage.avatarUrl || ''));
  const friendNick = escapeHtml(kitPage.profileName || 'Steam User');
  const friendPic = escapeHtml(await inlineAvatar(kitPage.avatarUrl || ''));

  const html = template.html
    .split('{{user_nick}}')
    .join(userNick)
    .split('{{friend_nick}}')
    .join(friendNick)
    .split('{{user_pic}}')
    .join(userPic)
    .split('{{friend_pic}}')
    .join(friendPic)
    .split('{{input_code}}')
    .join(escapeHtml(code))
    .split('{{invite_link}}')
    .join(escapeHtml(fakePage.sentUrl || ''));

  const page = await browserPool.getPage();

  try {
    await page.setViewportSize(ADD_ERROR_PHONE_VIEWPORT);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images).map((img) =>
          img.complete
            ? true
            : new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
              })
        )
      )
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));

    const screen = await page.$('#steam-screen');

    if (!screen) {
      throw new Error('add-error phone template has no #steam-screen');
    }

    return await screen.screenshot({ type: 'png' });
  } finally {
    await browserPool.releasePage(page);
  }
}

async function processAddErrorPhone(kitPage, fakePage, code) {
  const cacheKey = screenshotCache.generateKey(
    `${fakePage.sentUrl || ''}|${kitPage.sentUrl || ''}`,
    `${config.TEMPLATES.ADD_ERROR_PHONE}:${code}`,
    { renderVersion: SCREENSHOT_CACHE_VERSION }
  );
  const cached = screenshotCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const imageBuffer = await renderAddErrorPhone(kitPage, fakePage, code);

  screenshotCache.set(cacheKey, imageBuffer);
  console.log(`Screenshot created for ${config.TEMPLATES.ADD_ERROR_PHONE}: ${kitPage.sentUrl}`);

  return imageBuffer;
}

// Профиль и френдлинк: страница кита плюс наша шапка, снятая с фейк-ссылки.
async function renderAddErrorPage(ctx, state) {
  const kit = state.addErrorData;
  let progressMessage;

  try {
    state.status = 'processing_add_error_page';
    userState.set(ctx.from.id, state);

    progressMessage = await sendProgressMessage(ctx, 'Собираю страницу…');

    const taskId = `${ctx.from.id}_add_error_page_${Date.now()}`;
    const { imageBuffer } = await requestQueue.add(taskId, () =>
      processRequest(kit.sentUrl, config.TEMPLATES.ADD_ERROR, {
        addErrorMode: state.addErrorMode,
        ownPageData: state.addErrorFake
      })
    );

    await deleteProgressMessage(ctx, progressMessage);

    state.status = 'waiting_add_error_fake';
    userState.set(ctx.from.id, state);

    await sendResult(ctx, imageBuffer, {
      label: screenTitle(state.template, state.addErrorMode),
      keyboard: resultTemplateKeyboard(state.template)
    });
  } catch (error) {
    console.error('Add-error page error:', error);
    await deleteProgressMessage(ctx, progressMessage);

    state.status = 'waiting_add_error_fake';
    userState.set(ctx.from.id, state);

    await editMenu(
      ctx,
      formatStateHint(state, 'Не удалось собрать страницу. Отправь ссылку ещё раз.'),
      errorKeyboard(state.template)
    );
  }
}

// Кнопка: текст и данные, вид (иконка, цвет) приходит из data/ui.json по callback_data.
const b = (text, callback) => ({ text, callback_data: callback });

const homeRow = () => [b('🏠 Меню', 'root_menu')];

function mainKeyboard() {
  return {
    inline_keyboard: [
      [b('🎭 Профиль', 'section_profile'), b('🎮 Коды', 'section_codes')],
      [b('📡 Трекер', 'tracker_menu')]
    ]
  };
}

function profileKeyboard() {
  return {
    inline_keyboard: [
      [b('📨 Страница друга', 'template_friend')],
      [b('📷 QR-страница', 'qr_friend')],
      [b('🚨 Steam Fake Alert', 'template_steam_notice')],
      [b('🫂 Ошибка добавления', 'template_add_error')],
      [b('⚠️ Ошибка браузера', 'template_error')],
      [b('🇨🇳 Steam China', 'template_steam_china')],
      homeRow()
    ]
  };
}

function codesKeyboard() {
  return {
    inline_keyboard: [
      [b('🎯 CS2 Code', 'cs2_menu')],
      [b('⚔️ D2 Code', 'dota_menu')],
      homeRow()
    ]
  };
}

function trackerStatusLabel(profile) {
  if (profile.status === tracker.STATE_OFFLINE) {
    return '⚫ оффлайн';
  }

  if (profile.status === tracker.STATE_INGAME) {
    return `🎮 ${profile.game}`;
  }

  return '🟢 онлайн';
}

function trackerKeyboard(notifyOn) {
  return {
    inline_keyboard: [
      [b('➕ Добавить профиль', 'tracker_add')],
      [b('📋 Мои профили', 'tracker_list')],
      [b(`🔔 Уведомления: ${notifyOn ? 'вкл' : 'выкл'}`, 'tracker_notify')],
      homeRow()
    ]
  };
}

function trackerListKeyboard(profiles) {
  const rows = profiles.map((profile) => [
    b(`${trackerStatusLabel(profile).slice(0, 24)} · ${String(profile.name).slice(0, 20)}`, `tracker_open_${profile.steamId}`)
  ]);

  rows.push([b('← Назад', 'tracker_menu')]);

  return { inline_keyboard: rows };
}

function trackerProfileKeyboard(steamId) {
  return {
    inline_keyboard: [
      [b('🔄 Обновить', `tracker_refresh_${steamId}`)],
      [b('🗑 Отписаться', `tracker_remove_${steamId}`)],
      [b('← Назад', 'tracker_list')]
    ]
  };
}

function dotaKeyboard() {
  return {
    inline_keyboard: [
      [b('🎯 Fake Code', 'dota_fake_code')],
      [b('❓ Not Found', 'dota_not_found')],
      [b('🚫 Not Friends', 'dota_not_friends')],
      [b('← Назад', 'section_codes')],
      homeRow()
    ]
  };
}

function cs2Keyboard() {
  return {
    inline_keyboard: [
      [b('🎯 Fake Code', 'cs2_fake_code')],
      [b('❓ Code Not Found', 'cs2_not_found')],
      [b('⛔ Ban', 'cs2_ban')],
      [b('← Назад', 'section_codes')],
      homeRow()
    ]
  };
}

// Durations of the ban screen, in the order the operator sees them. The label is what gets painted
// into the picture; the key is what callback_data can carry.
const CS2_BAN_DURATIONS = {
  '30m': '30 Mins',
  '1h': '1 Hour',
  '2h': '2 Hours',
  '5h': '5 Hours',
  '23h': '23 Hours',
  '1d': '1 Day',
  '3d': '3 Days',
  '7d': '7 Days'
};

function cs2BanKeyboard() {
  const pairs = Object.entries(CS2_BAN_DURATIONS);
  const rows = [];

  for (let i = 0; i < pairs.length; i += 2) {
    rows.push(
      pairs.slice(i, i + 2).map(([key, label]) => ({
        text: label,
        callback_data: `cs2b_${key}`
      }))
    );
  }

  rows.push([b('✏️ Свой текст', 'cs2b_custom')]);
  rows.push([b('← Назад', 'section_codes')]);
  rows.push(homeRow());

  return { inline_keyboard: rows };
}

// Подпись экрана — то, что видно первой строкой шапки. Вариант стоит в той же строке, через точку.
function templateLabel(templateName) {
  if (templateName === config.TEMPLATES.FRIEND) {
    return '📨 Страница друга · ПК';
  }

  if (templateName === config.TEMPLATES.FRIEND_MOBILE) {
    return '📨 Страница друга · Телефон';
  }

  if (templateName === config.TEMPLATES.QR_FRIEND) {
    return '📷 QR-страница';
  }

  if (templateName === config.TEMPLATES.STEAM_NOTICE) {
    return '🚨 Steam Fake Alert';
  }

  if (templateName === config.TEMPLATES.ERROR) {
    return '⚠️ Ошибка браузера';
  }

  if (templateName === config.TEMPLATES.ADD_ERROR) {
    return '🫂 Ошибка добавления';
  }

  if (templateName === config.TEMPLATES.STEAM_CHINA) {
    return '🇨🇳 Steam China';
  }

  if (templateName === config.TEMPLATES.CS2_WRONG_CODE) {
    return '🎯 CS2 Fake Code';
  }

  if (templateName === config.TEMPLATES.CS2_NOT_FOUND) {
    return '❓ CS2 Code Not Found';
  }

  if (templateName === config.TEMPLATES.CS2_BAN) {
    return '⛔ CS2 Ban';
  }

  if (templateName === config.TEMPLATES.DOTA_NOT_FOUND) {
    return '❓ D2 Not Found';
  }

  if (templateName === config.TEMPLATES.DOTA_NOT_FRIENDS) {
    return '🚫 D2 Not Friends';
  }

  return templateName;
}

function templatePrompt(templateName) {
  if (templateName === config.TEMPLATES.FRIEND) {
    return 'Отправь ссылку на фейк.';
  }

  if (templateName === config.TEMPLATES.FRIEND_MOBILE) {
    return 'Отправь ссылку на фейк.';
  }

  if (templateName === config.TEMPLATES.ERROR) {
    return 'Отправь friend link кита';
  }

  if (templateName === config.TEMPLATES.STEAM_NOTICE) {
    return 'Отправь френдлинк кита.';
  }

  if (templateName === config.TEMPLATES.ADD_ERROR) {
    return 'Выбери тип ссылки.';
  }

  if (templateName === config.TEMPLATES.STEAM_CHINA) {
    return 'Отправь ссылку на фейк.';
  }

  if (templateName === config.TEMPLATES.CS2_WRONG_CODE) {
    return 'Отправь ссылку на фэйк.';
  }

  if (templateName === config.TEMPLATES.CS2_NOT_FOUND) {
    return 'Отправь ссылку на фэйк.';
  }

  if (templateName === config.TEMPLATES.CS2_BAN) {
    return 'Отправь ссылку на фэйк.';
  }

  if (templateName === config.TEMPLATES.DOTA_NOT_FOUND) {
    return 'Отправь френд-код друга.';
  }

  if (templateName === config.TEMPLATES.DOTA_NOT_FRIENDS) {
    return 'Отправь френд-код друга.';
  }

  return 'Отправь ссылку для обработки.';
}

function addErrorModeKeyboard() {
  return {
    inline_keyboard: [
      [b('🖥 Профиль', 'add_error_profile')],
      [b('🔗 Френдлинк', 'add_error_friendlink')],
      [b('📱 Телефон', 'add_error_phone')],
      backRow('section_profile'),
      homeRow()
    ]
  };
}

// Раздел, из которого открыт экран: «← Назад» ведёт туда, а не в самый корень. Корень — это «🏠 Меню»,
// отдельная кнопка, чтобы не приходилось угадывать, куда вернёт стрелка.
function sectionOf(templateName) {
  if (isCs2Template(templateName) || isDotaTemplate(templateName)) {
    return 'section_codes';
  }

  return 'section_profile';
}

function backRow(section) {
  return [b('← Назад', section)];
}

// Пока бот ждёт ввод, единственная разумная кнопка — отмена. Куда отменять, знает раздел экрана.
function waitingKeyboard(templateName) {
  return { inline_keyboard: [[b('✖️ Отмена', sectionOf(templateName))]] };
}

// Ошибка всегда даёт два выхода: тот же экран заново или в раздел.
function errorKeyboard(templateName) {
  return {
    inline_keyboard: [
      [b('🔁 Ещё раз', 'again')],
      backRow(sectionOf(templateName)),
      homeRow()
    ]
  };
}

// The friend page opens on a desktop screen or inside a phone frame; the rest of the flow is identical.
function friendVariantKeyboard() {
  return {
    inline_keyboard: [
      [b('🖥 ПК', 'friend_variant_pc'), b('📱 Телефон', 'friend_variant_mobile')],
      backRow('section_profile'),
      homeRow()
    ]
  };
}

// Клавиатура результата: повторить тот же экран, вернуться в раздел, уйти в корень.
function resultTemplateKeyboard(templateName, canAddFriendCode = false) {
  const rows = [];

  if (isFriendPageTemplate(templateName) && canAddFriendCode) {
    rows.push([b('➕ Добавить код друга', 'add_friend_code')]);
  }

  rows.push([b('🔁 Ещё раз', 'again')]);
  rows.push(backRow(sectionOf(templateName)));
  rows.push(homeRow());

  return { inline_keyboard: rows };
}

function getUserState(ctx) {
  const userId = ctx.from.id;
  const state = userState.get(userId) || {};
  state.chatId = state.chatId || ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
  return state;
}

async function saveMenuMessage(ctx, message) {
  const state = getUserState(ctx);
  state.menuMessageId = message.message_id;
  state.menuMessageType = message.photo ? 'photo' : 'text';
  state.chatId = message.chat.id;
  userState.set(ctx.from.id, state);
}

async function deleteSavedMenu(ctx) {
  const state = getUserState(ctx);

  if (!state.chatId || !state.menuMessageId) {
    return;
  }

  await ctx.telegram.deleteMessage(state.chatId, state.menuMessageId).catch(() => {});
  state.menuMessageId = null;
  state.menuMessageType = null;
  state.menuKind = null;
  userState.set(ctx.from.id, state);
}

async function deleteMenuMessage(ctx, chatId, messageId) {
  if (chatId && messageId) {
    await ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
  }
}

async function deleteIncomingMessage(ctx) {
  if (ctx.message?.message_id) {
    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
  }
}

async function sendProgressMessage(ctx, text) {
  const state = getUserState(ctx);
  state.startedAt = Date.now();
  userState.set(ctx.from.id, state);

  // Счётчик времени в подписи результата и «отправляет фото» в шапке чата: оператор видит, что работа
  // идёт, и сколько она заняла.
  await ctx.sendChatAction('upload_photo').catch(() => {});

  return ctx.reply(`⏳ ${text}`);
}

async function deleteProgressMessage(ctx, message) {
  if (message?.chat?.id && message?.message_id) {
    await ctx.telegram.deleteMessage(message.chat.id, message.message_id).catch(() => {});
  }
}

async function deleteSteamChinaCodePrompt(ctx) {
  const state = getUserState(ctx);

  if (state.steamChinaPromptChatId && state.steamChinaPromptMessageId) {
    await ctx.telegram
      .deleteMessage(state.steamChinaPromptChatId, state.steamChinaPromptMessageId)
      .catch(() => {});
  }

  state.steamChinaPromptChatId = null;
  state.steamChinaPromptMessageId = null;
  userState.set(ctx.from.id, state);
}

async function sendSteamChinaCodePrompt(ctx, text) {
  await deleteSteamChinaCodePrompt(ctx);

  const state = getUserState(ctx);
  const message = await ctx.reply(formatStateHint(state, text), { parse_mode: 'HTML' });

  state.steamChinaPromptChatId = message.chat.id;
  state.steamChinaPromptMessageId = message.message_id;
  userState.set(ctx.from.id, state);
}

async function loadPhotoAssetFileId(asset) {
  if (asset.fileId !== null) {
    return asset.fileId;
  }

  try {
    asset.fileId = (await fs.readFile(asset.fileIdPath, 'utf8')).trim() || '';
  } catch {
    asset.fileId = '';
  }

  return asset.fileId;
}

async function savePhotoAssetFileId(asset, fileId) {
  if (!fileId || fileId === asset.fileId) {
    return;
  }

  asset.fileId = fileId;
  await fs.mkdir(RUNTIME_CACHE_DIR, { recursive: true });
  await fs.writeFile(asset.fileIdPath, fileId);
}

async function getPhotoAssetInput(asset) {
  const fileId = await loadPhotoAssetFileId(asset);

  if (fileId) {
    return fileId;
  }

  if (!asset.buffer) {
    asset.buffer = await fs.readFile(asset.path);
  }

  return {
    source: asset.buffer,
    filename: asset.filename
  };
}

async function cachePhotoFileId(asset, message) {
  const photos = message.photo || [];
  const largestPhoto = photos[photos.length - 1];

  if (largestPhoto?.file_id) {
    await savePhotoAssetFileId(asset, largestPhoto.file_id).catch(error => {
      console.warn('Failed to cache preview file_id:', error.message);
    });
  }
}

async function warmupPhotoAsset(asset) {
  await loadPhotoAssetFileId(asset);

  if (!asset.fileId && !asset.buffer) {
    asset.buffer = await fs.readFile(asset.path);
  }
}

async function replyWithCachedPhoto(ctx, photoPath, extra) {
  const asset = Object.values(photoAssets).find(item => item.path === photoPath);
  const photo = asset ? await getPhotoAssetInput(asset) : { source: photoPath };

  try {
    return await ctx.replyWithPhoto(photo, extra);
  } catch (error) {
    if (!asset || typeof photo !== 'string') {
      throw error;
    }

    asset.fileId = '';
    const fallbackPhoto = await getPhotoAssetInput(asset);
    return await ctx.replyWithPhoto(fallbackPhoto, extra);
  }
}

// Telegram вправе отказать в <tg-emoji>: кастомный эмодзи в тексте доступен не всякому боту. Тогда тот же
// экран уходит без тегов — остаётся обычный эмодзи внутри, экран не ломается.
function stripCustomEmoji(text) {
  return String(text).replace(/<\/?tg-emoji[^>]*>/gi, '');
}

async function withCustomEmojiFallback(text, attempt) {
  try {
    return await attempt(text);
  } catch (error) {
    const message = String(error.description || error.message || '');

    if (!String(text).includes('<tg-emoji') || !/custom emoji/i.test(message)) {
      throw error;
    }

    return attempt(stripCustomEmoji(text));
  }
}

async function editMenu(ctx, text, replyMarkup) {
  const state = getUserState(ctx);
  const chatId = state.chatId;
  const messageId = state.menuMessageId;
  const options = {
    parse_mode: 'HTML',
    reply_markup: ui.decorateInline(replyMarkup || { inline_keyboard: [] })
  };

  // Готовый скриншот не переписываем: его подпись — это результат, а не меню. Раздел, открытый с
  // результата, приходит отдельным сообщением, картинка остаётся выше.
  if (messageId && chatId && state.menuKind !== 'result') {
    const editAs = (value) =>
      state.menuMessageType === 'photo'
        ? ctx.telegram.editMessageCaption(chatId, messageId, undefined, value, options)
        : ctx.telegram.editMessageText(chatId, messageId, undefined, value, options);
    const editCaptionAs = (value) =>
      ctx.telegram.editMessageCaption(chatId, messageId, undefined, value, options);

    try {
      await withCustomEmojiFallback(text, editAs);

      userState.set(ctx.from.id, state);
      return;
    } catch (error) {
      const errorText = String(error.description || error.message);

      if (errorText.includes('there is no text in the message to edit')) {
        try {
          await withCustomEmojiFallback(text, editCaptionAs);
          state.menuMessageType = 'photo';
          userState.set(ctx.from.id, state);
          return;
        } catch (captionError) {
          const captionErrorText = String(captionError.description || captionError.message);

          if (captionErrorText.includes('message is not modified')) {
            return;
          }

          console.warn('Failed to edit menu caption:', captionError.description || captionError.message);
          await deleteSavedMenu(ctx);
        }
      } else if (errorText.includes('message is not modified')) {
        return;
      } else {
        console.warn('Failed to edit menu message:', error.description || error.message);
        await deleteSavedMenu(ctx);
      }
    }
  }

  const message = await withCustomEmojiFallback(text, (value) => ctx.reply(value, options));
  state.menuKind = 'text';
  await saveMenuMessage(ctx, message);
}

async function replaceMenu(ctx, text, replyMarkup) {
  const state = getUserState(ctx);
  // Готовый скриншот не трогаем: он уходит только когда его заменит следующий результат.
  const keepOld = state.menuKind === 'result';

  if (!keepOld) {
    await deleteSavedMenu(ctx);
  }

  state.menuKind = 'text';
  userState.set(ctx.from.id, state);
  const message = await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: ui.decorateInline(replyMarkup)
  });
  await saveMenuMessage(ctx, message);
}

async function replaceMenuWithPhoto(ctx, photoPath, caption, replyMarkup) {
  const state = getUserState(ctx);
  const oldChatId = state.chatId;
  const oldMessageId = state.menuMessageId;
  const keepOld = state.menuKind === 'result';
  const asset = Object.values(photoAssets).find(item => item.path === photoPath);

  state.menuKind = 'logo';
  userState.set(ctx.from.id, state);

  const message = await replyWithCachedPhoto(ctx, photoPath, {
    caption,
    parse_mode: 'HTML',
    reply_markup: ui.decorateInline(replyMarkup)
  });

  if (asset) {
    await cachePhotoFileId(asset, message);
  }

  if (!keepOld) {
    await deleteMenuMessage(ctx, oldChatId, oldMessageId);
  }

  await saveMenuMessage(ctx, message);
}

// Результат — одно сообщение: картинка с подписью и кнопками. Экран ожидания под ней больше не нужен,
// поэтому он удаляется: в чате остаётся только то, что оператор заберёт.
async function sendResult(ctx, imageBuffer, { label, status = '✅ Готово', keyboard }) {
  const state = getUserState(ctx);
  const oldChatId = state.chatId;
  const oldMessageId = state.menuMessageId;
  const seconds = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const line = seconds > 0 ? `${status} · ${seconds.toFixed(1)} с` : status;

  state.startedAt = null;
  state.menuKind = 'result';
  userState.set(ctx.from.id, state);

  const message = await ctx.replyWithPhoto(
    { source: imageBuffer },
    {
      caption: formatHintRaw(label, line),
      parse_mode: 'HTML',
      reply_markup: ui.decorateInline(keyboard)
    }
  );

  await deleteMenuMessage(ctx, oldChatId, oldMessageId);
  await saveMenuMessage(ctx, message);

  return message;
}

async function showTemplateMenu(ctx, options = {}) {
  await deleteSteamChinaCodePrompt(ctx);

  const state = getUserState(ctx);
  state.template = null;
  state.status = 'choosing_template';
  state.staticScreen = null;
  state.lastFriendPageData = null;
  state.lastSteamChinaData = null;
  state.cs2Profile = null;
  state.addErrorMode = null;
  state.addErrorData = null;
  userState.set(ctx.from.id, state);

  if (options.deleteCommand) {
    await deleteIncomingMessage(ctx);
  }

  await replaceMenuWithPhoto(ctx, SILENTLOGO_PATH, formatHintRaw(MENU_LABEL, 'Выбери раздел.'), mainKeyboard());
}

async function selectTemplate(ctx, templateName) {
  await deleteSteamChinaCodePrompt(ctx);

  const state = getUserState(ctx);
  state.template = templateName;
  state.staticScreen = null;
  state.status = templateName === config.TEMPLATES.ADD_ERROR ? 'choosing_add_error_mode' : 'waiting_link';
  state.addErrorMode = null;
  state.addErrorData = null;
  state.lastFriendPageData = null;
  state.lastSteamChinaData = null;
  userState.set(ctx.from.id, state);

  await ctx.answerCbQuery();
  const menuText = formatTemplateHint(templateName, templatePrompt(templateName));

  if (templateName === config.TEMPLATES.FRIEND) {
    state.template = null;
    state.status = 'choosing_friend_variant';
    userState.set(ctx.from.id, state);

    await editMenu(
      ctx,
      formatHintRaw(FRIEND_LABEL, 'Как открывать страницу?'),
      friendVariantKeyboard()
    );
    return;
  }

  if (templateName === config.TEMPLATES.STEAM_CHINA) {
    await replaceMenuWithPhoto(ctx, FRIENDPAGE_EXAMPLE_PATH, menuText, waitingKeyboard(templateName));
    return;
  }

  if (templateName === config.TEMPLATES.ERROR) {
    await replaceMenuWithPhoto(ctx, BROWSERERROR_EXAMPLE_PATH, menuText, waitingKeyboard(templateName));
    return;
  }

  if (templateName === config.TEMPLATES.ADD_ERROR) {
    await editMenu(ctx, menuText, addErrorModeKeyboard());
    return;
  }

  await replaceMenu(ctx, menuText, waitingKeyboard(templateName));
}
async function selectAddErrorMode(ctx, mode) {
  const state = getUserState(ctx);
  await ctx.answerCbQuery();

  state.template = config.TEMPLATES.ADD_ERROR;
  state.addErrorMode = mode;
  state.addErrorData = null;
  state.addErrorFake = null;
  // Телефон начинается с фейка: он даёт верхнюю «залогиненную» часть страницы.
  state.status = mode === 'phone' ? 'waiting_add_error_fake' : 'waiting_add_error_kit';
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    formatTemplateHint(
      config.TEMPLATES.ADD_ERROR,
      mode === 'phone' ? 'Отправь ссылку на фейк.' : 'Отправь ссылку на профиль кита.',
      mode
    ),
    waitingKeyboard(config.TEMPLATES.ADD_ERROR)
  );
}

// Карточка проверки. Одна на пользователя: пример, три варианта, один верный. Пока пауза — вместо
// примера счётчик, чтобы ожидание не выглядело зависшим ботом.
const CAPTCHA_LABEL = '🧩 Проверка';
const CAPTCHA_RETRY = 'captcha_retry';

function cooldownText(left) {
  return `Слишком много попыток. Следующая через ${captcha.humanLeft(left)}.`;
}

// Карточка паузы правится на месте: оператор видит, сколько ждать, но в чате не появляется новых
// сообщений — сколько бы он ни нажимал.
async function refreshCooldownCard(ctx, left) {
  await editMenu(
    ctx,
    formatHint(CAPTCHA_LABEL, cooldownText(left)),
    { inline_keyboard: [[b('🔄 Проверить снова', CAPTCHA_RETRY)]] }
  );
}

async function showCaptcha(ctx) {
  const userId = ctx.from.id;
  const left = captcha.cooldownLeft(userId);

  if (left > 0) {
    await refreshCooldownCard(ctx, left);
    return;
  }

  const task = captcha.challenge(userId);
  const attempts = captcha.attemptsLeft(userId);
  const footer = attempts < captcha.MAX_WRONG
    ? 'Неверно. Осталась одна попытка.'
    : 'Реши пример, чтобы войти.';

  await editMenu(
    ctx,
    formatHint(CAPTCHA_LABEL, `${task.a} ${task.op} ${task.b} = ?\n${footer}`),
    {
      inline_keyboard: [
        task.options.map((value, index) => b(String(value), `captcha_${task.gen}_${index}`))
      ]
    }
  );
}

bot.action(/^captcha_(\d+)_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const left = captcha.cooldownLeft(userId);

  if (left > 0) {
    await ctx.answerCbQuery(cooldownText(left), { show_alert: true });
    return;
  }

  const result = captcha.submit(userId, Number(ctx.match[1]), Number(ctx.match[2]));

  if (result.status === 'ok') {
    captcha.verify(userId);
    await ctx.answerCbQuery('Проверка пройдена');
    await showTemplateMenu(ctx);
    return;
  }

  if (result.status === 'stale') {
    await ctx.answerCbQuery('Кнопка устарела, вот новая');
    await showCaptcha(ctx);
    return;
  }

  if (result.cooldown > 0) {
    await ctx.answerCbQuery(cooldownText(result.cooldown), { show_alert: true });
  } else {
    await ctx.answerCbQuery(`Неверно. Попыток осталось: ${result.attemptsLeft}`);
  }

  await showCaptcha(ctx);
});

bot.action(CAPTCHA_RETRY, async (ctx) => {
  const left = captcha.cooldownLeft(ctx.from.id);

  if (left > 0) {
    await ctx.answerCbQuery(cooldownText(left), { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();
  await showCaptcha(ctx);
});

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      queue: {
        active: requestQueue.getActiveCount(),
        waiting: requestQueue.getQueueLength()
      },
      browser: browserPool.getStats(),
      tracker: tracker.status(),
      captcha: captcha.stats()
    }));
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`Health server listening on :${HEALTH_PORT}`);
  });

  return server;
}

bot.start((ctx) => showTemplateMenu(ctx, { fresh: true, deleteCommand: true }));
bot.command('menu', (ctx) => showTemplateMenu(ctx, { fresh: true, deleteCommand: true }));
bot.command('tracker', (ctx) => {
  deleteIncomingMessage(ctx).catch(() => {});
  return showTracker(ctx);
});

// Пересланный премиум-эмодзи → его custom_emoji_id, чтобы заполнять data/ui.json без сторонних ботов.
bot.command('emoji', async (ctx) => {
  await deleteIncomingMessage(ctx);

  const ids = (ctx.message?.entities || [])
    .filter((entity) => entity.type === 'custom_emoji')
    .map((entity) => String(entity.custom_emoji_id || ''))
    .filter(Boolean);

  if (ids.length === 0) {
    await ctx.reply('Перешли премиум-эмодзи — отвечу его custom_emoji_id.');
    return;
  }

  await ctx.reply(
    'custom_emoji_id:\n' + ids.map((id) => `<code>${id}</code>`).join('\n'),
    { parse_mode: 'HTML' }
  );
});

bot.action('root_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showTemplateMenu(ctx);
});

// Раздел — это просто меню с другим набором кнопок; состояние обнуляется, чтобы «Ещё раз» из старого
// экрана не утащило в прежний шаблон. Заголовок приходит готовым HTML: в нём стоит <tg-emoji>.
async function showSection(ctx, titleHtml, text, keyboard) {
  const state = getUserState(ctx);
  state.template = null;
  state.staticScreen = null;
  state.status = 'choosing_template';
  state.addErrorMode = null;
  state.addErrorData = null;
  state.cs2Profile = null;
  userState.set(ctx.from.id, state);

  await editMenu(ctx, formatHintRaw(titleHtml, text), keyboard);
}

bot.action('section_profile', async (ctx) => {
  await ctx.answerCbQuery();
  await showSection(ctx, PROFILE_LABEL, 'Что собрать?', profileKeyboard());
});

bot.action('section_codes', async (ctx) => {
  await ctx.answerCbQuery();
  await showSection(ctx, CODES_LABEL, 'CS2 и D2.', codesKeyboard());
});

// «Ещё раз» возвращает тот же экран в состояние «ждём ссылку», не заставляя идти по меню заново.
bot.action('again', async (ctx) => {
  const state = getUserState(ctx);
  const template = state.template;

  // The delegated starter answers the callback itself; answering here as well would be a second answer
  // to the same query, which Telegram rejects.
  if (!template) {
    await ctx.answerCbQuery();

    if (state.staticScreen === 'dota_fake_code') {
      await sendDotaFakeCode(ctx);
      return;
    }

    await showTemplateMenu(ctx);
    return;
  }

  if (template === config.TEMPLATES.FRIEND || template === config.TEMPLATES.FRIEND_MOBILE) {
    await selectFriendVariant(ctx, template);
    return;
  }

  if (template === config.TEMPLATES.CS2_WRONG_CODE || template === config.TEMPLATES.CS2_NOT_FOUND || template === config.TEMPLATES.CS2_BAN) {
    await startCs2Flow(ctx, template);
    return;
  }

  if (template === config.TEMPLATES.DOTA_NOT_FOUND || template === config.TEMPLATES.DOTA_NOT_FRIENDS) {
    await startDotaFlow(ctx, template);
    return;
  }

  if (template === config.TEMPLATES.QR_FRIEND) {
    await ctx.answerCbQuery();

    state.status = 'waiting_qr_link';
    userState.set(ctx.from.id, state);
    await replaceMenu(
      ctx,
      formatTemplateHint(template, 'Отправь ссылку на фейк.'),
      waitingKeyboard(template)
    );
    return;
  }

  if (template === config.TEMPLATES.STEAM_NOTICE) {
    await ctx.answerCbQuery();
    await showSteamNoticePrompt(ctx, template);
    return;
  }

  if (template === config.TEMPLATES.ADD_ERROR && state.addErrorMode) {
    await ctx.answerCbQuery();

    state.status = 'waiting_link';
    userState.set(ctx.from.id, state);
    await editMenu(
      ctx,
      formatTemplateHint(template, templatePrompt(template), state.addErrorMode),
      waitingKeyboard(template)
    );
    return;
  }

  await selectTemplate(ctx, template);
});

bot.action('template_error', (ctx) => selectTemplate(ctx, config.TEMPLATES.ERROR));
bot.action('template_friend', (ctx) => selectTemplate(ctx, config.TEMPLATES.FRIEND));
bot.action('template_add_error', (ctx) => selectTemplate(ctx, config.TEMPLATES.ADD_ERROR));
bot.action('template_steam_china', (ctx) => selectTemplate(ctx, config.TEMPLATES.STEAM_CHINA));

async function selectFriendVariant(ctx, templateName) {
  const state = getUserState(ctx);
  await ctx.answerCbQuery();

  state.template = templateName;
  state.status = 'waiting_link';
  state.addErrorMode = null;
  state.addErrorData = null;
  state.lastFriendPageData = null;
  userState.set(ctx.from.id, state);

  await replaceMenuWithPhoto(
    ctx,
    FRIENDPAGE_EXAMPLE_PATH,
    formatTemplateHint(templateName, templatePrompt(templateName)),
    waitingKeyboard(templateName)
  );
}

bot.action('friend_variant_pc', (ctx) => selectFriendVariant(ctx, config.TEMPLATES.FRIEND));
bot.action('friend_variant_mobile', (ctx) => selectFriendVariant(ctx, config.TEMPLATES.FRIEND_MOBILE));

bot.action('qr_friend', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);
  state.template = config.TEMPLATES.QR_FRIEND;
  state.status = 'waiting_qr_link';
  state.addErrorMode = null;
  state.addErrorData = null;
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    formatTemplateHint(config.TEMPLATES.QR_FRIEND, 'Отправь ссылку на фейк.'),
    waitingKeyboard(config.TEMPLATES.QR_FRIEND)
  );
});

// Один вопрос — один экран: ссылка кита уходит и в адресную строку, и в само уведомление, поэтому
// подпись говорит это прямо, чтобы оператор не искал второе поле.
async function showSteamNoticePrompt(ctx, templateName) {
  const state = getUserState(ctx);
  state.template = templateName;
  state.status = 'waiting_notice_link';
  state.addErrorMode = null;
  state.addErrorData = null;
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    formatTemplateHint(templateName, 'Отправь френдлинк кита — встанет в адрес и в уведомление.'),
    waitingKeyboard(templateName)
  );
}

bot.action('template_steam_notice', async (ctx) => {
  await ctx.answerCbQuery();
  await showSteamNoticePrompt(ctx, config.TEMPLATES.STEAM_NOTICE);
});
bot.action('add_error_profile', (ctx) => selectAddErrorMode(ctx, 'profile'));
bot.action('add_error_friendlink', (ctx) => selectAddErrorMode(ctx, 'friendlink'));
bot.action('add_error_phone', (ctx) => selectAddErrorMode(ctx, 'phone'));

async function startCs2Flow(ctx, templateName) {
  const state = getUserState(ctx);
  await ctx.answerCbQuery();

  state.template = templateName;
  state.status = 'waiting_cs2_link';
  state.cs2Profile = null;
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    formatTemplateHint(templateName, 'Отправь ссылку на фэйк.'),
    waitingKeyboard(templateName)
  );
}

bot.action('cs2_menu', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);
  state.template = null;
  state.status = 'choosing_cs2_template';
  state.cs2Profile = null;
  userState.set(ctx.from.id, state);

  await editMenu(ctx, formatHintRaw(CODES_LABEL + ' · CS2', 'Выбери экран.'), cs2Keyboard());
});

bot.action('cs2_fake_code', (ctx) => startCs2Flow(ctx, config.TEMPLATES.CS2_WRONG_CODE));
bot.action('cs2_not_found', (ctx) => startCs2Flow(ctx, config.TEMPLATES.CS2_NOT_FOUND));
bot.action('cs2_ban', (ctx) => startCs2Flow(ctx, config.TEMPLATES.CS2_BAN));

async function startDotaFlow(ctx, templateName) {
  const state = getUserState(ctx);
  await ctx.answerCbQuery();

  state.template = templateName;
  state.status = 'waiting_dota_code';
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    formatTemplateHint(templateName, 'Отправь френд-код друга.'),
    waitingKeyboard(templateName)
  );
}

bot.action('dota_menu', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);
  state.template = null;
  state.status = 'choosing_dota_template';
  userState.set(ctx.from.id, state);

  await editMenu(ctx, formatHintRaw(CODES_LABEL + ' · D2', 'Выбери экран.'), dotaKeyboard());
});

bot.action('dota_not_found', (ctx) => startDotaFlow(ctx, config.TEMPLATES.DOTA_NOT_FOUND));
bot.action('dota_not_friends', (ctx) => startDotaFlow(ctx, config.TEMPLATES.DOTA_NOT_FRIENDS));

// Nothing to render: the screen is a finished picture. Sent as a buffer, so the bot does not depend on
// a file_id it has never seen. Kept as a named function: «Ещё раз» on the result replays exactly this.
async function sendDotaFakeCode(ctx) {
  const state = getUserState(ctx);
  state.staticScreen = 'dota_fake_code';
  userState.set(ctx.from.id, state);

  let buffer;

  try {
    buffer = await fs.readFile(DOTA_FAKE_CODE_PATH);
  } catch {
    await editMenu(
      ctx,
      formatHintRaw(D2_FAKE_CODE_LABEL, 'Файл assets/dota_fake_code.png не найден на сервере.'),
      dotaKeyboard()
    );
    return;
  }

  await sendResult(ctx, buffer, {
    label: D2_FAKE_CODE_LABEL,
    keyboard: resultTemplateKeyboard(config.TEMPLATES.DOTA_NOT_FOUND)
  });
}

bot.action('dota_fake_code', async (ctx) => {
  await ctx.answerCbQuery();
  await sendDotaFakeCode(ctx);
});

/* ---------- tracker ---------- */

function trackerHint(text) {
  return formatHintRaw(TRACKER_LABEL, text);
}

function trackerMenuText(ctx) {
  const profiles = tracker.listProfiles(ctx.from.id);
  const notifyOn = tracker.notifyEnabled(ctx.from.id);

  return trackerHint(
    [
      `Профилей: ${profiles.length} из ${tracker.MAX_PER_USER}.`,
      `Уведомления: ${notifyOn ? 'включены' : 'выключены'}.`,
      'Слежу за оффлайном, онлайном и игрой.'
    ].join('\n')
  );
}

function trackerCardText(profile, steamId, tail) {
  return formatHintRaw(
    `${TRACKER_LABEL} · ${escapeHtml(profile.name || steamId)}`,
    [trackerStatusLabel(profile), `SteamID: ${steamId}`, tail].filter(Boolean).join('\n')
  );
}

function trackerConfirmKeyboard() {
  return {
    inline_keyboard: [
      [b('✅ Следить', 'tracker_confirm')],
      [b('← Назад', 'tracker_menu')]
    ]
  };
}

async function showTracker(ctx) {
  const state = getUserState(ctx);
  state.template = null;
  state.status = 'tracker_menu';
  state.trackerCandidate = null;
  userState.set(ctx.from.id, state);

  await editMenu(ctx, trackerMenuText(ctx), trackerKeyboard(tracker.notifyEnabled(ctx.from.id)));
}

bot.action('tracker_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showTracker(ctx);
});

bot.action('tracker_notify', async (ctx) => {
  await ctx.answerCbQuery();

  const next = await tracker.setNotify(ctx.from.id, !tracker.notifyEnabled(ctx.from.id));

  await editMenu(ctx, trackerMenuText(ctx), trackerKeyboard(next));
});

bot.action('tracker_add', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);
  state.status = 'tracker_waiting_link';
  state.trackerCandidate = null;
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    trackerHint('Отправь ссылку на профиль Steam или SteamID64.'),
    { inline_keyboard: [[b('✖️ Отмена', 'tracker_menu')]] }
  );
});

bot.action('tracker_list', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);
  state.status = 'tracker_menu';
  state.trackerCandidate = null;
  userState.set(ctx.from.id, state);

  const profiles = tracker.listProfiles(ctx.from.id);

  if (profiles.length === 0) {
    await editMenu(
      ctx,
      trackerHint( 'Пока пусто. Добавь профиль, чтобы следить за ним.'),
      trackerKeyboard(tracker.notifyEnabled(ctx.from.id))
    );
    return;
  }

  await editMenu(
    ctx,
    trackerHint( `Профилей: ${profiles.length}. Выбери, чтобы открыть.`),
    trackerListKeyboard(profiles)
  );
});

bot.action(/^tracker_open_(7656119[0-9]{10})$/, async (ctx) => {
  await ctx.answerCbQuery();

  const steamId = ctx.match[1];
  const profile = tracker.listProfiles(ctx.from.id).find((item) => item.steamId === steamId);

  if (!profile) {
    await showTracker(ctx);
    return;
  }

  await editMenu(ctx, trackerCardText(profile, steamId), trackerProfileKeyboard(steamId));
});

bot.action(/^tracker_refresh_(7656119[0-9]{10})$/, async (ctx) => {
  await ctx.answerCbQuery();

  const steamId = ctx.match[1];

  // A manual refresh runs the same pass the timer runs, so the stored state moves too: otherwise the
  // card shows a fresh status and the list behind it keeps the old one.
  await tracker.pollOnce().catch((error) => {
    console.warn(`tracker: manual refresh failed (${error.message})`);
  });

  const stored = tracker.listProfiles(ctx.from.id).find((item) => item.steamId === steamId);

  if (!stored) {
    await showTracker(ctx);
    return;
  }

  const fresh = await tracker.freshStatus(steamId).catch(() => null);
  const profile = fresh ? { ...stored, ...fresh } : stored;

  await editMenu(
    ctx,
    trackerCardText(profile, steamId) + (fresh ? '' : '\n\nSteam не ответил, показан последний известный статус.'),
    trackerProfileKeyboard(steamId)
  );
});

bot.action(/^tracker_remove_(7656119[0-9]{10})$/, async (ctx) => {
  await ctx.answerCbQuery();

  await tracker.removeProfile(ctx.from.id, ctx.match[1]);

  const state = getUserState(ctx);
  state.status = 'tracker_menu';
  state.trackerCandidate = null;
  userState.set(ctx.from.id, state);

  await editMenu(ctx, trackerHint( 'Профиль удалён из списка.'), trackerKeyboard(tracker.notifyEnabled(ctx.from.id)));
});

bot.action('tracker_confirm', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);
  const steamId = state.trackerCandidate;

  if (!steamId) {
    await showTracker(ctx);
    return;
  }

  let status = null;
  let failure = '';

  try {
    status = await tracker.freshStatus(steamId);
  } catch (error) {
    failure = String(error?.message || error);
  }

  if (!status) {
    await editMenu(
      ctx,
      trackerHint(
        failure.includes('is not set')
          ? 'На сервере не задан STEAM_WEB_API_KEY.'
          : 'Steam не ответил. Попробуй добавить ещё раз.'
      ),
      trackerKeyboard(tracker.notifyEnabled(ctx.from.id))
    );
    return;
  }

  const result = await tracker.addProfile(ctx.from.id, steamId, status);

  if (!result.ok) {
    const reason =
      result.reason === 'limit_user'
        ? `Уже ${tracker.MAX_PER_USER} профилей — больше не добавлю.`
        : result.reason === 'limit_total'
          ? 'Общий лимит бота исчерпан.'
          : 'Этот профиль уже в списке.';

    await editMenu(
      ctx,
      trackerHint( reason),
      trackerKeyboard(tracker.notifyEnabled(ctx.from.id))
    );
    return;
  }

  state.status = 'tracker_menu';
  state.trackerCandidate = null;
  userState.set(ctx.from.id, state);

  await editMenu(
    ctx,
    trackerHint( `Слежу за ${status.name || steamId}. Уведомления придут в этот чат.`),
    trackerKeyboard(tracker.notifyEnabled(ctx.from.id))
  );
});

// One message per real change, to everyone who follows that profile and has notifications on.
function trackerChangeText(change) {
  const name = escapeHtml(change.to.name || change.steamId);
  const game = escapeHtml(change.to.game || '');

  if (change.to.status === tracker.STATE_INGAME) {
    if (change.from.status === tracker.STATE_INGAME && change.from.game !== change.to.game) {
      return `🎮 <b>${name}</b> теперь играет в <b>${game}</b>`;
    }

    return `🎮 <b>${name}</b> начал играть в <b>${game}</b>`;
  }

  if (change.to.status === tracker.STATE_ONLINE) {
    return `🟢 <b>${name}</b> в сети`;
  }

  return `⚫ <b>${name}</b> вышел из сети`;
}

async function handleTrackerChanges(changes) {
  for (const change of changes) {
    const text = trackerChangeText(change);

    for (const subscriber of tracker.subscribersOf(change.steamId)) {
      if (!subscriber.notify) {
        continue;
      }

      await bot.telegram.sendMessage(subscriber.userId, text, { parse_mode: 'HTML' }).catch((error) => {
        console.warn(`tracker: message to ${subscriber.userId} failed (${error.description || error.message})`);
      });
    }
  }
}


// Renders one ban screen and leaves the durations on screen, so the operator can try another value
// without walking the whole flow again.
async function applyCs2Ban(ctx, banText) {
  const state = getUserState(ctx);

  if (state.template !== config.TEMPLATES.CS2_BAN || !state.cs2Profile) {
    state.status = 'waiting_cs2_link';
    userState.set(ctx.from.id, state);
    await replaceMenu(ctx, formatStateHint(state, 'Сначала отправь ссылку на фэйк.'), errorKeyboard(state.template));
    return;
  }

  let progressMessage;

  try {
    state.status = 'processing_cs2_ban';
    userState.set(ctx.from.id, state);

    progressMessage = await sendProgressMessage(ctx, `Ставлю ${banText}…`);

    const taskId = `${ctx.from.id}_cs2_ban_${Date.now()}`;
    const imageBuffer = await requestQueue.add(taskId, () =>
      processCs2Request(config.TEMPLATES.CS2_BAN, state.cs2Profile.sentUrl, { banText })
    );

    await deleteProgressMessage(ctx, progressMessage);

    state.status = 'choosing_cs2_ban';
    userState.set(ctx.from.id, state);

    // Время бана остаётся на кнопках: ту же ссылку можно прогнать другим сроком, не возвращаясь в меню.
    await sendResult(ctx, imageBuffer, {
      label: screenTitle(state.template, state.addErrorMode),
      status: `⛔ ${banText}`,
      keyboard: cs2BanKeyboard()
    });
  } catch (error) {
    console.error('CS2 ban request error:', error);
    await deleteProgressMessage(ctx, progressMessage);

    state.status = 'choosing_cs2_ban';
    userState.set(ctx.from.id, state);

    const missing = /Template not found/i.test(String(error?.message || ''));
    await replaceMenu(
      ctx,
      formatStateHint(
        state,
        missing
          ? 'Экран CS2 Ban ещё не загружен на сервер: нет templates/cs2_ban.html.'
          : 'Не удалось собрать изображение. Выбери время ещё раз.'
      ),
      cs2BanKeyboard()
    );
  }
}

for (const [key, label] of Object.entries(CS2_BAN_DURATIONS)) {
  bot.action(`cs2b_${key}`, async (ctx) => {
    await ctx.answerCbQuery();
    await applyCs2Ban(ctx, label);
  });
}

bot.action('cs2b_custom', async (ctx) => {
  await ctx.answerCbQuery();

  const state = getUserState(ctx);

  if (state.template !== config.TEMPLATES.CS2_BAN || !state.cs2Profile) {
    state.status = 'waiting_cs2_link';
    userState.set(ctx.from.id, state);
    await replaceMenu(ctx, formatStateHint(state, 'Сначала отправь ссылку на фэйк.'), errorKeyboard(state.template));
    return;
  }

  state.status = 'waiting_cs2_ban_text';
  userState.set(ctx.from.id, state);

  await replaceMenu(
    ctx,
    formatStateHint(state, 'Напиши текст бана — он встанет на место времени.'),
    cs2BanKeyboard()
  );
});

bot.action('add_friend_code', async (ctx) => {
  const state = getUserState(ctx);
  await ctx.answerCbQuery();

  if (!state.lastFriendPageData) {
    state.status = 'waiting_link';
    userState.set(ctx.from.id, state);
    await editMenu(
      ctx,
      formatStateHint(state, 'Сначала отправь ссылку для обработки.'),
      errorKeyboard(state.template)
    );
    return;
  }

  state.status = 'waiting_friend_code';
  userState.set(ctx.from.id, state);
  await editMenu(
    ctx,
    formatStateHint(state, 'Отправь код друга цифрами.'),
    waitingKeyboard(state.template)
  );
});

bot.on('text', async (ctx) => {
  const url = ctx.message.text.trim();
  const state = getUserState(ctx);

  if (url.startsWith('/')) {
    await deleteIncomingMessage(ctx);
    return showTemplateMenu(ctx, { fresh: true });
  }

  if (state.status === 'waiting_cs2_link') {
    if (!isCs2Template(state.template)) {
      state.status = 'choosing_cs2_template';
      userState.set(ctx.from.id, state);
      await editMenu(ctx, formatHintRaw(CODES_LABEL + ' · CS2', 'Выбери экран.'), cs2Keyboard());
      return;
    }

    try {
      await assertPublicHttpUrl(url);
    } catch {
      await editMenu(
        ctx,
        formatStateHint(state, 'Отправь действующий http/https адрес.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_cs2_link';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Собираю изображение…');

      const taskId = `${ctx.from.id}_cs2_link_${Date.now()}`;

      // The ban screen asks for the duration next: the link is only the identity, and the duration is
      // picked from a keyboard on the message that follows.
      if (state.template === config.TEMPLATES.CS2_BAN) {
        const profile = await requestQueue.add(taskId, () => loadCs2Profile(url));

        await deleteProgressMessage(ctx, progressMessage);

        state.status = 'choosing_cs2_ban';
        state.cs2Profile = profile;
        userState.set(ctx.from.id, state);

        await replaceMenu(ctx, formatStateHint(state, 'Выберите время бана:'), cs2BanKeyboard());
        return;
      }

      // This screen carries the friend code, so the link is only the first half: keep the profile and
      // ask for the code instead of rendering right away.
      if (state.template === config.TEMPLATES.CS2_NOT_FOUND) {
        const profile = await requestQueue.add(taskId, () => loadCs2Profile(url));

        await deleteProgressMessage(ctx, progressMessage);

        state.status = 'waiting_cs2_code';
        state.cs2Profile = profile;
        userState.set(ctx.from.id, state);

        // A fresh message, not an edit of the link prompt: the question changed from "send a link" to
        // "send a code", and an edited caption reads as if nothing happened.
        await replaceMenu(ctx, formatStateHint(state, 'Отправь френд-код кита.'), waitingKeyboard(state.template));
        return;
      }

      const imageBuffer = await requestQueue.add(taskId, () =>
        processCs2Request(config.TEMPLATES.CS2_WRONG_CODE, url)
      );

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_cs2_link';
      state.cs2Profile = null;
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        keyboard: resultTemplateKeyboard(state.template)
      });
    } catch (error) {
      console.error('CS2 link request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_cs2_link';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatStateHint(state, 'Не удалось обработать ссылку. Отправь ссылку ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  if (state.status === 'waiting_cs2_code') {
    const friendCode = url.replace(/\s+/g, '').toUpperCase();

    if (!/^[A-Z0-9-]{3,32}$/.test(friendCode)) {
      await editMenu(ctx, formatStateHint(state, 'Отправь код вида ABCDE-FGHI.'), waitingKeyboard(state.template));
      return;
    }

    if (!state.cs2Profile) {
      state.status = 'waiting_cs2_link';
      userState.set(ctx.from.id, state);
      await editMenu(ctx, formatStateHint(state, 'Сначала отправь ссылку на фэйк.'), errorKeyboard(state.template));
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_cs2_code';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, `Добавляю код ${friendCode}…`);

      const taskId = `${ctx.from.id}_cs2_code_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () =>
        processCs2Request(config.TEMPLATES.CS2_NOT_FOUND, state.cs2Profile.sentUrl, { friendCode })
      );

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_cs2_link';
      state.cs2Profile = null;
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        keyboard: resultTemplateKeyboard(state.template)
      });
    } catch (error) {
      console.error('CS2 code request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_cs2_code';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatStateHint(state, 'Не удалось собрать изображение. Отправь код ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  if (state.status === 'waiting_add_error_code') {
    const code = url.replace(/\s+/g, '').trim();

    if (!/^[A-Za-z0-9_-]{2,32}$/.test(code)) {
      await replaceMenu(
        ctx,
        formatStateHint(state, 'Отправь френд-код: цифры или буквы, до 32 символов.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    if (!state.addErrorData) {
      state.status = 'waiting_link';
      userState.set(ctx.from.id, state);
      await editMenu(
        ctx,
        formatStateHint(state, 'Сначала отправь ссылку на фейк.'),
        errorKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_add_error_code';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, `Ставлю код ${code}…`);

      const taskId = `${ctx.from.id}_add_error_code_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () =>
        processAddErrorPhone(state.addErrorData, state.addErrorFake || {}, code)
      );

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_link';
      state.addErrorData = null;
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        status: `✅ Код ${code} принят`,
        keyboard: resultTemplateKeyboard(state.template)
      });
    } catch (error) {
      console.error('Add-error phone code error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_add_error_code';
      userState.set(ctx.from.id, state);

      await replaceMenu(
        ctx,
        formatStateHint(state, 'Не удалось собрать изображение. Отправь код ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  if (state.status === 'waiting_qr_link') {
    try {
      await assertPublicHttpUrl(url);
    } catch {
      await editMenu(
        ctx,
        formatTemplateHint(config.TEMPLATES.QR_FRIEND, 'Отправь действующий http/https адрес.'),
        waitingKeyboard(config.TEMPLATES.QR_FRIEND)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_qr';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Собираю QR-страницу…');

      const taskId = `${ctx.from.id}_qr_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () => processQrFriendRequest(url));

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_qr_link';
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(config.TEMPLATES.QR_FRIEND),
        keyboard: resultTemplateKeyboard(config.TEMPLATES.QR_FRIEND)
      });
    } catch (error) {
      console.error('QR friend request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_qr_link';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatTemplateHint(config.TEMPLATES.QR_FRIEND, 'Не удалось собрать изображение. Отправь ссылку ещё раз.'),
        errorKeyboard(config.TEMPLATES.QR_FRIEND)
      );
    }

    return;
  }

  if (state.status === 'waiting_notice_link') {
    await deleteIncomingMessage(ctx);

    const raw = url.trim();
    const link = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

    // Ссылка никуда не запрашивается, она только рисуется: хватает проверки синтаксиса. DNS здесь был бы
    // лишним — китайские и приватные короткие домены с сервера видны не всегда.
    try {
      parseHttpUrl(link);
    } catch {
      await editMenu(
        ctx,
        formatTemplateHint(state.template, 'Это не ссылка. Нужен адрес, начиная с http:// или https://.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_notice';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Собираю изображение…');

      const taskId = `${ctx.from.id}_notice_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () => processSteamNoticeRequest(link));

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_notice_link';
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        status: '✅ Ссылка встала в два места',
        keyboard: resultTemplateKeyboard(state.template)
      });
    } catch (error) {
      console.error('Steam notice request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_notice_link';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatTemplateHint(state.template, 'Не удалось собрать изображение. Отправь ссылку ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  if (state.status === 'tracker_waiting_link') {
    await deleteIncomingMessage(ctx);

    let steamId = '';

    try {
      steamId = await tracker.resolveProfileInput(url);
    } catch (error) {
      console.warn(`tracker: resolve failed (${error.message})`);
    }

    if (!steamId) {
      await editMenu(
        ctx,
        trackerHint(
          'Не нашёл такой профиль. Отправь ссылку steamcommunity.com/profiles/… или SteamID64.'
        ),
        trackerKeyboard(tracker.notifyEnabled(ctx.from.id))
      );
      return;
    }

    if (tracker.listProfiles(ctx.from.id).some((profile) => profile.steamId === steamId)) {
      await editMenu(
        ctx,
        trackerHint( 'Этот профиль уже в списке.'),
        trackerProfileKeyboard(steamId)
      );
      return;
    }

    let status = null;
    let failure = '';

    try {
      status = await tracker.freshStatus(steamId);
    } catch (error) {
      failure = String(error?.message || error);
    }

    if (!status) {
      const reason = failure.includes('is not set')
        ? 'На сервере не задан STEAM_WEB_API_KEY — статус недоступен.'
        : /HTTP 40[13]/.test(failure)
          ? 'Steam отверг ключ API. Проверь STEAM_WEB_API_KEY.'
          : failure.startsWith('Steam API')
            ? `Steam ответил ошибкой: ${failure}.`
            : 'Профиль не найден: SteamID неверный или профиль скрыт.';

      await editMenu(
        ctx,
        trackerHint( reason),
        trackerKeyboard(tracker.notifyEnabled(ctx.from.id))
      );
      return;
    }

    state.trackerCandidate = steamId;
    state.status = 'tracker_confirm';
    userState.set(ctx.from.id, state);

    await editMenu(
      ctx,
      trackerCardText(status, steamId, 'Следить за ним?'),
      trackerConfirmKeyboard()
    );
    return;
  }

  if (state.status === 'waiting_dota_code') {
    if (!isDotaTemplate(state.template)) {
      state.status = 'choosing_dota_template';
      userState.set(ctx.from.id, state);
      await editMenu(ctx, formatHintRaw(CODES_LABEL + ' · D2', 'Выбери экран.'), dotaKeyboard());
      return;
    }

    const friendCode = url.replace(/\s+/g, '').trim();

    if (!/^[A-Za-z0-9_-]{2,32}$/.test(friendCode)) {
      await editMenu(
        ctx,
        formatStateHint(state, 'Отправь френд-код: цифры или буквы, до 32 символов.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_dota_code';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Собираю изображение…');

      const taskId = `${ctx.from.id}_dota_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () =>
        processDotaRequest(state.template, friendCode)
      );

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_dota_code';
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        keyboard: resultTemplateKeyboard(state.template)
      });
    } catch (error) {
      console.error('Dota request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_dota_code';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatStateHint(state, 'Не удалось собрать изображение. Отправь код ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  if (state.status === 'waiting_cs2_ban_text') {
    const banText = url.replace(/\s+/g, ' ').trim().slice(0, 48);

    if (banText === '') {
      await replaceMenu(
        ctx,
        formatStateHint(state, 'Напиши текст бана — он встанет на место времени.'),
        cs2BanKeyboard()
      );
      return;
    }

    await applyCs2Ban(ctx, banText);
    return;
  }

  if (state.status === 'waiting_steam_china_code') {
    const friendCodeInput = url.replace(/\s+/g, '');

    if (!/^\d{1,32}$/.test(friendCodeInput)) {
      await sendSteamChinaCodePrompt(ctx, 'Отправь код друга только цифрами.');
      return;
    }

    await deleteSteamChinaCodePrompt(ctx);

    if (!state.lastSteamChinaData) {
      state.status = 'waiting_link';
      userState.set(ctx.from.id, state);
      await editMenu(
        ctx,
        formatStateHint(state, 'Сначала отправь ссылку на фейк.'),
        errorKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_steam_china_code';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Добавляю код друга…');

      const taskId = `${ctx.from.id}_steam_china_code_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () =>
        processFriendCodeRequest(state.lastSteamChinaData, friendCodeInput, config.TEMPLATES.STEAM_CHINA)
      );

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_link';
      state.lastSteamChinaData = null;
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        keyboard: resultTemplateKeyboard(state.template)
      });
    } catch (error) {
      console.error('Steam China code request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_steam_china_code';
      userState.set(ctx.from.id, state);
      await sendSteamChinaCodePrompt(ctx, 'Ошибка при добавлении кода. Отправь код друга цифрами еще раз.');
    }

    return;
  }

  if (state.status === 'waiting_friend_code') {
    const friendCodeInput = url.replace(/\s+/g, '');

    if (!/^\d{1,32}$/.test(friendCodeInput)) {
      await editMenu(
        ctx,
        formatStateHint(state, 'Отправь код друга только цифрами.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    if (!state.lastFriendPageData) {
      state.status = 'waiting_link';
      userState.set(ctx.from.id, state);
      await editMenu(
        ctx,
        formatStateHint(state, 'Сначала отправь ссылку для обработки.'),
        errorKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_friend_code';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Добавляю код друга…');

      const taskId = `${ctx.from.id}_friend_code_${Date.now()}`;
      const imageBuffer = await requestQueue.add(taskId, () =>
        processFriendCodeRequest(state.lastFriendPageData, friendCodeInput, state.template)
      );

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_link';
      userState.set(ctx.from.id, state);

      await sendResult(ctx, imageBuffer, {
        label: screenTitle(state.template, state.addErrorMode),
        keyboard: resultTemplateKeyboard(state.template, true)
      });
    } catch (error) {
      console.error('Friend code request error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_friend_code';
      userState.set(ctx.from.id, state);
      await editMenu(
        ctx,
        formatStateHint(state, 'Ошибка при добавлении кода. Отправь код друга цифрами еще раз.'),
        waitingKeyboard(state.template)
      );
    }

    return;
  }

  if (!state?.template) {
    state.status = 'choosing_template';
    userState.set(ctx.from.id, state);
    await ctx.reply(formatHintRaw(MENU_LABEL, 'Сначала выбери раздел.'), { parse_mode: 'HTML' });
    return;
  }

  // Фейк нужен в двух местах: телефону — первым (он даёт верх страницы), профилю и френдлинку —
  // вторым (там он даёт шапку «мы в аккаунте»).
  if (state.status === 'waiting_add_error_fake') {
    try {
      await assertPublicHttpUrl(url);
    } catch {
      await editMenu(
        ctx,
        formatStateHint(state, 'Отправь корректную http/https ссылку.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_add_error_fake';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Читаю профиль…');

      const taskId = `${ctx.from.id}_add_error_fake_${Date.now()}`;
      const fakeData = await requestQueue.add(taskId, () => loadFriendPageData(url));

      await deleteProgressMessage(ctx, progressMessage);

      state.addErrorFake = fakeData;
      userState.set(ctx.from.id, state);

      // Кит ещё не прислан — значит это телефон, идём дальше по его цепочке.
      if (!state.addErrorData) {
        state.status = 'waiting_add_error_kit';
        userState.set(ctx.from.id, state);

        await replaceMenu(
          ctx,
          formatStateHint(state, 'Теперь ссылку на профиль кита.'),
          waitingKeyboard(state.template)
        );
        return;
      }

      // Кит уже прочитан: профиль и френдлинк собираются сразу.
      await renderAddErrorPage(ctx, state);
    } catch (error) {
      console.error('Add-error fake link error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_add_error_fake';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatStateHint(state, 'Не удалось прочитать профиль. Отправь ссылку ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  // Кит: для телефона это второй шаг, для профиля и френдлинка — первый.
  if (state.status === 'waiting_add_error_kit') {
    try {
      await assertPublicHttpUrl(url);
    } catch {
      await editMenu(
        ctx,
        formatStateHint(state, 'Отправь корректную http/https ссылку.'),
        waitingKeyboard(state.template)
      );
      return;
    }

    let progressMessage;

    try {
      state.status = 'processing_add_error_kit';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Читаю профиль…');

      const taskId = `${ctx.from.id}_add_error_kit_${Date.now()}`;
      const kitData = await requestQueue.add(taskId, () => loadFriendPageData(url));

      await deleteProgressMessage(ctx, progressMessage);

      state.addErrorData = kitData;
      userState.set(ctx.from.id, state);

      if (state.addErrorMode === 'phone') {
        state.status = 'waiting_add_error_code';
        userState.set(ctx.from.id, state);

        await replaceMenu(
          ctx,
          formatStateHint(state, 'Отправь френд-код кита, который не приняли.'),
          waitingKeyboard(state.template)
        );
        return;
      }

      state.status = 'waiting_add_error_fake';
      userState.set(ctx.from.id, state);

      await replaceMenu(
        ctx,
        formatStateHint(state, 'Теперь ссылку на фейк — с него возьму шапку аккаунта.'),
        waitingKeyboard(state.template)
      );
    } catch (error) {
      console.error('Add-error kit link error:', error);
      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_add_error_kit';
      userState.set(ctx.from.id, state);

      await editMenu(
        ctx,
        formatStateHint(state, 'Не удалось прочитать профиль. Отправь ссылку ещё раз.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  if (
    state.template === config.TEMPLATES.ADD_ERROR &&
    !['profile', 'friendlink', 'phone'].includes(state.addErrorMode)
  ) {
    state.status = 'choosing_add_error_mode';
    userState.set(ctx.from.id, state);
    await editMenu(
      ctx,
      formatStateHint(state, 'Сначала выбери тип ссылки.'),
      addErrorModeKeyboard()
    );
    return;
  }

  try {
    if (state.template === config.TEMPLATES.ERROR) {
      parseHttpUrl(url);
    } else {
      await assertPublicHttpUrl(url);
    }
  } catch {
    state.status = 'waiting_link';
    userState.set(ctx.from.id, state);
    return editMenu(
      ctx,
      formatStateHint(state, 'Отправь корректную http/https ссылку.'),
      waitingKeyboard(state.template)
    );
  }

  if (state.template === config.TEMPLATES.STEAM_CHINA) {
    let progressMessage;

    try {
      state.status = 'processing_steam_china_link';
      userState.set(ctx.from.id, state);

      progressMessage = await sendProgressMessage(ctx, 'Читаю профиль…');

      const taskId = `${ctx.from.id}_steam_china_link_${Date.now()}`;
      const pageData = await requestQueue.add(taskId, () => loadFriendPageData(url));

      await deleteProgressMessage(ctx, progressMessage);

      state.status = 'waiting_steam_china_code';
      state.lastSteamChinaData = pageData;
      userState.set(ctx.from.id, state);
      await sendSteamChinaCodePrompt(ctx, 'Отправь код друга цифрами.');
    } catch (error) {
      console.error('Steam China link request error:', error);
      await deleteProgressMessage(ctx, progressMessage);
      state.status = 'waiting_link';
      state.lastSteamChinaData = null;
      userState.set(ctx.from.id, state);
      await editMenu(
        ctx,
        formatStateHint(state, 'Ошибка при обработке страницы. Отправь другую ссылку.'),
        errorKeyboard(state.template)
      );
    }

    return;
  }

  let progressMessage;

  try {
    state.status = 'processing';
    userState.set(ctx.from.id, state);

    progressMessage = await sendProgressMessage(ctx, 'Читаю профиль…');

    const taskId = `${ctx.from.id}_${Date.now()}`;
    const { imageBuffer, pageData } = await requestQueue.add(taskId, () =>
      processRequest(url, state.template, { addErrorMode: state.addErrorMode })
    );

    await deleteProgressMessage(ctx, progressMessage);

    state.status = 'waiting_link';
    state.lastFriendPageData = isFriendPageTemplate(state.template) ? pageData : null;
    userState.set(ctx.from.id, state);

    await sendResult(ctx, imageBuffer, {
      label: screenTitle(state.template, state.addErrorMode),
      keyboard: resultTemplateKeyboard(state.template, Boolean(state.lastFriendPageData))
    });
  } catch (error) {
    console.error('Request error:', error);
    await deleteProgressMessage(ctx, progressMessage);

    state.status = 'waiting_link';
    userState.set(ctx.from.id, state);
    await editMenu(
      ctx,
      formatStateHint(state, 'Ошибка при обработке страницы. Отправь другую ссылку для обработки.'),
      errorKeyboard(state.template)
    );
  }
});

let healthServer;

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  tracker.stop();
  bot.stop(signal);

  // Капча пишет состояние сразу, но последняя запись могла быть в полёте: дожидаемся её до выхода,
  // иначе только что пройденная проверка потеряется при рестарте.
  await captcha.flush().catch(() => {});
  await browserPool.close();

  if (healthServer) {
    await new Promise(resolve => healthServer.close(resolve));
  }

  process.exit(0);
}

async function main() {
  await browserPool.init();
  await tracker.load();

  // The poller is started before the Telegram launch on purpose: launch() resolves when long polling is
  // up, and a slow or retrying launch must not hold the tracker back.
  tracker.start(handleTrackerChanges);

  await Promise.all(Object.values(photoAssets).map(asset => warmupPhotoAsset(asset))).catch(error => {
    console.warn('Failed to warm up menu photos:', error.message);
  });
  healthServer = startHealthServer();
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Открыть меню' },
    { command: 'menu', description: 'Вернуться в меню' },
    { command: 'tracker', description: 'Трекер профилей' },
    { command: 'emoji', description: 'ID пересланного премиум-эмодзи' }
  ]).catch(error => {
    console.warn('Failed to set bot commands:', error.description || error.message);
  });
  await bot.launch({ dropPendingUpdates: true });
  console.log('Bot started');
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

if (process.env.SKIP_MAIN !== '1') {
  main().catch(err => {
    console.error('Failed to start bot:', err);
    process.exit(1);
  });
}

