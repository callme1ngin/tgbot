// scripts/bundle-friendpage.js — two friend pages, one build step.
//
//   friendpage        → templates/friendpage.bundle.html          (desktop / web)
//   friendpage-mobile → templates/friendpage-mobile.bundle.html    (phone mockup)
//
// Assets referenced from disk are inlined as data URIs, so a bundle is one self-contained file the bot
// can setContent() without a base path. The desktop page has its scripts stripped: it is a static
// picture. The phone page keeps its script — renderSteamFriend() is the whole point there.
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const templatesDir = path.join(rootDir, 'templates');

const mimeTypes = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const jobs = [
  {
    name: 'friendpage',
    sourceDir: path.join(rootDir, 'template-sources', 'friendpage'),
    input: 'friendpage.html',
    output: 'friendpage.bundle.html',
    stripScripts: true
  },
  {
    name: 'friendpage-mobile',
    sourceDir: path.join(rootDir, 'template-sources', 'friendpage-mobile'),
    input: 'friendpage-mobile.html',
    output: 'friendpage-mobile.bundle.html',
    stripScripts: false
  }
];

function getMimeType(filePath) {
  return mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function normalizeAssetUrl(url) {
  return url.split('#')[0].split('?')[0];
}

function shouldSkipUrl(url) {
  return (
    !url ||
    url.startsWith('#') ||
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('//')
  );
}

function resolveAssetPath(url, baseDir) {
  if (shouldSkipUrl(url)) {
    return null;
  }

  const cleanUrl = decodeURIComponent(normalizeAssetUrl(url));
  const candidate = path.resolve(baseDir, cleanUrl);

  if (!candidate.startsWith(rootDir)) {
    return null;
  }

  return fs.existsSync(candidate) ? candidate : null;
}

function buildJob(job) {
  const assetCache = new Map();

  const assetToDataUri = (filePath) => {
    if (assetCache.has(filePath)) {
      return assetCache.get(filePath);
    }

    const dataUri = `data:${getMimeType(filePath)};base64,${fs.readFileSync(filePath).toString('base64')}`;
    assetCache.set(filePath, dataUri);

    return dataUri;
  };

  const inlineCssUrls = (css, cssPath) => {
    const cssDir = path.dirname(cssPath);

    return css.replace(/url\(([^)]+)\)/g, (match, rawUrl) => {
      const quote = rawUrl.trim().startsWith("'") ? "'" : rawUrl.trim().startsWith('"') ? '"' : '';
      const url = rawUrl.trim().replace(/^['"]|['"]$/g, '');
      const assetPath = resolveAssetPath(url, cssDir);

      return assetPath ? `url(${quote}${assetToDataUri(assetPath)}${quote})` : match;
    });
  };

  const inlineStylesheets = (html) =>
    html.replace(/<link\b[^>]*href=(["'])([^"']+\.css)\1[^>]*>/gi, (match, quote, href) => {
      const cssPath = resolveAssetPath(href, job.sourceDir);

      if (!cssPath) {
        return match;
      }

      const css = inlineCssUrls(fs.readFileSync(cssPath, 'utf8'), cssPath);

      return `<style data-bundled-from="${href}">\n${css}\n</style>`;
    });

  const inlineHtmlAssets = (html) =>
    html.replace(/\b(src|href)=(["'])(\.\/[^"']+)\2/gi, (match, attr, quote, url) => {
      const assetPath = resolveAssetPath(url, job.sourceDir);

      return assetPath ? `${attr}=${quote}${assetToDataUri(assetPath)}${quote}` : match;
    });

  const inputPath = path.join(job.sourceDir, job.input);
  const outputPath = path.join(templatesDir, job.output);

  let html = fs.readFileSync(inputPath, 'utf8');

  html = inlineStylesheets(html);
  html = inlineHtmlAssets(html);
  html = html.replace(/<iframe\b[^>]*id=(["'])is-service-frame\1[^>]*><\/iframe>/gi, '');

  if (job.stripScripts) {
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  }

  fs.writeFileSync(outputPath, html);

  console.log(`Bundled ${path.relative(rootDir, inputPath)} -> ${path.relative(rootDir, outputPath)}`);
  console.log(`Original: ${fs.statSync(inputPath).size} bytes`);
  console.log(`Bundled: ${fs.statSync(outputPath).size} bytes`);
  console.log(`Inlined assets: ${assetCache.size}`);
}

for (const job of jobs) {
  buildJob(job);
}
