#!/usr/bin/env node
// Writes the facts of the latest release into the pages that state them, so a
// crawler or an answer engine reads the version that is actually out, not the
// one that was current the day a page was last edited:
//
//   docs/index.html     SoftwareApplication JSON-LD: softwareVersion, fileSize,
//                       releaseNotes
//   docs/download.html  the same, in a SoftwareApplication node of its own
//   docs/llms.txt       the "Latest release" line
//
// The Pages workflow runs it before the language copies are built (so they
// inherit it) on every deploy and once a day, which is what picks up a release
// published between two pushes. Node builtins only. Uses GITHUB_TOKEN when set
// (CI), anonymously otherwise; any failure leaves the files as they were.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const REPO = 'marcimastro98/Xenon';

async function latest() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'xenon-site-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers });
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  const j = await r.json();
  const version = String(j.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('no version in the latest release');
  const win = (j.assets || []).find((a) => a && a.name === 'Xenon-Setup-x64.exe');
  return {
    version,
    date: String(j.published_at || '').slice(0, 10),
    notes: j.html_url || ('https://github.com/' + REPO + '/releases/latest'),
    size: win && win.size ? (win.size / 1048576).toFixed(1) + ' MB' : '',
  };
}

function stampJsonLd(html, rel, add) {
  let found = false;
  const out = html.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (all, a, body, b) => {
    let data;
    try { data = JSON.parse(body); } catch { return all; }
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(visit);
      if (n['@type'] === 'SoftwareApplication') {
        found = true;
        n.softwareVersion = rel.version;
        if (rel.size) n.fileSize = rel.size;
        n.releaseNotes = rel.notes;
      }
      Object.values(n).forEach(visit);
    };
    visit(data);
    const pretty = body.includes('\n');
    return a + (pretty ? '\n' + JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data)) + b;
  });
  if (found || !add) return out;
  const node = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Xenon',
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Windows 10, Windows 11, macOS 11 or later (beta), Linux (beta)',
    softwareVersion: rel.version, releaseNotes: rel.notes,
    downloadUrl: 'https://github.com/' + REPO + '/releases/latest/download/Xenon-Setup-x64.exe',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  if (rel.size) node.fileSize = rel.size;
  return out.replace('</head>', '<script type="application/ld+json">' + JSON.stringify(node) + '</script>\n</head>');
}

function write(file, fn) {
  const abs = path.join(DOCS, file);
  if (!fs.existsSync(abs)) return;
  const before = fs.readFileSync(abs, 'utf8');
  const after = fn(before);
  if (after !== before) { fs.writeFileSync(abs, after); console.log('stamped', file); }
}

try {
  const rel = await latest();
  write('index.html', (s) => stampJsonLd(s, rel, false));
  write('download.html', (s) => stampJsonLd(s, rel, true));
  write('llms.txt', (s) => {
    const line = '- Latest release: ' + rel.version + (rel.date ? ', published ' + rel.date : '') + '. ' + rel.notes;
    if (/^- Latest release: .*$/m.test(s)) return s.replace(/^- Latest release: .*$/m, line);
    return s.replace(/^(- Platforms:)/m, line + '\n$1');
  });
  console.log('release', rel.version, rel.date, rel.size);
} catch (e) {
  console.log('stamp-release: left as is (' + e.message + ')');
}
