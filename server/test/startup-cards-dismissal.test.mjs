// The two startup cards' "don't show again" — What's New (js/update.js) and the
// Discord invite (js/discord-invite.js).
//
// Both flags lived ONLY in localStorage until v4.11.6, which made a permanent
// choice exactly as durable as the browser's site data: "clear cookies and site
// data when you close all windows", a private window, or a cleanup tool put both
// cards back at EVERY boot with "don't show again" already pressed. Reported on
// Discord by a user who had pressed it and kept being asked. They also never
// crossed surfaces — the native WebView and a real browser are separate stores
// on the identical 127.0.0.1:3030 URL.
//
// So the flags moved into hub settings (a file on the PC). What this file pins
// is the part that is easy to get quietly wrong: the two sources must be read as
// an OR and written as a pair, and the one-time promotion must never let a stale
// local value overwrite a newer remote one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const UPDATE = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
const DISCORD = readFileSync(new URL('../js/discord-invite.js', import.meta.url), 'utf8');

// ── Harness ──────────────────────────────────────────────────────────────────
// The accessors are a self-contained block in js/settings.js — a browser file
// far too entangled to import whole — so the block is lifted out and run against
// stubs. That keeps these tests about BEHAVIOUR (what a read returns, what a
// write touches) rather than about the shape of the source, which is what the
// regression actually was.

function cardsBlock() {
  const at = CLIENT.indexOf('const LEGACY_CARD_KEYS = {');
  assert.notEqual(at, -1, 'js/settings.js must still define LEGACY_CARD_KEYS');
  const end = CLIENT.indexOf('const STARTUP_CARD_WAIT_MS', at);
  assert.notEqual(end, -1, 'the accessors must still be followed by the ready-gate');
  return CLIENT.slice(at, end);
}

/** A localStorage that can be pre-filled, watched, or made to throw outright. */
function fakeStorage({ seed = {}, broken = false } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(k) { if (broken) throw new Error('storage disabled'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('storage disabled'); map.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('storage disabled'); map.delete(k); },
  };
}

function load({ settings = {}, storage = fakeStorage() } = {}) {
  const saves = [];
  const factory = new Function('ctx', `
    let hubSettings = ctx.settings;
    const localStorage = ctx.storage;
    const normalizeSettings = (v) => ({ ...v });
    const saveHubSettings = () => ctx.saves.push({ ...hubSettings });
    ${cardsBlock()}
    return {
      settings: () => hubSettings,
      whatsNewDismissed,
      rememberWhatsNewSeen,
      discordInviteDismissed,
      rememberDiscordInviteSeen,
      promoteLegacySeenFlags,
      LEGACY_CARD_KEYS,
    };
  `);
  return { ...factory({ settings, storage, saves }), storage, saves };
}

// ── The reported bug ─────────────────────────────────────────────────────────

// The whole point of the change. Site data wiped on exit, dismissal on disk:
// the card must stay down.
test('a dismissal on the server survives a browser that wiped its site data', () => {
  const c = load({ settings: { whatsNewSeen: '4.11.0', discordInviteSeen: true }, storage: fakeStorage() });
  assert.equal(c.whatsNewDismissed('4.11.0'), true);
  assert.equal(c.discordInviteDismissed(), true);
});

// The other half: a dismissal made on this device holds even before it has been
// promoted, and even if the save never reaches the server at all.
test('a dismissal held only in the legacy key still counts', () => {
  const c = load({
    settings: {},
    storage: fakeStorage({ seed: { 'xenon.whatsnew.dismissed': '4.11.0', 'xenonedge.discordInvite.v1': 'dismissed' } }),
  });
  assert.equal(c.whatsNewDismissed('4.11.0'), true);
  assert.equal(c.discordInviteDismissed(), true);
});

test('nothing dismissed anywhere means both cards may show', () => {
  const c = load();
  assert.equal(c.whatsNewDismissed('4.11.0'), false);
  assert.equal(c.discordInviteDismissed(), false);
});

// ── Writes go to both places ─────────────────────────────────────────────────

// Server-only would reintroduce the bug from the other side: a save that never
// lands (offline, a restart mid-queue) would leave the card un-dismissed on the
// very device the user just pressed the button on.
test('a dismissal is written to the server AND to the device', () => {
  const c = load();
  c.rememberWhatsNewSeen('4.11.0');
  c.rememberDiscordInviteSeen();
  assert.equal(c.settings().whatsNewSeen, '4.11.0');
  assert.equal(c.settings().discordInviteSeen, true);
  assert.equal(c.storage.map.get('xenon.whatsnew.dismissed'), '4.11.0');
  assert.equal(c.storage.map.get('xenonedge.discordInvite.v1'), 'dismissed');
  assert.equal(c.saves.length, 2, 'each dismissal persists once');
});

// The third failure mode behind the report: storage that throws outright (a
// WebView with site data disabled, a corrupt profile). Every write used to be
// wrapped in `catch {}`, so the button worked visually and remembered nothing,
// with no trace anywhere. The server copy has to carry it.
test('a device whose storage throws still gets a durable dismissal', () => {
  const c = load({ settings: {}, storage: fakeStorage({ broken: true }) });
  c.rememberWhatsNewSeen('4.11.0');
  c.rememberDiscordInviteSeen();
  assert.equal(c.settings().whatsNewSeen, '4.11.0');
  assert.equal(c.settings().discordInviteSeen, true);
  assert.equal(c.saves.length, 2);
});

test('re-dismissing what is already stored saves nothing', () => {
  const c = load({ settings: { whatsNewSeen: '4.11.0', discordInviteSeen: true } });
  c.rememberWhatsNewSeen('4.11.0');
  c.rememberDiscordInviteSeen();
  assert.equal(c.saves.length, 0);
});

