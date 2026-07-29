import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const calls = require('../calls.js');

// The capability table is the contract between "we detected a call" and "the
// card shows a button". Every false here is a button that must NOT be drawn,
// and every true is a promise the act() path has to keep.

const discordCall = { source: 'discord', appId: 'discord', channelId: '123456789012345', caller: 'Marco' };
const teamsCall = { source: 'notification', appId: 'teams', caller: 'Marco', video: false };
const zoomCall = { source: 'notification', appId: 'zoom', caller: 'Marco', video: false };

const full = { platform: 'win32', hotkey: true, windowTool: true, discordLinked: true, apps: [] };

test('Discord answers over RPC, and never claims a decline it does not have', () => {
  const caps = calls.capabilitiesFor(discordCall, full);
  assert.equal(caps.answer, true);
  assert.equal(caps.via, 'rpc');
  assert.equal(caps.decline, false, 'Discord RPC has no decline command');
  assert.equal(caps.silence, true);
});

test('Discord cannot answer when the account is not linked', () => {
  assert.equal(calls.capabilitiesFor(discordCall, { ...full, discordLinked: false }).answer, false);
});

test('Discord cannot answer without a usable channel id', () => {
  for (const channelId of ['', 'abc', null, '12', undefined]) {
    assert.equal(calls.capabilitiesFor({ ...discordCall, channelId }, full).answer, false, `channel ${channelId}`);
  }
});

test('Teams and Zoom answer by shortcut when key sending exists', () => {
  for (const c of [teamsCall, zoomCall]) {
    const caps = calls.capabilitiesFor(c, full);
    assert.equal(caps.answer, true, `${c.appId} answer`);
    assert.equal(caps.decline, true, `${c.appId} decline`);
    assert.equal(caps.via, 'hotkey');
  }
});

test('without key sending the card offers only open and silence', () => {
  const caps = calls.capabilitiesFor(teamsCall, { ...full, hotkey: false });
  assert.equal(caps.answer, false, 'this is the Linux-without-ydotool case');
  assert.equal(caps.decline, false);
  assert.equal(caps.open, true);
  assert.equal(caps.silence, true);
});

test('a shortcut is useless without a window to send it to', () => {
  const caps = calls.capabilitiesFor(teamsCall, { ...full, windowTool: false });
  assert.equal(caps.answer, false, 'these are in-app shortcuts, they need the window focused');
  assert.equal(caps.open, false);
});

test('an app we have no control over gets the honest fallback only', () => {
  const caps = calls.capabilitiesFor({ source: 'notification', appId: 'whatsapp' }, full);
  assert.equal(caps.answer, false);
  assert.equal(caps.decline, false);
  assert.equal(caps.open, true);
});

// ── The combos ─────────────────────────────────────────────────────────────

test('Teams accepts video with a different key than audio', () => {
  const teams = calls.entryFor('teams');
  assert.equal(calls.comboFor(teams, 'answer', { platform: 'win32', video: false }), 'ctrl+shift+s');
  assert.equal(calls.comboFor(teams, 'answer', { platform: 'win32', video: true }), 'ctrl+shift+a');
  assert.equal(calls.comboFor(teams, 'decline', { platform: 'win32' }), 'ctrl+shift+d');
});

test('on macOS Teams moves to Command and Zoom stays on Control', () => {
  const teams = calls.entryFor('teams');
  const zoom = calls.entryFor('zoom');
  assert.equal(calls.comboFor(teams, 'answer', { platform: 'darwin' }), 'cmd+shift+s');
  assert.equal(calls.comboFor(teams, 'decline', { platform: 'darwin' }), 'cmd+shift+d');
  assert.equal(calls.comboFor(zoom, 'answer', { platform: 'darwin' }), 'ctrl+shift+a',
    'Zoom documents Control on macOS — sending Command would hit the wrong app');
});

