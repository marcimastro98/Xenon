'use strict';
// Twitch chat, read anonymously over IRC. Shared by the streamer's Twitch tile
// (js/streaming-page.js) and the watching widget (js/twitchwatch-widget.js).
//
// WHY THIS EXISTS RATHER THAN AN EMBED: Twitch publishes a drop-in chat iframe,
// and using it costs far more than it saves. That iframe is a whole twitch.tv
// page, so it brings Twitch's cookie and advertising consent panel into the
// middle of the dashboard — a panel laid out for a full window, which in a tile
// is cut off with its buttons out of reach, cannot be dismissed from our side (a
// cross-origin frame is untouchable) and is not ours to answer on the user's
// behalf anyway. It also sets third-party cookies and looks nothing like the rest
// of the dashboard. Reading a channel's chat needs no account and no permission:
// join as an anonymous `justinfan` nick and the messages arrive. No cookies, no
// consent, no third-party page, and the lines are ours to draw.
//
// Only the PARSING lives here, deliberately. The two callers own their own socket
// because they open it under different conditions (one follows the user's own
// channel, the other whatever is being watched), but the tag/PRIVMSG parsing is
// the part that is fiddly, easy to get subtly wrong and worth testing once — see
// server/test/twitch-chat.test.mjs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TwitchChat = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const MAX_NAME = 40;
  const MAX_TEXT = 500;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const EMOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const EMOTE_CDN = 'https://static-cdn.jtvnw.net/emoticons/v2/';

  // Turn a message plus its `emotes` tag into drawable parts.
  //
  // The tag looks like `25:0-4,12-16/1902:6-10`: an emote id, then the ranges it
  // occupies in the message. TWO traps live in those numbers. They are indexes in
  // CODE POINTS, not UTF-16 units, so a single emoji earlier in the line shifts
  // every following range by one if you slice the string directly — and chat is
  // full of emoji. And the ranges arrive in the order the ids appear, not in
  // reading order, so they have to be sorted before the text between them can be
  // cut. Both produce a line that looks almost right, which is the kind of bug
  // nobody reports precisely.
  function emoteParts(text, tag) {
    const cps = Array.from(String(text == null ? '' : text));
    if (!tag) return [{ type: 'text', text: cps.join('') }];
    const marks = [];
    String(tag).split('/').forEach(chunk => {
      const i = chunk.indexOf(':');
      if (i <= 0) return;
      const id = chunk.slice(0, i);
      if (!EMOTE_ID_RE.test(id)) return;          // it ends up in a URL
      chunk.slice(i + 1).split(',').forEach(range => {
        const m = /^(\d+)-(\d+)$/.exec(range);
        if (!m) return;
        const a = Number(m[1]);
        const b = Number(m[2]);
        // Out of range is normal rather than hostile: the text is bounded above,
        // so an emote past the cut simply stays as its own name.
        if (!(a >= 0 && b >= a && b < cps.length)) return;
        marks.push({ a, b, id });
      });
    });
    if (!marks.length) return [{ type: 'text', text: cps.join('') }];
    marks.sort((x, y) => x.a - y.a);
    const out = [];
    let pos = 0;
    marks.forEach(m => {
      if (m.a < pos) return;                       // overlapping ranges: keep the first
      if (m.a > pos) out.push({ type: 'text', text: cps.slice(pos, m.a).join('') });
      out.push({
        type: 'emote',
        id: m.id,
        name: cps.slice(m.a, m.b + 1).join(''),
        url: EMOTE_CDN + m.id + '/default/dark/1.0',
      });
      pos = m.b + 1;
    });
    if (pos < cps.length) out.push({ type: 'text', text: cps.slice(pos).join('') });
    return out;
  }

  // The anonymous nick Twitch accepts for read-only access. Random so two
  // dashboards on the same network do not collide on one nick.
  function anonNick(rand) {
    const r = typeof rand === 'number' ? rand : Math.random();
    return 'justinfan' + (10000 + Math.floor(r * 89999));
  }

  // Parse one WebSocket frame, which can hold several IRC lines.
  // Returns { ping, messages: [{ name, text, color }] }.
  //   ping     — the server asked for a PONG; the caller must answer or be dropped
  //   messages — chat lines, already bounded and with the colour validated, so a
  //              caller can hand `color` straight to a style without re-checking
  function parseIrcLines(raw) {
    const out = { ping: false, messages: [] };
    String(raw == null ? '' : raw).split('\r\n').forEach(line => {
      if (!line) return;
      if (line.startsWith('PING')) { out.ping = true; return; }
      let rest = line;
      const tags = {};
      if (line[0] === '@') {
        const sp = line.indexOf(' ');
        if (sp === -1) return;
        line.slice(1, sp).split(';').forEach(kv => {
          const i = kv.indexOf('=');
          if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1);
        });
        rest = line.slice(sp + 1);
      }
      const pm = rest.indexOf(' PRIVMSG ');
      if (pm === -1) return;
      const nick = (rest.slice(0, pm).match(/:?([^!]+)!/) || [])[1] || tags['display-name'] || '?';
      const after = rest.slice(pm + 9);              // ' PRIVMSG '.length === 9
      const mi = after.indexOf(' :');
      if (mi === -1) return;
      // Bound the text FIRST, then work the emote ranges out against what is left,
      // so a range past the cut is dropped instead of pointing at nothing.
      const text = String(after.slice(mi + 2)).slice(0, MAX_TEXT);
      out.messages.push({
        name: String(tags['display-name'] || nick).slice(0, MAX_NAME),
        text,
        color: COLOR_RE.test(tags.color || '') ? tags.color : '',
        parts: emoteParts(text, tags.emotes || ''),
      });
    });
    return out;
  }

  return { parseIrcLines, emoteParts, anonNick, MAX_NAME, MAX_TEXT, EMOTE_CDN };
});
