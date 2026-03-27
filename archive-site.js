#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const startUrl = process.argv[2];
const outDir = path.resolve(process.argv[3] || 'archive');

console.log(`Starting archive for ${startUrl} -> ${outDir}`);

if (!startUrl) {
  console.error('Usage: node archive-site.js <start-url> [out-dir]');
  process.exit(1);
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function isHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(raw, base) {
  const u = new URL(raw, base);
  u.hash = '';
  return u.href;
}

function pageKey(raw) {
  const u = new URL(raw);
  u.hash = '';
  if (!path.extname(u.pathname) && !u.pathname.endsWith('/')) {
    u.pathname += '/';
  }
  return u.origin + u.pathname;
}

function pageOutPath(raw) {
  const u = new URL(raw);
  const p = decodeURIComponent(u.pathname);
  const trimmed = p.replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/').filter(Boolean);
  const queryHash = u.search ? `.${sha1(u.search).slice(0, 8)}` : '';

  if (p === '/' || p === '') {
    return path.join(outDir, 'index.html');
  }

  const fileName = parts
    .map((part, index) => {
      const isLast = index === parts.length - 1;
      const stem = isLast ? part.replace(path.extname(part), '') : part;
      return stem.replace(/[^a-zA-Z0-9._-]+/g, '-');
    })
    .filter(Boolean)
    .join('-');

  return path.join(outDir, `${fileName || 'page'}${queryHash}.html`);
}

function mimeToExt(contentType = '') {
  const mime = contentType.toLowerCase().split(';')[0].trim();
  const map = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/x-javascript': '.js',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'font/woff': '.woff',
    'font/woff2': '.woff2',
    'application/font-woff': '.woff',
    'application/vnd.ms-fontobject': '.eot',
    'application/json': '.json',
    'text/plain': '.txt',
  };
  return map[mime] || '';
}

function assetOutPath(raw, contentType = '') {
  const u = new URL(raw);
  let p = decodeURIComponent(u.pathname);

  if (p === '/' || p.endsWith('/')) {
    p += 'index';
  }
  p = p.replace(/^\/+/, '');

  const dir = path.dirname(p);
  const base = path.basename(p);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const queryHash = u.search ? `.${sha1(u.search).slice(0, 8)}` : '';
  const finalExt = ext || mimeToExt(contentType) || '.bin';

  return path.join(outDir, 'assets', u.hostname, dir, `${stem}${queryHash}${finalExt}`);
}