test('an app with no combo returns nothing rather than a guess', () => {
  assert.equal(calls.comboFor(calls.entryFor('phonelink'), 'answer', { platform: 'win32' }), '');
  assert.equal(calls.comboFor(null, 'answer', { platform: 'win32' }), '');
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

let sent, pushed, settings;

function wire(overrides) {
  sent = [];
  pushed = [];
  settings = { enabled: true, allowed: null, apps: [], push: true };
  calls._resetForTest();
  calls.init({
    platform: 'win32',
    broadcast: (evt, payload) => sent.push({ evt, payload }),
    push: (m) => pushed.push(m),
    getSettings: () => settings,
    getLanguage: () => 'it',
    hotkeyAvailable: () => true,
    listWindows: async () => ({ windows: [{ id: '42', app: 'Teams', title: 'Microsoft Teams' }] }),
    focusWindow: async () => ({ ok: true }),
    sendHotkey: async () => ({ ok: true }),
    discordLinked: () => true,
    discordJoin: async () => ({ ok: true }),
    ...overrides,
  });
}

beforeEach(() => wire());

const teamsToast = { app: 'Microsoft Teams', aumid: 'MSTeams_8wekyb3d8bbwe!MSTeams', title: 'Marco Rossi', body: 'Incoming call' };

test('a ring becomes a card and is broadcast to every surface', () => {
  const rec = calls.onNotification(teamsToast);
  assert.ok(rec, 'the toast rings');
  const live = calls.current();
  assert.equal(live.length, 1);
  assert.equal(live[0].caller, 'Marco Rossi');
  assert.equal(sent.at(-1).evt, 'calls');
  assert.equal(sent.at(-1).payload.calls.length, 1);
});

test('the projected card carries no combos, window ids or raw notification', () => {
  calls.onNotification(teamsToast);
  const card = calls.current()[0];
  const json = JSON.stringify(card);
  assert.ok(!/ctrl\+shift/.test(json), 'a key combo never travels to the client');
  assert.deepEqual(Object.keys(card).sort(), [
    'appId', 'appName', 'at', 'caller', 'caps', 'detail', 'endsAt', 'icon', 'id', 'silenced', 'source', 'video',
  ]);
});

test('the same ring announced twice raises one card', () => {
  calls.onNotification(teamsToast);
  calls.onNotification(teamsToast);
  assert.equal(calls.current().length, 1, 'a re-seed or a second toast is the same call');
});

test('a different caller during the same ring is a different call', () => {
  calls.onNotification(teamsToast);
  calls.onNotification({ ...teamsToast, title: 'Anna Bianchi' });
  assert.equal(calls.current().length, 2);
});

test('nothing rings while the feature is off', () => {
  settings.enabled = false;
  assert.equal(calls.onNotification(teamsToast), null);
  assert.equal(calls.current().length, 0);
});

test('turning the feature off clears a card that is already ringing', () => {
  calls.onNotification(teamsToast);
  assert.equal(calls.current().length, 1);
  settings.enabled = false;
  calls.applySettings();
  assert.equal(calls.current().length, 0, 'a card nobody can answer must not stay on screen');
});

test('an incoming call wakes a phone, in the language the dashboard is set to', () => {
  calls.onNotification(teamsToast);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].title, 'Chiamata in arrivo');
  assert.match(pushed[0].body, /Marco Rossi/);
});

test('the push can be turned off without turning the card off', () => {
  settings.push = false;
  calls.onNotification(teamsToast);
  assert.equal(pushed.length, 0);
  assert.equal(calls.current().length, 1);
});

test('silence marks the card silenced on every surface instead of closing it', async () => {
  const rec = calls.onNotification(teamsToast);
  const r = await calls.act(rec.id, 'silence');
  assert.equal(r.ok, true);
  assert.equal(calls.current()[0].silenced, true, 'the phone silencing it must silence the Edge too');
});

test('answering Teams focuses the window first, then sends the combo', async () => {
  const order = [];
  wire({
    listWindows: async () => { order.push('list'); return { windows: [{ id: '42', app: 'Teams', title: 'Microsoft Teams' }] }; },
    focusWindow: async () => { order.push('focus'); return { ok: true }; },
    sendHotkey: async (k) => { order.push('key:' + k); return { ok: true }; },
  });
  const rec = calls.onNotification(teamsToast);
  const r = await calls.act(rec.id, 'answer');
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['list', 'focus', 'key:ctrl+shift+s']);
  assert.equal(calls.current().length, 0, 'an answered call stops ringing');
});

