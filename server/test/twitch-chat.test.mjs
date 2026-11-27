import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseIrcLines, anonNick, openChat, MAX_TEXT, QUIET_MS, ANSWER_MS, CHECK_MS, RETRY_MS } = require('../js/streaming/twitch-chat.js');

// This parser had shipped for versions inside js/streaming-page/streaming-page.js with no test
// at all, and it was about to be copied a second time into the watching widget.
// It is now shared, so it is worth pinning: the lines below are the real shapes
// Twitch sends, and every one of them has a way of going quietly wrong (a colon
// inside the message, a display name that differs from the nick, a frame holding
// several lines, a PING that must be answered or the socket is dropped).

test('a tagged PRIVMSG yields the display name, the text and a validated colour', () => {
  const raw = '@badge-info=;color=#1E90FF;display-name=Someone;mod=0 :someone!someone@someone.tmi.twitch.tv PRIVMSG #channel :hello there\r\n';
  const r = parseIrcLines(raw);
  assert.equal(r.ping, false);
  assert.deepEqual(r.messages, [{
    name: 'Someone', text: 'hello there', color: '#1E90FF',
    parts: [{ type: 'text', text: 'hello there' }],
  }]);
});

test('a message containing " :" keeps everything after the FIRST one', () => {
  // The naive split loses half of any message with a URL or an emoticon in it.
  const raw = '@display-name=Bob;color= :bob!bob@bob.tmi.twitch.tv PRIVMSG #c :look https://x.com :) end\r\n';
  assert.equal(parseIrcLines(raw).messages[0].text, 'look https://x.com :) end');
});

test('an untagged line falls back to the nick', () => {
  const raw = ':nick!nick@nick.tmi.twitch.tv PRIVMSG #c :plain\r\n';
  assert.deepEqual(parseIrcLines(raw).messages, [{
    name: 'nick', text: 'plain', color: '', parts: [{ type: 'text', text: 'plain' }],
  }]);
});

test('a colour that is not a six-digit hex is dropped, never passed through', () => {
  // It is written straight into an inline style by both callers, so anything
  // that is not exactly a hex colour has to become the empty string here. Note a
  // value cannot contain a semicolon — that is the tag separator, so a payload
  // like `#1E90FF;background:url(x)` is read as a colour plus a second tag we
  // ignore, and never reaches a style. What has to be refused is a near-miss in
  // the value itself, which is what the anchors in the pattern are for.
  // (A space cannot appear in a value either — it is what ends the tag block —
  // so the near-misses worth listing are the ones a value can actually hold.)
  for (const bad of ['red', '#12345', '#1E90FFF', '#GGGGGG', 'javascript:1', '#1E90FF)', '#1E90FF"']) {
    const raw = `@color=${bad};display-name=A :a!a@a PRIVMSG #c :x\r\n`;
    assert.equal(parseIrcLines(raw).messages[0].color, '', `colour "${bad}" must be refused`);
  }
});

test('one frame can hold several lines, and a PING is reported not swallowed', () => {
  const raw = [
    'PING :tmi.twitch.tv',
    '@display-name=A :a!a@a PRIVMSG #c :one',
    '@display-name=B :b!b@b PRIVMSG #c :two',
    '',
  ].join('\r\n');
  const r = parseIrcLines(raw);
  assert.equal(r.ping, true, 'an unanswered PING gets the socket dropped');
  assert.deepEqual(r.messages.map(m => m.name + ':' + m.text), ['A:one', 'B:two']);
});

test('everything that is not a chat message is ignored', () => {
  const raw = [
    ':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!',
    ':justinfan12345.tmi.twitch.tv JOIN #c',
    '@msg-id=sub :tmi.twitch.tv USERNOTICE #c :subbed',
    ':tmi.twitch.tv CLEARCHAT #c',
    '',
  ].join('\r\n');
  assert.deepEqual(parseIrcLines(raw).messages, []);
});

test('a very long message is bounded', () => {
  const raw = '@display-name=A :a!a@a PRIVMSG #c :' + 'x'.repeat(MAX_TEXT + 500) + '\r\n';
  assert.equal(parseIrcLines(raw).messages[0].text.length, MAX_TEXT);
});

