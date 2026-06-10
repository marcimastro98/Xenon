#!/usr/bin/env node
/*
 * Builds docs/supporters.json from the Buy Me a Coffee API for the website's
 * "Hall of supporters". Privacy-first: full names and profile links are NEVER
 * written to the repo — each name is masked/aliased here, before the file is
 * saved, according to docs/supporters-overrides.json.
 *
 * Env: BMC_TOKEN — a Buy Me a Coffee API access token (developers.buymeacoffee.com).
 * If the token is missing or the API fails, the existing file is left untouched
 * and the script exits 0 (so the GitHub Action never fails the build).
 *
 * Xenon — Copyright (c) 2026 Marcello Mastroeni (marcimastro98). See LICENSE.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'supporters.json');
const OVERRIDES = join(ROOT, 'docs', 'supporters-overrides.json');

const TOKEN = process.env.BMC_TOKEN;
if (!TOKEN) {
  console.error('BMC_TOKEN not set — leaving supporters.json unchanged.');
  process.exit(0);
}

const overrides = existsSync(OVERRIDES) ? JSON.parse(readFileSync(OVERRIDES, 'utf8')) : {};
const privacyMode = overrides.privacyMode || 'first';
const topCount = Number.isFinite(overrides.topCount) ? overrides.topCount : 1;
const aliases = overrides.aliases || {};
const norm = (s) => String(s || '').toLowerCase().trim();
const hide = new Set((overrides.hide || []).map(norm));
const forceAnon = new Set((overrides.forceAnonymous || []).map(norm));
const aliasByKey = new Map(Object.keys(aliases).map((k) => [norm(k), aliases[k]]));

async function fetchAllSupporters() {
  const out = [];
  let url = 'https://developers.buymeacoffee.com/api/v1/supporters';
  // Guard against an unexpected pagination loop.
  for (let page = 0; url && page < 200; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`BMC API ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (Array.isArray(json.data)) out.push(...json.data);
    url = json.next_page_url || null;
  }
  return out;
}

function mask(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return 'Anonymous';
  const parts = name.split(/\s+/);
  const first = parts[0];
  switch (privacyMode) {
    case 'full':
      return name;
    case 'initial':
      return parts[1] ? `${first} ${parts[1][0].toUpperCase()}.` : first;
    case 'mask': {
      if (first.length <= 2) return `${first[0]}•`;
      return `${first[0]}${'•'.repeat(Math.min(first.length - 2, 6))}${first[first.length - 1]}`;
    }
    case 'first':
    default:
      return first;
  }
}

function displayName(rawName) {
  const key = norm(rawName);
  if (hide.has(key)) return null;            // excluded entirely
  if (aliasByKey.has(key)) return aliasByKey.get(key); // custom alias bypasses masking
  if (forceAnon.has(key)) return 'Anonymous supporter';
  return mask(rawName);
}

(async () => {
  let raw;
  try {
    raw = await fetchAllSupporters();
  } catch (err) {
    console.error(`BMC fetch failed: ${err.message} — leaving supporters.json unchanged.`);
    process.exit(0);
  }

  // Aggregate coffees per (raw) name so repeat supporters rank by their total.
  const totals = new Map();
  for (const s of raw) {
    const name = s.payer_name || s.supporter_name || 'Someone';
    totals.set(name, (totals.get(name) || 0) + (Number(s.support_coffees) || 1));
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  const supporters = [];
  let topsAssigned = 0;
  for (const [rawName] of ranked) {
    const name = displayName(rawName);
    if (!name) continue;
    const entry = { name };
    if (topsAssigned < topCount) { entry.top = true; topsAssigned++; }
    supporters.push(entry);
  }

  const payload = {
    _generated: new Date().toISOString(),
    _note: 'Auto-generated from Buy Me a Coffee by tools/build-supporters.mjs. Do not edit by hand — change docs/supporters-overrides.json instead. Names are privacy-masked; full names and profile links are never published.',
    supporters,
  };

  const next = `${JSON.stringify(payload, null, 2)}\n`;
  const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // Compare ignoring the timestamp so unchanged supporter lists don't churn commits.
  const stripTs = (t) => t.replace(/"_generated":\s*"[^"]*",?\s*/, '');
  if (stripTs(prev) === stripTs(next)) {
    console.log('No supporter changes.');
    process.exit(0);
  }

  writeFileSync(OUT, next);
  console.log(`Wrote ${supporters.length} supporter(s) to docs/supporters.json.`);
})();
