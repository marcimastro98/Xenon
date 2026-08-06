#!/usr/bin/env node
// Tells the IndexNow search engines (Bing, and through it Copilot; Yandex,
// Seznam, Naver) which URLs of xenon-app.com just changed, instead of waiting
// for them to come and find out.
//
// Why it is worth having: the site's crawlable surface is 45 catalog pages
// generated from catalog.json by tools/build-seo.mjs, and a new community item
// arrives as a bot commit. Without this, a freshly published theme waits for
// the next organic crawl, which on a young domain is weeks. With it, the ping
// goes out in the same workflow run that deploys the page.
//
// It is deliberately incapable of failing the deploy. Every error path logs and
// exits 0: a search-engine notification is not worth taking the website down
// for, and a missed ping costs nothing but the wait it was there to remove.
//
//   node tools/indexnow.mjs            submit what changed in this run
//   node tools/indexnow.mjs --all      submit every URL in the sitemap
//   node tools/indexnow.mjs --dry-run  print the list, send nothing
//
// The key is public by design — it is served at https://xenon-app.com/<key>.txt
// and that file IS the proof of ownership — so it lives in the repo rather than
// in a secret. There is no second copy of it here: the key is DISCOVERED by
// finding the file in docs/ whose name matches its own contents, so the value
// that gets sent and the value a crawler can verify cannot drift apart.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://xenon-app.com';
const HOST = 'xenon-app.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

// One request carries up to 10,000 URLs per the spec; the whole sitemap is ~53,
// so this is a guard against a future runaway, not a real limit.
const MAX_URLS = 10000;

const args = new Set(process.argv.slice(2));
const ALL = args.has('--all');
const DRY = args.has('--dry-run');

/** Log and leave without a non-zero exit — see the header. */
function bail(msg) {
  console.log(`indexnow: ${msg}`);
  process.exit(0);
}