test('garbage in never throws', () => {
  for (const bad of [null, undefined, '', '@', '@only-tags-no-space', 'PRIVMSG', ':a!a@a PRIVMSG #c']) {
    assert.deepEqual(parseIrcLines(bad).messages, [], JSON.stringify(bad));
  }
});

test('the anonymous nick is in the range Twitch accepts', () => {
  for (const r of [0, 0.5, 0.999999]) {
    const n = anonNick(r);
    assert.match(n, /^justinfan\d{5}$/);
    const num = Number(n.slice('justinfan'.length));
    assert.ok(num >= 10000 && num < 99999, n);
  }
});

// ── Emotes ────────────────────────────────────────────────────────────────
// The `emotes` tag indexes the message in CODE POINTS and lists its ranges in
// id order rather than reading order. Both are easy to get wrong in a way that
// still looks nearly right, so they are pinned here.

test('an emote range becomes an image part with the text around it intact', () => {
  const raw = '@display-name=A;emotes=25:6-10 :a!a@a PRIVMSG #c :hello Kappa there\r\n';
  const parts = parseIrcLines(raw).messages[0].parts;
  assert.deepEqual(parts.map(p => p.type), ['text', 'emote', 'text']);
  assert.equal(parts[0].text, 'hello ');
  assert.equal(parts[1].name, 'Kappa');
  assert.equal(parts[1].url, 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0');
  assert.equal(parts[2].text, ' there');
});

test('positions are code points, so an emoji earlier in the line does not shift them', () => {
  // "😀 Kappa" — the emoji is ONE code point and TWO UTF-16 units. Slicing the
  // string directly would take "appa" and leave a stray "K".
  const raw = '@display-name=A;emotes=25:2-6 :a!a@a PRIVMSG #c :\u{1F600} Kappa\r\n';
  const parts = parseIrcLines(raw).messages[0].parts;
  assert.equal(parts.find(p => p.type === 'emote').name, 'Kappa');
  assert.equal(parts[0].text, '\u{1F600} ');
});

test('several ids, listed out of reading order, come back in reading order', () => {
  const raw = '@display-name=A;emotes=1902:6-10/25:0-4 :a!a@a PRIVMSG #c :Kappa Keepo end\r\n';
  const parts = parseIrcLines(raw).messages[0].parts;
  assert.deepEqual(parts.map(p => (p.type === 'emote' ? p.name : p.text)), ['Kappa', ' ', 'Keepo', ' end']);
});

test('the same emote twice in one line is drawn twice', () => {
  const raw = '@display-name=A;emotes=25:0-4,6-10 :a!a@a PRIVMSG #c :Kappa Kappa\r\n';
  const parts = parseIrcLines(raw).messages[0].parts;
  assert.equal(parts.filter(p => p.type === 'emote').length, 2);
});

test('a junk id or a junk range is ignored, and the text survives whole', () => {
  // The id goes into a URL path, so anything with a dot, a slash or an escape in
  // it must be refused. (A slash is also the chunk separator, so a traversal
  // payload is already split apart before the id is even looked at.)
  for (const tag of ['..:0-4', '%2e%2e:0-4', '25:9-4', '25:0-999', '25:x-y', 'no-colon', '']) {
    const raw = `@display-name=A;emotes=${tag} :a!a@a PRIVMSG #c :Kappa here\r\n`;
    const parts = parseIrcLines(raw).messages[0].parts;
    assert.deepEqual(parts, [{ type: 'text', text: 'Kappa here' }], 'tag ' + JSON.stringify(tag));
  }
});

test('a message with no emote tag is one text part equal to the message', () => {
  const raw = ':a!a@a PRIVMSG #c :just words\r\n';
  const m = parseIrcLines(raw).messages[0];
  assert.deepEqual(m.parts, [{ type: 'text', text: 'just words' }]);
  assert.equal(m.parts.map(p => p.text).join(''), m.text);
});

test('RECONNECT from the server is reported', () => {
  assert.equal(parseIrcLines(':tmi.twitch.tv RECONNECT\r\n').reconnect, true);
  assert.equal(parseIrcLines('@display-name=A :a!a@a PRIVMSG #c :RECONNECT\r\n').reconnect, false, 'a chatter typing it is a message');
});

// A hand-driven clock and socket: `tick(ms)` moves time and fires what is due.
function rig() {
  const st = { now: 0, socks: [], timers: [], seq: 0, lines: [] };
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; st.socks.push(this); }
    send(line) { this.sent.push(line); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    hear(raw) { this.onmessage?.({ data: raw }); }
    die() { this.readyState = 3; this.onclose?.(); }
  }
  const add = (fn, ms, every) => { const id = ++st.seq; st.timers.push({ id, fn, at: st.now + ms, every }); return id; };
  const drop = (id) => { st.timers = st.timers.filter((x) => x.id !== id); };
  const timers = {
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: drop,
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: drop,
  };
  const tick = (ms) => {
    const end = st.now + ms;
    for (;;) {
      const due = st.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      st.now = due.at;
      if (due.every) due.at += due.every; else drop(due.id);
      due.fn();
    }
    st.now = end;
  };
  const chat = openChat('somechannel', (msgs) => st.lines.push(...msgs.map((m) => m.text)),
    { WebSocket: FakeSocket, timers, now: () => st.now });
  const sock = () => st.socks.at(-1);
  return { st, chat, tick, sock };
}

