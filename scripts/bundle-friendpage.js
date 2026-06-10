const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const sourceDir = path.join(rootDir, 'template-sources', 'friendpage');
const inputPath = path.join(sourceDir, 'friendpage.html');
const outputPath = path.join(rootDir, 'templates', 'friendpage.bundle.html');

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

const assetCache = new Map();

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

function assetToDataUri(filePath) {
  if (assetCache.has(filePath)) {
    return assetCache.get(filePath);
  }

  const mimeType = getMimeType(filePath);
  const dataUri = `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
  assetCache.set(filePath, dataUri);
  return dataUri;
}

function inlineCssUrls(css, cssPath) {
  const cssDir = path.dirname(cssPath);

  return css.replace(/url\(([^)]+)\)/g, (match, rawUrl) => {
    const quote = rawUrl.trim().startsWith("'") ? "'" : rawUrl.trim().startsWith('"') ? '"' : '';
    const url = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    const assetPath = resolveAssetPath(url, cssDir);

    if (!assetPath) {
      return match;
    }

    return `url(${quote}${assetToDataUri(assetPath)}${quote})`;
  });
}

function inlineStylesheets(html) {
  return html.replace(/<link\b[^>]*href=(["'])([^"']+\.css)\1[^>]*>/gi, (match, quote, href) => {
    const cssPath = resolveAssetPath(href, sourceDir);

    if (!cssPath) {
      return match;
    }

    const css = inlineCssUrls(fs.readFileSync(cssPath, 'utf8'), cssPath);
    return `<style data-bundled-from="${href}">\n${css}\n</style>`;
  });
}

function inlineHtmlAssetAttributes(html) {
  return html.replace(/\b(src|href)=(["'])(\.\/friendpage_files\/[^"']+)\2/gi, (match, attr, quote, url) => {
    const assetPath = resolveAssetPath(url, sourceDir);

    if (!assetPath) {
      return match;
    }

    return `${attr}=${quote}${assetToDataUri(assetPath)}${quote}`;
  });
}

function removeScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function removeHiddenServiceFrames(html) {
  return html.replace(/<iframe\b[^>]*id=(["'])is-service-frame\1[^>]*><\/iframe>/gi, '');
}

function bundleFriendPage() {
  let html = fs.readFileSync(inputPath, 'utf8');

  html = inlineStylesheets(html);
  html = inlineHtmlAssetAttributes(html);
  html = removeHiddenServiceFrames(html);
  html = removeScripts(html);

  fs.writeFileSync(outputPath, html);

  const originalBytes = fs.statSync(inputPath).size;
  const bundledBytes = fs.statSync(outputPath).size;

  console.log(`Bundled ${path.relative(rootDir, inputPath)} -> ${path.relative(rootDir, outputPath)}`);
  console.log(`Original: ${originalBytes} bytes`);
  console.log(`Bundled: ${bundledBytes} bytes`);
  console.log(`Inlined assets: ${assetCache.size}`);
}

bundleFriendPage();