function rel(fromFile, toFile) {
  let r = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

function extractCssUrls(text) {
  const urls = new Set();

  const urlRe = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  let m;
  while ((m = urlRe.exec(text))) {
    const raw = (m[2] || '').trim();
    if (raw) urls.add(raw);
  }

  const importRe = /@import\s+(?:url\(\s*)?(?:['"])?([^'")\s]+)(?:['"])?\s*\)?/gi;
  while ((m = importRe.exec(text))) {
    const raw = (m[1] || '').trim();
    if (raw) urls.add(raw);
  }

  return [...urls];
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const request = context.request;

  const assetMap = new Map(); // absolute url -> local file path
  const pageMap = new Map();   // normalized page key -> local file path
  const manifest = { pages: [], assets: [] };

  async function ensureAsset(rawUrl, baseUrl) {
    const raw = (rawUrl || '').trim();
    if (!raw) return null;
    if (
      raw.startsWith('data:') ||
      raw.startsWith('blob:') ||
      raw.startsWith('javascript:') ||
      raw.startsWith('#')
    ) {
      return null;
    }

    let abs;
    try {
      abs = normalizeUrl(raw, baseUrl);
    } catch {
      return null;
    }
    if (!isHttpUrl(abs)) return null;

    if (assetMap.has(abs)) return assetMap.get(abs);

    const res = await request.get(abs, { maxRedirects: 5 });
    if (!res.ok()) return null;

    const finalUrl = res.url();
    const ct = (res.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
    const local = assetOutPath(finalUrl, ct);

    await fs.mkdir(path.dirname(local), { recursive: true });
    assetMap.set(abs, local);
    assetMap.set(normalizeUrl(finalUrl), local);

    if (ct.includes('text/css') || finalUrl.toLowerCase().endsWith('.css')) {
      const cssText = await res.text();
      const rewritten = await rewriteCss(cssText, local, finalUrl);
      await fs.writeFile(local, rewritten);
    } else {
      const buf = await res.body();
      await fs.writeFile(local, buf);
    }

    manifest.assets.push({ url: finalUrl, file: path.relative(outDir, local) });
    return local;
  }

  async function rewriteCss(cssText, cssLocalPath, cssBaseUrl) {
    const urls = extractCssUrls(cssText);
    for (const raw of urls) {
      await ensureAsset(raw, cssBaseUrl);
    }

    cssText = cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, _q, raw) => {
      const trimmed = (raw || '').trim();
      if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) {
        return full;
      }
      let abs;
      try {
        abs = normalizeUrl(trimmed, cssBaseUrl);
      } catch {
        return full;
      }
      const local = assetMap.get(abs);
      return local ? `url('${rel(cssLocalPath, local)}')` : full;
    });

    cssText = cssText.replace(/@import\s+(?:url\(\s*)?(?:['"])?([^'")\s]+)(?:['"])?\s*\)?/gi, (full, raw) => {
      const trimmed = (raw || '').trim();
      if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) {
        return full;
      }
      let abs;
      try {
        abs = normalizeUrl(trimmed, cssBaseUrl);
      } catch {
        return full;
      }
      const local = assetMap.get(abs);
      return local ? `@import url('${rel(cssLocalPath, local)}')` : full;
    });

    return cssText;
  }

  function srcsetParts(value) {
    return (value || '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const firstSpace = part.search(/\s/);
        if (firstSpace === -1) return { url: part, desc: '' };
        return { url: part.slice(0, firstSpace), desc: part.slice(firstSpace) };
      });
  }

  function rewriteSrcset(value, pageUrl, pageFile) {
    const items = srcsetParts(value);
    const out = [];

    for (const item of items) {
      let abs;
      try {
        abs = normalizeUrl(item.url, pageUrl);
      } catch {
        out.push(item.url + item.desc);
        continue;
      }
      const local = assetMap.get(abs);
      out.push(local ? `${rel(pageFile, local)}${item.desc}` : `${item.url}${item.desc}`);
    }

    return out.join(', ');
  }

  async function collectAndDownloadAssets($, pageUrl) {
    const urls = new Set();

    const add = (raw) => {
      if (!raw) return;
      const t = String(raw).trim();
      if (
        !t ||
        t.startsWith('data:') ||
        t.startsWith('blob:') ||
        t.startsWith('javascript:') ||
        t.startsWith('#')
      ) return;
      urls.add(t);
    };

    const assetSelectors = [
      'img[src]',
      'source[src]',
      'video[src]',
      'audio[src]',
      'script[src]',
      'iframe[src]',
      'embed[src]',
      'track[src]',
      'object[data]',
      'image[href]',
      'use[href]',
      'img[srcset]',
      'source[srcset]',
      'video[srcset]',
      'meta[content]',
      'link[href]',
      '[style]',
      'style',
    ];

    $(assetSelectors.join(',')).each((_, el) => {
      const $el = $(el);
      const tag = (el.tagName || '').toLowerCase();

      if (tag === 'link') {
        const relAttr = ($el.attr('rel') || '').toLowerCase();
        const relTokens = relAttr.split(/\s+/);
        const isAssetLink = relTokens.some(r =>
          ['stylesheet', 'icon', 'preload', 'modulepreload', 'apple-touch-icon'].includes(r)
        );
        if (isAssetLink) add($el.attr('href'));
        return;
      }

      if (tag === 'meta') {
        const key = (
          $el.attr('property') ||
          $el.attr('name') ||
          ''
        ).toLowerCase();
        if (/^(og:image|og:video|twitter:image|twitter:player:stream)$/.test(key)) {
          add($el.attr('content'));
        }
        return;
      }

      if ($el.attr('src')) add($el.attr('src'));
      if ($el.attr('href') && (tag === 'image' || tag === 'use')) add($el.attr('href'));
      if ($el.attr('data')) add($el.attr('data'));
      if ($el.attr('poster')) add($el.attr('poster'));
      if ($el.attr('srcset')) {
        for (const part of srcsetParts($el.attr('srcset'))) add(part.url);
      }

      if (tag === 'style') {
        for (const raw of extractCssUrls($el.text())) add(raw);
      }

      const styleAttr = $el.attr('style');
      if (styleAttr) {
        for (const raw of extractCssUrls(styleAttr)) add(raw);
      }
    });

    for (const raw of urls) {
      await ensureAsset(raw, pageUrl);
    }
  }

  function rewriteHtml($, pageUrl, pageFile) {
    const rewriteNavPageHref = (absUrl) => {
      return rel(pageFile, pageOutPath(absUrl));
    };

    const rewriteNavTreeItems = (items) => {
      if (!Array.isArray(items)) return;

      for (const item of items) {
        if (Array.isArray(item)) {
          rewriteNavTreeItems(item);
          continue;
        }

        if (!item || typeof item !== 'object') continue;

        if (typeof item.href === 'string') {
          try {
            const abs = normalizeUrl(item.href, pageUrl);
            if (pageMap.has(pageKey(abs))) {
              item.href = rewriteNavPageHref(abs);
            }
          } catch {
            // Leave invalid or unsupported href values unchanged.
          }
        }

        if (Array.isArray(item.items)) rewriteNavTreeItems(item.items);
        if (Array.isArray(item.children)) rewriteNavTreeItems(item.children);
      }
    };

    // rewrite page links that are in the nav set we crawled
    $('a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href) return;

      const lower = href.trim().toLowerCase();
      if (
        lower.startsWith('#') ||
        lower.startsWith('mailto:') ||
        lower.startsWith('tel:') ||
        lower.startsWith('javascript:')
      ) {
        return;
      }

      let abs;
      try {
        abs = normalizeUrl(href, pageUrl);
      } catch {
        return;
      }
      if (!isHttpUrl(abs)) return;

      const localPage = pageMap.get(pageKey(abs));
      if (localPage) {
        $el.attr('href', rel(pageFile, localPage));
        if ($el.closest('ul.uds-hdr-nav-list').length) {
          $el.attr('href', rewriteNavPageHref(abs));
          return;
        }
      }
    });

    const assetAttrTags = [
      'img',
      'source',
      'video',
      'audio',
      'script',
      'iframe',
      'embed',
      'track',
      'object',
      'image',
      'use',
      'link',
    ];

    $(assetAttrTags.join(',')).each((_, el) => {
      const $el = $(el);
      const tag = (el.tagName || '').toLowerCase();

      const rewriteOne = (attrName) => {
        const value = $el.attr(attrName);
        if (!value) return;

        if (
          value.startsWith('data:') ||
          value.startsWith('blob:') ||
          value.startsWith('#') ||
          value.startsWith('javascript:')
        ) {
          return;
        }

        let abs;
        try {
          abs = normalizeUrl(value, pageUrl);
        } catch {
          return;
        }

        const local = assetMap.get(abs);
        if (local) $el.attr(attrName, rel(pageFile, local));
      };

      if (tag === 'link') {
        const relAttr = ($el.attr('rel') || '').toLowerCase();
        const relTokens = relAttr.split(/\s+/);
        const isAssetLink = relTokens.some(r =>
          ['stylesheet', 'icon', 'preload', 'modulepreload', 'apple-touch-icon'].includes(r)
        );
        if (isAssetLink) rewriteOne('href');
        return;
      }

      rewriteOne('src');
      rewriteOne('poster');
      rewriteOne('data');
      rewriteOne('href');

      const srcset = $el.attr('srcset');
      if (srcset) {
        $el.attr('srcset', rewriteSrcset(srcset, pageUrl, pageFile));
      }
    });

    $('style').each((_, el) => {
      const $el = $(el);
      const css = $el.text();
      const rewritten = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, _q, raw) => {
        const trimmed = (raw || '').trim();
        if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) {
          return full;
        }
        let abs;
        try {
          abs = normalizeUrl(trimmed, pageUrl);
        } catch {
          return full;
        }
        const local = assetMap.get(abs);
        return local ? `url('${rel(pageFile, local)}')` : full;
      });
      $el.text(rewritten);
    });

    $('[style]').each((_, el) => {
      const $el = $(el);
      const styleAttr = $el.attr('style');
      if (!styleAttr) return;

      const rewritten = styleAttr.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, _q, raw) => {
        const trimmed = (raw || '').trim();
        if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) {
          return full;
        }
        let abs;
        try {
          abs = normalizeUrl(trimmed, pageUrl);
        } catch {
          return full;
        }
        const local = assetMap.get(abs);
        return local ? `url('${rel(pageFile, local)}')` : full;
      });

      $el.attr('style', rewritten);
    });

    $('script[type="application/json"][data-drupal-selector="drupal-settings-json"]').each((_, el) => {
      const $el = $(el);
      const raw = $el.html();
      if (!raw) return;

      let settings;
      try {
        settings = JSON.parse(raw);
      } catch {
        return;
      }

      const navTree = settings?.asu_brand?.props?.navTree;
      if (!Array.isArray(navTree)) return;

      rewriteNavTreeItems(navTree);
      $el.text(JSON.stringify(settings));
    });

    return $.html();
  }

  async function savePage(pageUrl, browserPage) {
    const pageFile = pageOutPath(pageUrl);
    pageMap.set(pageKey(pageUrl), pageFile);

    await fs.mkdir(path.dirname(pageFile), { recursive: true });

    const html = await browserPage.content();
    const $ = cheerio.load(html, { decodeEntities: false });

    await collectAndDownloadAssets($, pageUrl);
    const rewritten = rewriteHtml($, pageUrl, pageFile);

    await fs.writeFile(pageFile, rewritten);
    manifest.pages.push({ url: pageUrl, file: path.relative(outDir, pageFile) });
  }

  // First open the start page and extract the nav links inside the requested UL.
  const bootstrapPage = await context.newPage();
  await bootstrapPage.goto(startUrl, { waitUntil: 'domcontentloaded' });
  try {
    await bootstrapPage.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // fine; some sites keep connections open
  }

  const navLinks = await bootstrapPage.evaluate(() => {
    const selector = 'ul.uds-hdr-nav-list a[href]';
    return Array.from(document.querySelectorAll(selector)).map(a => a.href);
  });

  const pagesToCrawl = [];
  const seen = new Set();

  for (const raw of [startUrl, ...navLinks]) {
    let abs;
    try {
      abs = normalizeUrl(raw, startUrl);
    } catch {
      continue;
    }
    if (!isHttpUrl(abs)) continue;

    const key = pageKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    pagesToCrawl.push(abs);
  }

  // Pre-register every page we plan to save so link rewriting works
  // even when a page points to another page that has not been processed yet.
  for (const pageUrl of pagesToCrawl) {
    pageMap.set(pageKey(pageUrl), pageOutPath(pageUrl));
  }

  await bootstrapPage.close();

  for (const pageUrl of pagesToCrawl) {
    const p = await context.newPage();
    try {
      await p.goto(pageUrl, { waitUntil: 'domcontentloaded' });
      try {
        await p.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {
        // some sites never go fully idle
      }

      await savePage(pageUrl, p);
      console.log(`Saved ${pageUrl}`);
    } catch (err) {
      console.warn(`Failed ${pageUrl}: ${err.message}`);
    } finally {
      await p.close();
    }
  }

  await browser.close();

  await fs.writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`Done. Open ${path.join(outDir, 'index.html')} or any saved page.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
