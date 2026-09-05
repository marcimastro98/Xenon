// A slider for one person in your voice channel.
//
// Discord lets you set the volume of a single person, and mute them for yourself
// only. Xenon has driven both since 4.11 — but only as an SDK action, so the one
// way to use the feature was to write a widget. Someone who had asked for it went
// looking for the setting and found none, which is a fair thing to be confused
// about: there wasn't one.
//
// The engine is unchanged. What is new is the control, and the rules below are
// the ones that keep it honest about whose state it is showing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../js/discord-widget.js', import.meta.url), 'utf8');
const RPC = readFileSync(new URL('../discord-rpc.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/DiscordWidget/DiscordWidget.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// The two pure decisions are lifted out and RUN: which names become buttons, and
// what the volume reads. Everything else about this widget needs a browser and a
// running Discord.
function lift(name) {
  const at = WIDGET.indexOf('function ' + name + '(');
  assert.notEqual(at, -1, `js/discord-widget.js must still define ${name}`);
  const end = WIDGET.indexOf('\n  }', at) + 4;
  // eslint-disable-next-line no-new-func
  return WIDGET.slice(at, end);
}
const canAdjust = new Function(`${lift('canAdjust')}; return canAdjust;`)();

const inCall = (selfId) => ({ channel: { id: 'c1', name: 'General' }, selfId, members: [] });

// ── Whose row is a button ────────────────────────────────────────────────────

test('everyone in the call gets controls', () => {
  const voice = inCall('111');
  const fn = new Function('voice', `${lift('canAdjust')}; return canAdjust;`)(voice);
  assert.equal(fn({ id: '222', name: 'Forlin' }), true);
});

test('your own row is not a button', () => {
  // Discord has no per-user setting for your own account — your levels are the
  // mic and output rows above — and the server answers `self_not_supported`. A
  // slider that cannot work must not be offered.
  const voice = inCall('111');
  const fn = new Function('voice', `${lift('canAdjust')}; return canAdjust;`)(voice);
  assert.equal(fn({ id: '111', name: 'You' }), false);
  assert.match(RPC, /if \(id === await selfUserId\(\)\) return \{ ok: false, error: 'self_not_supported' \};/,
    'and the server still refuses it, since the widget is not the boundary');
});

test('nobody gets controls when you are not in a call', () => {
  // The roster in the Channels tab lists people in OTHER channels. Discord only
  // accepts these settings for someone in the channel you are in, and answers OK
  // for anyone else — a control that reports success and changes nothing.
  const fn = new Function('voice', `${lift('canAdjust')}; return canAdjust;`)({ channel: null, selfId: '111', members: [] });
  assert.equal(fn({ id: '222', name: 'Forlin' }), false);
  assert.match(RPC, /\{ ok: false, error: 'user_not_here' \}/);
});

test('a member with no id is never actionable', () => {
  const fn = new Function('voice', `${lift('canAdjust')}; return canAdjust;`)(inCall('111'));
  for (const m of [null, {}, { name: 'x' }, { id: '' }]) assert.equal(fn(m), false, JSON.stringify(m));
});

// ── What it shows ────────────────────────────────────────────────────────────

test('an unreported volume reads as a dash, never as 100', () => {
  // channelMembers sends null rather than a default precisely so this cannot
  // show a number for a setting the machine may not be in. Printing 100 there
  // would be inventing the answer.
  assert.match(WIDGET, /m\.volume == null \? '—' : String\(m\.volume\)/);
  assert.match(RPC, /volume: Number\.isFinite\(vs\.volume\) \? Math\.round\(vs\.volume\) : null/);
});

test('"I turned them down" is drawn differently from "they muted themselves"', () => {
  // Two different facts sharing one row. If they shared one marker, turning
  // someone down would look exactly like their own microphone being off.
  assert.match(WIDGET, /chip\.classList\.toggle\('is-local-muted', !!m\.localMute\)/);
  assert.match(WIDGET, /chip\.classList\.toggle\('is-muted', !!\(m\.mute \|\| m\.deaf\)\)/);
  assert.match(CSS, /\.dc-member\.is-local-muted \{/);
  assert.match(CSS, /\.dc-member\.is-muted \{/);
});

test('the panel is rebuilt on every paint, so it follows Discord', () => {
  // The SSE push lands in the same paint. Building it once on open would leave
  // the number at whatever it was when the row was tapped.
  assert.match(WIDGET, /fillMemberCtl\(call\.querySelector\('\.dc-call-mctl'\)\)/);
  const body = WIDGET.slice(WIDGET.indexOf('function fillMemberCtl('));
  assert.match(body.slice(0, 900), /callMembers\(\)\.find\(x => x\.id === openMember\)/);
});

test('a person who leaves takes their open panel with them', () => {
  const body = WIDGET.slice(WIDGET.indexOf('function fillMemberCtl('), WIDGET.indexOf('function fillMemberCtl(') + 900);
  assert.match(body, /if \(!m \|\| !canAdjust\(m\)\) \{ openMember = ''; .*box\.hidden = true; return; \}/);
  assert.match(WIDGET, /openMember = '';   \/\/ left the call/);
});

// ── The wiring ───────────────────────────────────────────────────────────────

test('the controls send the actions that already existed', () => {
  assert.match(WIDGET, /\{ type: 'discordUserVol', user: m\.id, mode: 'down' \}/);
  assert.match(WIDGET, /\{ type: 'discordUserVol', user: m\.id, mode: 'up' \}/);
  assert.match(WIDGET, /\{ type: 'discordUserMute', user: m\.id, mode: 'toggle' \}/);
  assert.match(RPC, /case 'discordUserVol':  return await setUserVolume\(a\.user, a\.mode, a\.value\);/,
    'no new server surface: this is the SDK action, given a button');
});

test('the widget is told which member is you', () => {
  assert.match(RPC, /const selfId = await selfUserId\(\);/);
  assert.match(RPC, /channel, members, selfId,/);
});

test('every label exists in all 11 languages', () => {
  for (const key of ['dc_member_vol', 'dc_member_mute', 'dc_member_unmute']) {
    const n = I18N.split('\n').filter((l) => l.trimStart().startsWith(key + ':') || l.trimStart().startsWith('"' + key + '":')).length;
    assert.equal(n, 11, `${key} is in ${n} languages, not 11`);
  }
});