// ── A new release still gets announced ───────────────────────────────────────
// The flag stores an id, not a boolean, so "don't show again" must silence THIS
// release and not every future one. A truthy-only check here would mute the
// modal for good — the opposite bug, and a silent one.
test('dismissing one release does not mute the next', () => {
  const c = load({ settings: { whatsNewSeen: '4.11.0' } });
  assert.equal(c.whatsNewDismissed('4.11.0'), true);
  assert.equal(c.whatsNewDismissed('4.12.0'), false);
});

test('an empty or missing id is never treated as dismissed', () => {
  const c = load({ settings: { whatsNewSeen: '' } });
  assert.equal(c.whatsNewDismissed(''), false);
  assert.equal(c.whatsNewDismissed(undefined), false);
  // …and an empty id is never written, or it would look like "seen" forever.
  c.rememberWhatsNewSeen('');
  assert.equal(c.saves.length, 0);
});

// ── The one-time promotion ───────────────────────────────────────────────────

test('a pre-v4.11.6 dismissal is promoted to the server once', () => {
  const c = load({
    settings: {},
    storage: fakeStorage({ seed: { 'xenon.whatsnew.dismissed': '4.11.0', 'xenonedge.discordInvite.v1': 'dismissed' } }),
  });
  c.promoteLegacySeenFlags();
  assert.equal(c.settings().whatsNewSeen, '4.11.0');
  assert.equal(c.settings().discordInviteSeen, true);
  const saves = c.saves.length;
  c.promoteLegacySeenFlags();
  assert.equal(c.saves.length, saves, 'promotion is idempotent — it must not re-save every boot');
});

// The rule that makes the migration safe. Dismissed on the desktop yesterday,
// this laptop still carries an older local id: promoting it would overwrite the
// newer answer for every surface at once.
test('promotion never overwrites a value the server already holds', () => {
  const c = load({
    settings: { whatsNewSeen: '4.12.0', discordInviteSeen: true },
    storage: fakeStorage({ seed: { 'xenon.whatsnew.dismissed': '4.11.0' } }),
  });
  c.promoteLegacySeenFlags();
  assert.equal(c.settings().whatsNewSeen, '4.12.0');
  assert.equal(c.saves.length, 0);
});

test('promotion does nothing when there is nothing to promote', () => {
  const c = load();
  c.promoteLegacySeenFlags();
  assert.equal(c.saves.length, 0);
});

// ── Pinned against the source ────────────────────────────────────────────────

// The highest-stakes constants in the change. Rename either and every dismissal
// made before v4.11.6 is silently discarded — which is the exact complaint this
// fix answers, reintroduced by a typo.
test('the legacy key names are the ones already on disk', () => {
  const c = load();
  assert.equal(c.LEGACY_CARD_KEYS.whatsNewSeen, 'xenon.whatsnew.dismissed');
  assert.equal(c.LEGACY_CARD_KEYS.discordInviteSeen, 'xenonedge.discordInvite.v1');
});

// Server and client rebuild the blob independently; a key only one of them emits
// is reset to its default on every save from the other surface.
test('both sides declare the keys with the same default and rule', () => {
  for (const src of [SERVER, CLIENT]) {
    assert.match(src, /^\s*whatsNewSeen: '',$/m);
    assert.match(src, /^\s*discordInviteSeen: false,$/m);
  }
  assert.match(SERVER, /whatsNewSeen: typeof source\.whatsNewSeen === 'string'/);
  assert.match(SERVER, /discordInviteSeen: source\.discordInviteSeen === true/);
  assert.match(CLIENT, /whatsNewSeen: typeof value\.whatsNewSeen === 'string'/);
  assert.match(CLIENT, /discordInviteSeen: value\.discordInviteSeen === true/);
});

// One owner for the flags. A module that kept its own localStorage call would
// drift from the stored answer the moment the other surface wrote one.
test('neither card module reaches storage on its own any more', () => {
  // Matched against CALLS, not prose: both files explain the move in a comment
  // that names the old storage, and update.js still keeps three unrelated keys
  // of its own (the skipped version, the apply-result ack, the shell-error flag).
  assert.doesNotMatch(UPDATE, /xenon\.whatsnew\.dismissed/, 'update.js must go through XenonStartupCards');
  assert.doesNotMatch(DISCORD, /localStorage\s*\./, 'discord-invite.js must go through XenonStartupCards');
  assert.doesNotMatch(DISCORD, /xenonedge\.discordInvite/, 'the legacy key has one owner: js/settings.js');
});

// Both cards decide AFTER hydration. Before it, the settings copy is the blind
// local mirror — empty on exactly the machines this fix is for — so an
// un-gated read would put the card up over a dismissal sitting on disk.
test('both cards wait for the stored answer before deciding', () => {
  assert.match(DISCORD, /whenReady\(decide\)/);
  assert.match(UPDATE, /c\.whenReady\(resolve\)/);
  // …and the wait is bounded, or a backend that never answers means a dashboard
  // that never shows either card again.
  assert.match(CLIENT, /_startupCardTimer = setTimeout\(flushStartupCardWaiters, STARTUP_CARD_WAIT_MS\)/);
});

// Promotion needs the server's copy in hand to tell "nothing stored" from "not
// asked yet", so it may only run from the hydration completion.
test('promotion is wired to hydration, not to load', () => {
  assert.match(CLIENT, /function markHubHydrated\(\)[\s\S]{0,600}promoteLegacySeenFlags\(\)/);
  assert.doesNotMatch(CLIENT, /^\s*promoteLegacySeenFlags\(\);$/m);
});