test('the connection joins the channel and answers PING', () => {
  const { st, chat, sock } = rig();
  sock().open();
  assert.deepEqual(sock().sent.map((l) => l.split(' ')[0]), ['CAP', 'NICK', 'JOIN']);
  assert.equal(sock().sent[2], 'JOIN #somechannel\r\n');
  sock().hear('PING :tmi.twitch.tv\r\n@display-name=A :a!a@a PRIVMSG #somechannel :hi\r\n');
  assert.equal(sock().sent.at(-1), 'PONG :tmi.twitch.tv\r\n');
  assert.deepEqual(st.lines, ['hi']);
  chat.close();
});

test('a socket that goes quiet without closing is probed, then replaced', () => {
  // The reported bug: the chat stopped after a while and only a page reload brought it back.
  const { st, chat, tick, sock } = rig();
  sock().open();
  tick(QUIET_MS + CHECK_MS);
  assert.equal(sock().sent.at(-1), 'PING :tmi.twitch.tv\r\n', 'a quiet minute sends our own PING');
  const dead = sock();
  tick(ANSWER_MS);
  assert.equal(dead.closed, true, 'no answer: the silent socket is dropped');
  tick(RETRY_MS[0]);
  assert.equal(st.socks.length, 2, 'and a new one is opened');
  sock().open();
  sock().hear('@display-name=A :a!a@a PRIVMSG #somechannel :back\r\n');
  assert.deepEqual(st.lines, ['back']);
  chat.close();
});

test('an answered probe keeps the socket', () => {
  const { st, chat, tick, sock } = rig();
  sock().open();
  tick(QUIET_MS + CHECK_MS);
  sock().hear(':tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv\r\n');
  tick(ANSWER_MS + CHECK_MS);
  assert.equal(st.socks.length, 1);
  assert.equal(sock().closed, false);
  chat.close();
});

test('RECONNECT opens a new socket at once', () => {
  const { st, chat, tick, sock } = rig();
  sock().open();
  const old = sock();
  old.hear(':tmi.twitch.tv RECONNECT\r\n');
  assert.equal(old.closed, true);
  tick(0);
  assert.equal(st.socks.length, 2);
  chat.close();
});

test('failed attempts wait longer each time, and a working one resets the wait', () => {
  const { st, chat, tick, sock } = rig();
  for (const wait of RETRY_MS.concat(RETRY_MS.at(-1))) {
    const before = st.socks.length;
    sock().die();
    tick(wait - 1);
    assert.equal(st.socks.length, before, 'not before ' + wait + ' ms');
    tick(1);
    assert.equal(st.socks.length, before + 1, 'at ' + wait + ' ms');
  }
  sock().open();
  sock().hear(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n');
  const before = st.socks.length;
  sock().die();
  tick(RETRY_MS[0]);
  assert.equal(st.socks.length, before + 1, 'back to the short wait');
  chat.close();
});

test('close() ends everything: no socket, no timer, no reconnect', () => {
  const { st, chat, tick, sock } = rig();
  sock().open();
  const s = sock();
  chat.close();
  assert.equal(s.closed, true);
  assert.equal(s.onclose, null, 'a late close event cannot schedule a reconnect');
  assert.equal(st.timers.length, 0);
  tick(QUIET_MS * 10);
  assert.equal(st.socks.length, 1);
});