function git(...a) {
  try {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/* ── the key ─────────────────────────────────────────────────────────────── */

// A valid key file is named <key>.txt and contains exactly <key>. Requiring
// both halves to agree is what makes discovery safe: llms.txt and any other
// .txt in docs/ fails the content test and is never mistaken for a key.
function findKey() {
  let names;
  try {
    names = fs.readdirSync(DOCS);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^([A-Za-z0-9-]{8,128})\.txt$/.exec(name);
    if (!m) continue;
    let body;
    try {
      body = fs.readFileSync(path.join(DOCS, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (body === m[1]) return m[1];
  }
  return null;
}

/* ── what is indexable ───────────────────────────────────────────────────── */

// The sitemap is the authority on which URLs may be submitted. Intersecting
// against it means the change detection below can be generous: a touched image,
// a stylesheet, /get/ or anything else that is not an indexable page simply
// falls out, so there is no second list of exclusions to keep in step with
// robots.txt.
function sitemapUrls() {
  let xml;
  try {
    xml = fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8');
  } catch {
    return null;
  }
  const out = new Set();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) out.add(m[1].trim());
  return out.size ? out : null;
}

// docs/index.html            → https://xenon-app.com/
// docs/faq.html              → https://xenon-app.com/faq.html
// docs/catalog/sakura/index.html → https://xenon-app.com/catalog/sakura/
function fileToUrl(repoPath) {
  const rel = repoPath.replace(/\\/g, '/').replace(/^docs\//, '');
  if (rel === 'index.html') return SITE + '/';
  if (rel.endsWith('/index.html')) return SITE + '/' + rel.slice(0, -'index.html'.length);
  return SITE + '/' + rel;
}

/* ── what changed ────────────────────────────────────────────────────────── */

// Two sources, because a catalog page can change without a commit touching it.
//
//  1. The commit range. GitHub hands the workflow the SHA the branch moved
//     from; anything under docs/ that changed between there and HEAD is a page
//     whose content is new.
//  2. The working tree AFTER build-seo.mjs has run. A bot commit that edits
//     only catalog.json leaves the regenerated catalog pages as uncommitted
//     modifications, and those are exactly the URLs worth announcing. Reading
//     the tree rather than the commit is what catches them.
function changedFiles() {
  const files = new Set();

  const before = process.env.INDEXNOW_BEFORE || '';
  const after = process.env.INDEXNOW_AFTER || 'HEAD';
  // A first push, a force push and a manual dispatch all produce a "before"
  // that is absent or points at nothing. Verify it resolves before diffing —
  // an unknown revision would make git print an error and yield no files,
  // which is indistinguishable from "nothing changed".
  const known = /^[0-9a-f]{7,40}$/i.test(before) && !/^0+$/.test(before)
    && git('rev-parse', '--quiet', '--verify', `${before}^{commit}`).trim() !== '';
  const range = known ? [before, after] : ['HEAD~1', 'HEAD'];
  for (const line of git('diff', '--name-only', ...range, '--', 'docs').split('\n')) {
    const f = line.trim();
    if (f) files.add(f);
  }

  // -uall lists individual files inside a new directory; without it git reports
  // the directory alone and a brand-new catalog page would never be mapped.
  for (const line of git('status', '--porcelain', '-uall', '--', 'docs').split('\n')) {
    if (!line.trim()) continue;
    let f = line.slice(3).trim();
    const arrow = f.indexOf(' -> ');           // rename: announce the new name
    if (arrow !== -1) f = f.slice(arrow + 4);
    if (f.startsWith('"') && f.endsWith('"')) {
      try { f = JSON.parse(f); } catch { /* keep the raw form */ }
    }
    if (f) files.add(f);
  }

  return files;
}

/* ── submit ──────────────────────────────────────────────────────────────── */

async function submit(key, urls) {
  const body = JSON.stringify({
    host: HOST,
    key,
    keyLocation: `${SITE}/${key}.txt`,
    urlList: urls,
  });
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
  });
  // 200 accepted, 202 accepted but the key is still being validated (normal on
  // the first ever submission, before the crawler has fetched the key file).
  if (res.status === 200 || res.status === 202) {
    console.log(`indexnow: ${urls.length} URL(s) accepted (HTTP ${res.status})`);
    return;
  }
  const text = await res.text().catch(() => '');
  console.log(`indexnow: refused with HTTP ${res.status} ${text.slice(0, 300)}`);
}

async function main() {
  const key = findKey();
  if (!key) bail('no key file in docs/ — nothing submitted');

  const indexable = sitemapUrls();
  if (!indexable) bail('sitemap.xml is missing or empty — run tools/build-seo.mjs first');

  let urls;
  if (ALL) {
    urls = [...indexable];
  } else {
    const changed = changedFiles();
    const seen = new Set();
    for (const f of changed) {
      const url = fileToUrl(f);
      if (indexable.has(url)) seen.add(url);
    }
    // catalog.json drives every catalog page but is not itself a page. When it
    // moves, the listing has at minimum changed; the individual entry pages come
    // in through the working-tree half above.
    if (changed.has('docs/community/catalog.json') && indexable.has(`${SITE}/catalog/`)) {
      seen.add(`${SITE}/catalog/`);
    }
    urls = [...seen];
  }

  if (!urls.length) bail('no indexable URL changed — nothing to submit');
  if (urls.length > MAX_URLS) {
    console.log(`indexnow: ${urls.length} URLs is over the ${MAX_URLS} cap — sending the first ${MAX_URLS}`);
    urls = urls.slice(0, MAX_URLS);
  }

  for (const u of urls) console.log(`  ${u}`);
  if (DRY) bail(`dry run — ${urls.length} URL(s) not sent`);

  try {
    await submit(key, urls);
  } catch (e) {
    console.log(`indexnow: submission failed (${e && e.message}) — the deploy is unaffected`);
  }
}

main();
