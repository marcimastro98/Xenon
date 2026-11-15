'use strict';

// A page lists about 450 scripts and stylesheets. Served with `no-cache`, each one
// costs a round trip at every load, even when the answer is 304: measured on the
// dashboard, about 2 s before first paint. So every page goes out with a version
// in those URLs, and a URL that names the file as it is now may stay in the
// browser's cache without asking again.
//
// The version comes from the file on disk at the moment the page is served, so a
// local edit or a self-update shows at the next load, with no list to keep. The
// app version is part of it: an update that restores a file with the same size
// and date still changes the URL.

const fs = require('fs');
const path = require('path');

const FOREVER = 'private, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

// Only our own tags, only the local folders, only names with nothing to escape.
// A URL that already has a query is left alone: the pattern needs the closing
// quote right after the extension.
const ASSET_TAG = /(<(?:script|link)\b[^>]*?\s(?:src|href)=")(\/?(?:js|styles|components|vendor|shared)\/[A-Za-z0-9._/-]+\.(?:js|css))(")/g;

function tagOf(stat, appVersion) {
  return `${appVersion}-${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}`;
}

/** What a static response may say: forever only for the version on disk right now. */
function cacheControl(askedTag, stat, appVersion) {
  return askedTag && askedTag === tagOf(stat, appVersion) ? FOREVER : REVALIDATE;
}

async function tagsFor(urls, rootDir, appVersion) {
  const tags = new Map();
  await Promise.all([...urls].map(async (url) => {
    if (url.split('/').includes('..')) return;
    try {
      const stat = await fs.promises.stat(path.join(rootDir, url));
      if (stat.isFile()) tags.set(url, tagOf(stat, appVersion));
    } catch {
      // A tag naming a file that is not there stays as written: the browser's 404
      // for it is the honest report, as it was before this file existed.
    }
  }));
  return tags;
}

/** The page with a version on every local script and stylesheet it lists. */
async function stamp(html, rootDir, appVersion) {
  const urls = new Set();
  for (const match of html.matchAll(ASSET_TAG)) urls.add(match[2]);
  const tags = await tagsFor(urls, rootDir, appVersion);
  return html.replace(ASSET_TAG, (whole, open, url, close) => {
    const tag = tags.get(url);
    return tag ? `${open}${url}?v=${encodeURIComponent(tag)}${close}` : whole;
  });
}

module.exports = { stamp, cacheControl, tagOf };
