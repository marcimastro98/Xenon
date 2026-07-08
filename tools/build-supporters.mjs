#!/usr/bin/env node
/*
 * Builds docs/supporters.json from the Buy Me a Coffee API (and, optionally,
 * GitHub Sponsors) for the website's "Hall of supporters". Privacy-first: full
 * names and profile links are NEVER written to the repo — each name is
 * masked/aliased here, before the file is saved, according to
 * docs/supporters-overrides.json.
 *
 * Env:
 *   BMC_TOKEN        — a Buy Me a Coffee API access token (developers.buymeacoffee.com).
 *                      If missing or the API fails, the existing file is left untouched
 *                      and the script exits 0 (so the GitHub Action never fails).
 *   GH_SPONSORS_TOKEN — (optional) a GitHub token owned by the sponsored account with
 *                      sponsors read access. Only PUBLIC sponsorships are pulled, so
 *                      consent is respected the same way as BMC. If missing/failing,
 *                      GitHub Sponsors are simply skipped.
 *
 * Even with no API tokens at all, supporters listed by hand under
 * `manualSupporters` in docs/supporters-overrides.json are still written out.
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
const hasBmc = !!TOKEN;
if (!hasBmc) {
  console.error('BMC_TOKEN not set — skipping Buy Me a Coffee (GitHub Sponsors / manual list still processed).');
}

// Rough coffee price in USD, used only to weight GitHub Sponsor dollars into the
// same "coffees" ranking unit BMC uses, so one channel can't dominate the crown.
const COFFEE_USD = 5;

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

// Fetches PUBLIC GitHub sponsorships for the token owner's account (both active
// recurring and past one-time). Private sponsorships are excluded so we only ever
// publish supporters who chose to be public — consent parity with the BMC path.
async function fetchGitHubSponsors() {
  const token = process.env.GH_SPONSORS_TOKEN;
  if (!token) {
    console.error('GH_SPONSORS_TOKEN not set — skipping GitHub Sponsors.');
    return [];
  }
  const out = [];
  let after = null;
  // Guard against an unexpected pagination loop.
  for (let page = 0; page < 50; page++) {
    const query = `query($after:String){viewer{sponsorshipsAsMaintainer(first:100,after:$after,includePrivate:false,activeOnly:false){pageInfo{hasNextPage endCursor} nodes{isOneTimePayment tier{monthlyPriceInDollars} sponsorEntity{__typename ... on User{login name} ... on Organization{login name}}}}}}`;
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'xenon-supporters-build',
      },
      body: JSON.stringify({ query, variables: { after } }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (Array.isArray(json.errors) && json.errors.length) {
      throw new Error(json.errors.map((e) => e.message).join('; '));
    }
    const conn = json.data && json.data.viewer && json.data.viewer.sponsorshipsAsMaintainer;
    const nodes = (conn && conn.nodes) || [];
    out.push(...nodes);
    const info = conn && conn.pageInfo;
    if (!info || !info.hasNextPage) break;
    after = info.endCursor;
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
  // One-off coffees are the BMC core; if that call fails, keep the existing file so a
  // transient BMC outage can't blank the wall. When no BMC token is set at all we just
  // skip BMC entirely and rely on GitHub Sponsors / the manual list.
  let oneOff = [];
  if (hasBmc) {
    try {
      oneOff = await fetchAllPages('supporters');
    } catch (err) {
      console.error(`BMC fetch failed: ${err.message} — leaving supporters.json unchanged.`);
      process.exit(0);
    }
  }
  // Memberships and extra purchases are best-effort: a missing/unsupported endpoint
  // must not blank the wall, so each falls back to an empty list on error.
  const members = hasBmc
    ? await fetchAllPages('subscriptions')
        .catch((e) => { console.error(`subscriptions fetch skipped: ${e.message}`); return []; })
    : [];
  const extras = hasBmc
    ? await fetchAllPages('extra-purchases')
        .catch((e) => { console.error(`extra-purchases fetch skipped: ${e.message}`); return []; })
    : [];
  // GitHub Sponsors are optional and best-effort — a failure never blanks the wall.
  const ghSponsors = await fetchGitHubSponsors()
    .catch((e) => { console.error(`GitHub Sponsors fetch skipped: ${e.message}`); return []; });

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
  for (const s of ghSponsors) {
    const ent = s.sponsorEntity;
    if (!ent) continue;
    // Show the public GitHub handle (login), not the profile's real-name field: the
    // login is the identity the sponsor chose publicly and matches the maintainer
    // dashboard, whereas `name` can leak a real first name. `name` stays a fallback.
    const name = ent.login || ent.name;
    if (!name) continue;
    // Weight dollars into coffee-equivalent units so GitHub and BMC rank on one scale;
    // every sponsor counts for at least one.
    const dollars = Number(s.tier && s.tier.monthlyPriceInDollars) || 0;
    addCoffees(name, Math.max(1, Math.round(dollars / COFFEE_USD)));
    // Recurring sponsors are ongoing supporters → highlight like BMC members.
    if (!s.isOneTimePayment) memberNames.add(norm(name));
  }

  // Fold manually-curated supporters into the SAME ranking, so they land in the right
  // podium spot instead of being tacked on at the end. Used for channels the APIs don't
  // cover yet (e.g. a GitHub Sponsor before GH_SPONSORS_TOKEN is set). Each is shown
  // verbatim (no masking) — only list a name the person is happy to show publicly. Item
  // shape: a string, or { name, tier:"member", top:true, coffees:N }. `top:true` pins
  // them to the front of the podium (#1); `coffees` lets them rank naturally by amount;
  // `tier:"member"` highlights them. A manual name equal to one an API already returns is
  // merged (not duplicated), so it's safe to leave a manual entry in place afterwards.
  const manual = Array.isArray(overrides.manualSupporters) ? overrides.manualSupporters : [];
  const manualDisplay = new Map(); // norm(name) -> verbatim display name (bypasses masking)
  const forceTop = new Set();      // norm(name) -> pinned to the front of the ranking
  // Names an API source (BMC / GitHub Sponsors) already ranked. A manual entry for the
  // same person then ONLY refines the display name — it must not add its `coffees` again,
  // or the doubled weight would wrongly keep them above a genuinely bigger donor once the
  // API takes over. So `coffees` is a fallback that yields to the real amount.
  const apiNames = new Set([...totals.keys()].map(norm));
  for (const m of manual) {
    const rawName = (typeof m === 'string' ? m : (m && m.name)) || '';
    const name = String(rawName).trim();
    if (!name) continue;
    const key = norm(name);
    manualDisplay.set(key, name);
    const coffees = (m && typeof m === 'object' && Number.isFinite(m.coffees)) ? m.coffees : 0;
    if (!apiNames.has(key)) addCoffees(name, coffees); // fallback weight only until an API ranks them
    if (m && typeof m === 'object' && m.tier === 'member') memberNames.add(key);
    if (m && typeof m === 'object' && m.top) forceTop.add(key);
  }

  // Rank by: pinned-manual first, then coffee total, then members ahead of equal one-off.
  const ranked = [...totals.entries()].sort((a, b) => {
    const fa = forceTop.has(norm(a[0])) ? 1 : 0;
    const fb = forceTop.has(norm(b[0])) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const ma = memberNames.has(norm(a[0])) ? 1 : 0;
    const mb = memberNames.has(norm(b[0])) ? 1 : 0;
    return (b[1] - a[1]) || (mb - ma);
  });

  // Resolve display names (manual verbatim; everyone else masked/aliased/hidden), then
  // crown the top `topCount` as the podium with an explicit 1-based rank (1/2/3).
  const supporters = [];
  for (const [rawName] of ranked) {
    const key = norm(rawName);
    const name = manualDisplay.has(key) ? manualDisplay.get(key) : displayName(rawName);
    if (!name) continue; // hidden
    const entry = { name };
    if (memberNames.has(key)) entry.tier = 'member';
    if (supporters.length < topCount) { entry.top = true; entry.rank = supporters.length + 1; }
    supporters.push(entry);
  }

  // Never blank an existing wall on an empty result (e.g. all tokens missing and no
  // manual entries) — leave whatever is already published in place.
  if (supporters.length === 0) {
    console.log('No supporters resolved from any source — leaving supporters.json unchanged.');
    process.exit(0);
  }

  const payload = {
    _generated: new Date().toISOString(),
    _note: 'Auto-generated from Buy Me a Coffee + GitHub Sponsors (plus any manualSupporters) by tools/build-supporters.mjs. Do not edit by hand — change docs/supporters-overrides.json instead. Names are privacy-masked (manual entries show as typed); full names and profile links are never published. Active members / recurring sponsors carry "tier":"member" and are highlighted on the site.',
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