test('answering Discord joins the channel and never touches the keyboard', async () => {
  let joined = '';
  let keyed = false;
  wire({
    discordJoin: async (id) => { joined = id; return { ok: true }; },
    sendHotkey: async () => { keyed = true; return { ok: true }; },
  });
  const rec = calls.onDiscordNotification({ title: 'Marco', body: '', channelId: '123456789012345', messageType: 3 });
  assert.ok(rec);
  const r = await calls.act(rec.id, 'answer');
  assert.equal(r.ok, true);
  assert.equal(joined, '123456789012345');
  assert.equal(keyed, false);
});

test('a button the card was never allowed to draw is refused by the server too', async () => {
  wire({ hotkeyAvailable: () => false });
  const rec = calls.onNotification(teamsToast);
  assert.equal(rec.caps.answer, false);
  const r = await calls.act(rec.id, 'answer');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unavailable');
  assert.equal(calls.current().length, 1, 'a refused action leaves the call ringing');
});

test('a failure to reach the app is reported, not swallowed as success', async () => {
  wire({ listWindows: async () => ({ windows: [] }) });
  const rec = calls.onNotification(teamsToast);
  const r = await calls.act(rec.id, 'answer');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'window_not_found');
  assert.equal(calls.current().length, 1, 'the card stays so the user can still open the app');
});

test('acting on a call that already stopped ringing says so', async () => {
  const r = await calls.act('nope', 'answer');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_ringing');
});

test('an unknown action is refused', async () => {
  const rec = calls.onNotification(teamsToast);
  assert.equal((await calls.act(rec.id, 'hangup')).ok, false);
});

test('at most three calls are held at once', () => {
  for (const name of ['A', 'B', 'C', 'D', 'E']) calls.onNotification({ ...teamsToast, title: name });
  assert.equal(calls.current().length, calls.MAX_ACTIVE);
  assert.equal(calls.current()[0].caller, 'E', 'newest first');
});

test('stop clears everything, so shutdown leaves no card and no timer', () => {
  calls.onNotification(teamsToast);
  calls.stop();
  assert.equal(calls.current().length, 0);
  calls._resetForTest();
});

// ── The end of a ring ──────────────────────────────────────────────────────
// Found the hard way, on a real Discord call: the classifier correctly REFUSED
// to raise a card for "call ended", and so the card already on screen sat there
// until its 45-second timeout even though the caller had hung up. The end
// notification is the only thing that ever says a ring is over, so it is read
// as a signal and not only as a veto.

test('a Discord call that ends stops ringing immediately', async () => {
  wire();
  const rec = calls.onDiscordNotification({ title: 'Nani00', body: 'Nani00 ha avviato una chiamata.', channelId: '199737254929760257', messageType: 3 });
  assert.ok(rec, 'the real wording from a live call must ring');
  assert.equal(calls.current().length, 1);
  calls.onDiscordNotification({ title: 'Nani00', body: 'Chiamata terminata', channelId: '199737254929760257', messageType: 3 });
  assert.equal(calls.current().length, 0, 'the hang-up must take the card down');
});

test('the end of one call does not touch another', () => {
  wire();
  calls.onDiscordNotification({ title: 'Nani00', body: 'ha avviato una chiamata', channelId: '111111111111111', messageType: 3 });
  calls.onDiscordNotification({ title: 'Anna', body: 'ha avviato una chiamata', channelId: '222222222222222', messageType: 3 });
  assert.equal(calls.current().length, 2);
  calls.onDiscordNotification({ title: 'Anna', body: 'Chiamata terminata', channelId: '222222222222222', messageType: 3 });
  const left = calls.current();
  assert.equal(left.length, 1);
  assert.equal(left[0].caller, 'Nani00', 'the channel identifies which call ended');
});

test('a missed-call toast takes down the card it belongs to', () => {
  wire();
  const toast = { app: 'Microsoft Teams', aumid: 'MSTeams_8wekyb3d8bbwe!MSTeams', title: 'Marco Rossi', body: 'Incoming call' };
  assert.ok(calls.onNotification(toast));
  assert.equal(calls.current().length, 1);
  calls.onNotification({ ...toast, body: 'Missed call' });
  assert.equal(calls.current().length, 0);
});

