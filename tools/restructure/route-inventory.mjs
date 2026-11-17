// Writes route-inventory.md: every `METHOD /address` the engine answers, where its body
// lives, and its gate class (paired device, cross-site guard, JSONP), read from the code
// as it stands. Reading only, except the one file it writes.
//
//   node tools/restructure/route-inventory.mjs           say whether the file is current (exit 1 when not)
//   node tools/restructure/route-inventory.mjs --write   write it again
//
// server/test/restructure-route-inventory.test.mjs fails when the file differs from
// what this writes, so a change to a route or to a gate list shows up in review.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openParser, REPO_ROOT } from './parser.mjs';
import { classOf, readGate } from './route-inventory-gate.mjs';
import { ENGINE, readRoutes } from './route-inventory-read.mjs';

export const INVENTORY = 'tools/restructure/route-inventory.md';
const COMMAND = 'node tools/restructure/route-inventory.mjs --write';

/** @param {string} address an address or a beginning (`/x/*`) @param {{ path: string, method: string }[]} rows */
const answered = (address, rows) => rows.some((row) => row.method !== 'OPTIONS'
  && (row.path === address || (row.path.endsWith('*') && address.startsWith(row.path.slice(0, -1)))));

/**
 * @param {object} job
 * @param {(file: string) => string} job.read reads a repo-relative file
 * @param {any} job.parser from openParser
 * @param {string} [job.root] the repo folder whose gate modules are loaded
 */
export function buildInventory({ read, parser, root = REPO_ROOT }) {
  const gate = readGate(read(ENGINE), parser, root);
  const routes = readRoutes(read, parser, { 'remoteAccessLib.WIDGET_ASSET_PREFIX': gate.remote.WIDGET_ASSET_PREFIX });
  const seen = new Map();
  const rows = routes.map((route) => {
    const key = `${route.method} ${route.path}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, route);
    const twice = first ? `never reached: answered first by ${first.asked} (${first.body})` : '';
    return { ...route, ...classOf(gate, route), note: [route.note, twice].filter(Boolean).join('; ') };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : a.order - b.order));
  const unanswered = (list) => [...list].filter((address) => !answered(address, rows)).sort();
  return {
    rows,
    gate,
    loose: {
      CSRF_MUTATION_PATHS: unanswered(gate.csrf),
      REMOTE_DENY: unanswered(gate.refused.REMOTE_DENY),
      REMOTE_ADMIN: unanswered(gate.refused.REMOTE_ADMIN),
      GET_READ_EXCEPTIONS: unanswered(gate.remote.GET_READ_EXCEPTIONS),
      JSONP_PATHS: unanswered(gate.jsonp),
    },
    twice: rows.filter((row) => row.note.includes('never reached')).map((row) => `${row.method} ${row.path}`),
  };
}

const count = (rows, pick) => {
  const counted = new Map();
  for (const row of rows) counted.set(pick(row), (counted.get(pick(row)) ?? 0) + 1);
  return [...counted].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([value, many]) => `${many} ${value || '(none)'}`).join(', ');
};
const cell = (text) => String(text).replace(/\|/g, '\\|');

/** @param {ReturnType<typeof buildInventory>} inventory @returns {string} the Markdown file, LF line endings */
export function render({ rows, loose, twice }) {
  const lines = [
    '# Route inventory',
    '',
    `Written by \`${COMMAND}\` from the engine's code; never edit it by hand.`,
    '`server/test/restructure-route-inventory.test.mjs` fails when this file and the code disagree.',
    '',
    '- Asked by: `chain` a test of `handleRequest` in server/server.js; `table` and `feature` the Map of',
    '  server/feature-routes.js (TABLE_FILES, FEATURES); `socket` the `upgrade` handler (WS = a WebSocket).',
    '- Paired device: what `remotePathAllowed` (server/paired/remote-access.js) says, with `CSRF_MUTATION_PATHS`',
    '  as server.js hands it at boot, and the list that refuses. A beginning (`/x/*`) is judged on the beginning;',
    '  listed addresses under it that are judged differently are named in the note.',
    '- Cross-site guard: the list or rule of `handleRequest` that refuses a cross-site request or a navigation.',
    '- JSONP: may answer `?cb=` (`JSONP_PATHS`).',
    '',
    `${rows.length} routes.`,
    `- Asked by: ${count(rows, (row) => row.asked)}.`,
    `- Paired device: ${count(rows, (row) => row.paired)}.`,
    `- Cross-site guard: ${count(rows, (row) => row.guard)}.`,
    `- JSONP: ${rows.filter((row) => row.jsonp).map((row) => `${row.method} ${row.path}`).join(', ') || 'none'}.`,
    '',
    '| Method | Address | Asked by | Body in | Paired device | Cross-site guard | JSONP | Note |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${[row.method, `\`${row.path}\``, row.asked, row.body, row.paired, row.guard, row.jsonp ? 'yes' : '',
      [row.note, ...(row.under.length ? [`under it: ${row.under.join(', ')}`] : [])].filter(Boolean).join('; ')].map(cell).join(' | ')} |`),
    '',
    '## Listed, answered by no route',
    '',
    ...Object.entries(loose).map(([list, addresses]) => `- ${list}: ${addresses.length ? addresses.map((one) => `\`${one}\``).join(', ') : 'none'}.`),
    '',
    '## Answered twice',
    '',
    twice.length ? twice.map((one) => `- \`${one}\``).join('\n') : 'None.',
    '',
  ];
  return lines.join('\n');
}

/** @returns {Promise<string>} the file as the code of this folder makes it now */
export async function inventoryNow(root = REPO_ROOT) {
  const parser = await openParser();
  try {
    return render(buildInventory({ read: (file) => readFileSync(path.join(root, file), 'utf8'), parser, root }));
  } finally {
    parser.close();
  }
}

async function main() {
  const made = await inventoryNow();
  const file = path.join(REPO_ROOT, INVENTORY);
  if (process.argv.includes('--write')) {
    writeFileSync(file, made);
    console.log(`wrote ${INVENTORY}`);
    return;
  }
  let kept = '';
  try { kept = readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* not written yet */ }
  console.log(kept === made ? `${INVENTORY} is current` : `${INVENTORY} is not current: run ${COMMAND}`);
  process.exitCode = kept === made ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
