'use strict';

// macOS's own file catalog (Spotlight, through `mdfind`) as the search's
// catalog backend: the exact twin of what search.ps1 does with Windows Search.
// It reads file CONTENT, which the Living Index never does, and it covers what
// the user's index roots leave out. Before this, off Windows the catalog half
// of every search answered "unsupported" and there was no content search at
// all on a Mac.
//
// The query is built here (pure, tested on every platform); the run spawns
// mdfind with an argv array, never a shell, and stops reading after `max`
// paths. Every term is stripped of the characters that mean something inside a
// Spotlight query string (quotes, backslashes, the * wildcard), so a typed term
// can never become query syntax.

const { spawn } = require('child_process');
const path = require('path');
const fsDefault = require('fs');

const clean = (t) => String(t || '').replace(/["\\*]/g, '').trim();
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// { terms, exts, after, before, minBytes, maxBytes, content } → one Spotlight
// query. Names: substring, case- and accent-insensitive (`cd`). Content: a word
// starting with the term (`cdw`), as the Windows catalog does.
function buildMdfindQuery(q) {
  const parts = [];
  for (const raw of q.terms || []) {
    const t = clean(raw);
    if (!t) continue;
    const name = `kMDItemFSName == "*${t}*"cd`;
    parts.push(q.content ? `(${name} || kMDItemTextContent == "${t}*"cdw)` : name);
  }
  const exts = (q.exts || []).map(clean).filter((e) => /^[a-z0-9]{1,8}$/i.test(e));
  if (exts.length) parts.push('(' + exts.map((e) => `kMDItemFSName == "*.${e}"c`).join(' || ') + ')');
  if (Number.isFinite(q.after)) parts.push(`kMDItemFSContentChangeDate >= $time.iso(${isoOf(q.after)})`);
  if (Number.isFinite(q.before)) parts.push(`kMDItemFSContentChangeDate < $time.iso(${isoOf(q.before)})`);
  if (Number.isFinite(q.minBytes)) parts.push(`kMDItemFSSize >= ${Math.round(q.minBytes)}`);
  if (Number.isFinite(q.maxBytes)) parts.push(`kMDItemFSSize <= ${Math.round(q.maxBytes)}`);
  return parts.length ? parts.join(' && ') : '';
}

// The catalog runner filesearch.js takes: query → [{p, n, s, m}]. Rejects with
// 'wds_unsupported' where there is no mdfind, so the dashboard says the right
// thing rather than blaming a disabled service.
function createMdfindRunner(opts = {}) {
  const fs = opts.fs || fsDefault;
  const spawnImpl = opts.spawn || spawn;
  const timeoutMs = opts.timeoutMs || 4000;
  return function run(q) {
    const query = buildMdfindQuery(q);
    if (!query) return Promise.resolve([]);
    const max = Math.max(1, Math.min(200, q.max || 100));
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawnImpl('mdfind', ['-0', query], { stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { reject(new Error('wds_unsupported')); return; }
      const paths = [];
      let buf = '';
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* already gone */ }
        const items = [];
        await Promise.all(paths.slice(0, max).map(async (p) => {
          try {
            const st = await fs.promises.stat(p);
            if (st.isFile()) items.push({ p, n: path.basename(p), s: st.size, m: st.mtimeMs });
          } catch { /* vanished */ }
        }));
        resolve(items);
      };
      const timer = setTimeout(finish, timeoutMs);
      child.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(e && e.code === 'ENOENT' ? 'wds_unsupported' : 'wds_unavailable'));
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nul;
        while ((nul = buf.indexOf('\0')) !== -1) {
          const p = buf.slice(0, nul);
          buf = buf.slice(nul + 1);
          if (p) paths.push(p);
          if (paths.length >= max) { void finish(); return; }
        }
      });
      child.on('close', () => { void finish(); });
    });
  };
}

module.exports = { buildMdfindQuery, createMdfindRunner };