test('calling straight back rings again instead of being deduped away', () => {
  wire();
  const ch = '199737254929760257';
  calls.onDiscordNotification({ title: 'Nani00', body: 'ha avviato una chiamata', channelId: ch, messageType: 3 });
  calls.onDiscordNotification({ title: 'Nani00', body: 'Chiamata terminata', channelId: ch, messageType: 3 });
  assert.equal(calls.current().length, 0);
  // Same channel, well inside the dedupe window. Ending the call has to clear
  // its key or the call back is silently swallowed.
  const again = calls.onDiscordNotification({ title: 'Nani00', body: 'ha avviato una chiamata', channelId: ch, messageType: 3 });
  assert.ok(again, 'a call back after a hang-up is a new call');
  assert.equal(calls.current().length, 1);
});

test('an end notification for a call that is not ringing changes nothing', () => {
  wire();
  assert.doesNotThrow(() => calls.onDiscordNotification({ title: 'x', body: 'Chiamata terminata', channelId: '199737254929760257', messageType: 3 }));
  assert.equal(calls.current().length, 0);
});

// ── The toast vanishing IS the end of the ring ──────────────────────────────
// Measured on a real phone call mirrored through Phone Link: the ringing toast
// sits in Action Center while it rings and is GONE the instant you hang up, and
// nothing is posted in its place. So there is no "ended" notification to read
// for that source, and the only end signal is the toast's disappearance.

const phoneToast = (srcId) => ({
  app: 'Collegamento al telefono', aumid: 'Microsoft.YourPhone_8wekyb3d8bbwe!App',
  title: 'Amore', body: 'Chiamata in arrivo', at: Date.now(), srcId,
});

test('a card closes when the toast that raised it leaves Action Center', () => {
  wire();
  const rec = calls.onNotification(phoneToast(4242));
  assert.ok(rec);
  calls.onNotificationsPresent([4242, 7]);      // still there
  assert.equal(calls.current().length, 1);
  calls.onNotificationsPresent([7]);            // hung up
  assert.equal(calls.current().length, 0);
});

test('a set that never contained the toast is not read as a removal', () => {
  // The reader's ids reset when its child restarts. Treating the first fresh
  // set as proof of removal would kill a live ring for no reason.
  wire();
  calls.onNotification(phoneToast(4242));
  calls.onNotificationsPresent([1, 2, 3]);      // a new session, our id never seen
  assert.equal(calls.current().length, 1, 'absence only counts once presence was observed');
  calls.onNotificationsPresent([4242]);
  calls.onNotificationsPresent([1]);
  assert.equal(calls.current().length, 0);
});

test('a Discord card is untouched by Action Center', () => {
  wire();
  calls.onDiscordNotification({ title: 'Nani00', body: 'ha avviato una chiamata', channelId: '199737254929760257', messageType: 3 });
  calls.onNotificationsPresent([]);
  assert.equal(calls.current().length, 1, 'Discord has no toast to lose');
});

test('an older reader that never reports presence changes nothing', () => {
  wire();
  calls.onNotification({ ...phoneToast(undefined), srcId: undefined });
  assert.equal(calls.current().length, 1);
  calls.onNotificationsPresent([1, 2]);
  assert.equal(calls.current().length, 1, 'no id means no opinion, not a removal');
});

test('hanging up clears the dedupe so an immediate call back rings', () => {
  wire();
  calls.onNotification(phoneToast(10));
  calls.onNotificationsPresent([10]);
  calls.onNotificationsPresent([]);
  assert.equal(calls.current().length, 0);
  const again = calls.onNotification(phoneToast(11));
  assert.ok(again, 'the same caller ringing back is a new call');
});

test('presence with nothing ringing is a no-op', () => {
  wire();
  assert.doesNotThrow(() => calls.onNotificationsPresent([1, 2, 3]));
  assert.doesNotThrow(() => calls.onNotificationsPresent(null));
});

// ── The paired phone: the structural source ────────────────────────────────
// Every other non-Discord path reads notification TEXT and can therefore miss a
// call it did not recognise, or fire on a message that merely mentioned one.
// This one is the OS reporting that a call exists. So the tests here are about
// the seam: the fact raises the card, the toast is demoted to naming it, and
// neither is allowed to produce two cards for one call.

