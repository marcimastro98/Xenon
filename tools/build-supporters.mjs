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

async function fetchAllPages(endpoint) {
  const out = [];
  let url = `https://developers.buymeacoffee.com/api/v1/${endpoint}`;
  // Guard against an unexpected pagination loop.
  for (let page = 0; url && page < 200; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`BMC API ${endpoint} ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (Array.isArray(json.data)) out.push(...json.data);
    url = json.next_page_url || null;
  }
  return out;
}

// Best-effort name on any BMC record (one-off, membership or extra all carry it).
const payerOf = (s) => s.payer_name || s.supporter_name || 'Someone';

// A membership counts as an active "member" unless it's been cancelled. Field names
// are checked defensively so a small upstream rename can't silently drop members.
function isActiveSubscription(s) {
  const c = s.subscription_is_cancelled;
  if (c === true || c === 1 || c === '1' || String(c).toLowerCase() === 'true') return false;
  if (s.subscription_cancelled_on) return false;
  return true;
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
  // One-off coffees are required; if that core call fails, keep the existing file.
  let oneOff;
  try {
    oneOff = await fetchAllPages('supporters');
  } catch (err) {
    console.error(`BMC fetch failed: ${err.message} — leaving supporters.json unchanged.`);
    process.exit(0);
  }
  // Memberships and extra purchases are best-effort: a missing/unsupported endpoint
  // must not blank the wall, so each falls back to an empty list on error.
  const members = await fetchAllPages('subscriptions')
    .catch((e) => { console.error(`subscriptions fetch skipped: ${e.message}`); return []; });
  const extras = await fetchAllPages('extra-purchases')
    .catch((e) => { console.error(`extra-purchases fetch skipped: ${e.message}`); return []; });

  // Aggregate coffees per (raw) name so repeat supporters rank by their total, and
  // remember who is an active member so the site can highlight them specially.
  const totals = new Map();
  const memberNames = new Set();
  const addCoffees = (name, n) => totals.set(name, (totals.get(name) || 0) + (Number(n) || 1));

  for (const s of oneOff) addCoffees(payerOf(s), s.support_coffees);
  for (const s of members) {
    if (!isActiveSubscription(s)) continue;
    memberNames.add(norm(payerOf(s)));
    addCoffees(payerOf(s), s.subscription_coffee_num || s.support_coffees);
  }
  for (const s of extras) addCoffees(payerOf(s), s.support_coffees || s.purchase_quantity);

  // Members rank ahead of equal-coffee one-off supporters so they cluster near the top.
  const ranked = [...totals.entries()].sort((a, b) => {
    const ma = memberNames.has(norm(a[0])) ? 1 : 0;
    const mb = memberNames.has(norm(b[0])) ? 1 : 0;
    return (b[1] - a[1]) || (mb - ma);
  });

  const supporters = [];
  let topsAssigned = 0;
  for (const [rawName] of ranked) {
    const name = displayName(rawName);
    if (!name) continue;
    const entry = { name };
    if (memberNames.has(norm(rawName))) entry.tier = 'member';
    if (topsAssigned < topCount) { entry.top = true; topsAssigned++; }
    supporters.push(entry);
  }

  const payload = {
    _generated: new Date().toISOString(),
    _note: 'Auto-generated from Buy Me a Coffee (one-off supporters + active members + extra purchases) by tools/build-supporters.mjs. Do not edit by hand — change docs/supporters-overrides.json instead. Names are privacy-masked; full names and profile links are never published. Active members carry "tier":"member" and are highlighted on the site.',
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