test('the OS reporting a ring raises a card, nameless and honest about it', () => {
  wire();
  const rec = calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  assert.ok(rec, 'a structural ring is a card');
  const card = calls.current()[0];
  assert.equal(card.source, 'phone');
  assert.equal(card.appName, 'iPhone');
  assert.equal(card.caller, '', 'the signal carries no caller — inventing one would be worse than none');
  assert.equal(card.caps.answer, false, 'the HFP channel belongs to the OS');
  assert.equal(card.caps.decline, false);
  assert.equal(card.caps.open, false, 'there is no application to bring forward');
  assert.equal(card.caps.silence, true);
});

test('a mirror toast names the ringing card instead of raising a second one', () => {
  wire();
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  const named = calls.onNotification(phoneToast(7));
  assert.equal(calls.current().length, 1, 'one call must never produce two cards');
  assert.equal(named.caller, 'Amore');
  assert.equal(calls.current()[0].caller, 'Amore');
  assert.equal(calls.current()[0].source, 'phone', 'the structural card stays the card');
});

test('a second mirror toast cannot overwrite a name that is already right', () => {
  wire();
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  calls.onNotification(phoneToast(7));
  calls.onNotification({ ...phoneToast(8), title: 'Qualcun altro' });
  assert.equal(calls.current()[0].caller, 'Amore');
});

test('a mirror toast long after the ring is a different notification', () => {
  wire();
  const rec = calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  rec.at = Date.now() - 60000;                 // the ring started a minute ago
  calls.onNotification(phoneToast(7));
  // It is free to raise its own card — a toast that reads like a ring, long
  // after an unrelated one, is its own call. What it must not do is put a name
  // on the structural card, which is the one the user is looking at.
  const structural = calls.current().find((c) => c.source === 'phone');
  assert.equal(structural.caller, '', 'it must not rename the person on screen');
});

test('a toast from an app that is not a phone mirror still gets its own card', () => {
  wire();
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  calls.onNotification(teamsToast);
  assert.equal(calls.current().length, 2, 'a Teams call during a phone call is a second call');
});

test('the OS reporting the ring is over takes the card down at once', () => {
  wire();
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  calls.onPhoneState({ incoming: false, active: true, device: 'iPhone' });
  assert.equal(calls.current().length, 0, 'answered on the phone itself is still over for us');
});

test('a mirror missed-call toast also ends the structural card', () => {
  wire();
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  calls.onNotification({ ...phoneToast(9), title: 'Amore', body: 'Chiamata persa' });
  assert.equal(calls.current().length, 0, 'the toast under the card already said it was over');
});

test('the OS repeating itself does not raise a second card', () => {
  wire();
  const first = calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  const again = calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  assert.equal(again.id, first.id);
  assert.equal(calls.current().length, 1);
});

test('an immediate call back rings again rather than being deduped away', () => {
  wire();
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  calls.onPhoneState({ incoming: false, active: false, device: 'iPhone' });
  assert.ok(calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' }),
    'hanging up must clear the dedupe, or a call back inside the window is swallowed');
  assert.equal(calls.current().length, 1);
});

test('nothing rings from the phone while calls are switched off', () => {
  wire();
  settings.enabled = false;
  assert.equal(calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' }), null);
  assert.equal(calls.current().length, 0);
});

test('the phone card draws answer and decline the day a platform reports them', () => {
  // The buttons are rendered from flags the helper supplies, so this is the
  // whole change needed if one of the three ever hands the channel back.
  wire({ phoneCanAnswer: () => true, phoneCanHangUp: () => true });
  calls.onPhoneState({ incoming: true, active: false, device: 'iPhone' });
  const caps = calls.current()[0].caps;
  assert.equal(caps.answer, true);
  assert.equal(caps.decline, true);
  assert.equal(caps.via, 'phone');
});

test('a malformed phone state is refused rather than guessed at', () => {
  wire();
  assert.equal(calls.onPhoneState(null), null);
  assert.equal(calls.onPhoneState({}), null);
  assert.equal(calls.current().length, 0);
});
