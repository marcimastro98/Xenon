// Bit at the foot of every chat pane (js/ai/bit-floor.js): the live Bit leads
// the composer, a bubble above it says the hello, the start of a turn and a
// poke, with the turn's status inside (its colour comes from BitApp, bit-app.js paintTint);
// the corner Bit steps aside only where a chat lies under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function pane(dom, { primary = true, preview = true } = {}) {
  const el = (tag, cls, attrs = {}) => {
    const n = dom.mkEl(tag);
    n.className = cls;
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  };
  const p = el('div', 'media-pane', { 'data-chatf': 'pane' });
  const log = el('div', 'ai-chat');
  const status = el('div', 'ai-status', primary ? {} : { 'data-chatf': 'mirror-status' });
  if (primary) status.id = 'ai-status';
  const row = el('div', 'ai-input-row');
  row.append(el('input', 'ai-text-input'));
  p.append(log, status);
  if (preview) p.append(el('div', 'ai-attach-preview'));
  p.append(row);
  dom.document.body.appendChild(p);
  return { p, log, status, row };
}

function rig() {
  const dom = makeDom();
  const timers = [];
  const pokes = [];
  const seen = [];
  const sizes = [];
  const ctx = {
    document: dom.document, console, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    addEventListener() {},
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; seen.push(this); }
      observe() {}
    },
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; this.hosts = []; sizes.push(this); }
      observe(h) { this.hosts.push(h); }
    },
    BitApp: {
      say: (m) => `said:${m}`,
      playerFor: () => ({ poke: () => pokes.push(1) }),
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/ai/bit-floor.js'), ctx);
  const line = (p) => p.querySelector('.bit-say-line').textContent;
  const click = (target) => dom.document._handlers.click[0]({ target });
  return { dom, F: ctx.BitFloor, timers, pokes, seen, sizes, line, click };
}

test('every pane gets Bit at the head of its composer and the bubble over it, once', () => {
  const r = rig();
  const a = pane(r.dom);
  const b = pane(r.dom, { primary: false, preview: false });
  r.F.ensure();
  r.F.ensure();
  for (const { p, row, status } of [a, b]) {
    const bit = row.children[0];
    assert.equal(bit.className, 'bit-floor-bit', 'Bit leads the composer');
    assert.equal(bit.getAttribute('data-chatf'), 'bit', 'ai-bit-chat.js mounts and moves it like any chat Bit');
    assert.equal(bit.getAttribute('aria-hidden'), 'true');
    assert.equal(p.querySelectorAll('.bit-floor-bit').length, 1);
    assert.equal(p.querySelectorAll('.bit-say').length, 1);
    assert.equal(status.parentNode.className, 'bit-say-bubble', 'the status talks from the bubble');
  }
  const at = (p, sel) => p.children.indexOf(p.querySelector(sel));
  assert.equal(at(a.p, '.bit-say') + 1, at(a.p, '.ai-attach-preview'), 'over the attachments');
  assert.equal(at(b.p, '.bit-say') + 1, b.p.children.indexOf(b.row), 'straight over the composer');
});

test('Bit says the hello, a line as a turn starts, and a poke over both, then goes quiet', () => {
  const r = rig();
  const { p } = pane(r.dom);
  r.F.ensure();
  r.F.hold('Ciao!');
  assert.equal(r.line(p), 'Ciao!');
  r.F.status('thinking');
  assert.equal(r.line(p), 'said:thinking');
  r.F.status('working');
  assert.equal(r.line(p), 'said:working');
  const bit = p.querySelector('.bit-floor-bit');
  r.click(bit);
  r.click(bit);
  assert.equal(r.pokes.length, 1, 'two taps in a row are one poke');
  assert.equal(r.line(p), 'said:poke');
  r.timers.at(-1).fn();
  assert.equal(r.line(p), 'said:working', 'back to the line underneath');
  r.F.status('');
  assert.equal(r.line(p), 'Ciao!');
  r.F.hold('');
  assert.equal(r.line(p), '', 'an empty bubble hides (AIPanelConversation.css)');
  r.click(p);
  assert.equal(r.pokes.length, 1, 'a tap elsewhere in the chat is not a poke');
});

test('the corner Bit steps aside only where a chat on screen lies under it', () => {
  const r = rig();
  const { p } = pane(r.dom);
  const corner = r.dom.mkEl('div');
  corner.className = 'bitc';
  r.dom.document.body.appendChild(corner);
  corner._rect = { width: 64, height: 60 };
  r.F.ensure();
  const host = p.querySelector('.bit-floor-bit');
  const io = r.seen[0];
  const under = () => r.dom.document.body.classList.contains('bit-chat-under-corner');
  p.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 600, width: 400, height: 600 });
  io.cb([{ isIntersecting: true, target: host }]);
  assert.ok(under());
  p.getBoundingClientRect = () => ({ left: 500, right: 900, top: 0, bottom: 600, width: 400, height: 600 });
  r.F.ensure();
  assert.ok(!under(), 'a chat elsewhere leaves the corner Bit (and its egg) in place');
  p.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 600, width: 400, height: 600 });
  io.cb([{ isIntersecting: false, target: host }]);
  assert.ok(!under(), 'a chat scrolled away gives the corner back');
  const companion = read('../components/BitCompanion/BitCompanion.css');
  assert.match(companion, /body\.bit-chat-under-corner \.bitc \{ visibility: hidden; \}/, 'hidden but measured the same');
});

test('a short pane keeps the bubble to the status, and the composer never leaves', () => {
  const r = rig();
  const { p } = pane(r.dom);
  p.clientHeight = 180; // a phone's chat tile
  r.F.ensure();
  assert.ok(p.classList.contains('bit-say-tight'));
  assert.deepEqual(r.sizes[0].hosts, [p], 'watched on the pane, never the log');
  p.clientHeight = 520;
  r.sizes[0].cb([{ target: p }]);
  assert.ok(!p.classList.contains('bit-say-tight'), 'a taller tile gets the line back');
  r.F.ensure();
  assert.equal(r.sizes[0].hosts.length, 1, 'watched once');
  const css = read('../components/AIPanel/AIPanelConversation.css');
  assert.match(css, /\n\.bit-say-tight \.bit-say-line \{ display: none; \}/, 'a short pane keeps only the status');
  // The log is flex 1 1 auto (MediaPanel.css): a bubble allowed to shrink beside it lost its top line.
  assert.match(css, /\n\.bit-say \{\n\s*flex: none;\n\s*display: flex; align-items: flex-end;/, 'the bubble is never squeezed, the log scrolls');
  assert.doesNotMatch(css, /\n\.bit-say \{[^}]*overflow: hidden/, 'nothing of it is cut');
});

test("the page loads Bit's floor before the chat that mounts it, copies drop it, the head keeps the name", () => {
  const html = read('../index.html');
  const floorAt = html.indexOf('<script src="js/ai/bit-floor.js">');
  assert.ok(floorAt > 0 && floorAt < html.indexOf('<script src="js/ai/ai-bit-chat.js">'));
  assert.doesNotMatch(html, /bit-chat-face/, 'the live Bit left the head for the composer');
  assert.match(html, /<strong class="bit-chat-name">Bit<\/strong>/);
  assert.match(read('../js/dashboard-layout/clones.js'), /'\.ai-chat, \.ai-status, \.bit-say, /, 'a copied tile builds its own bubble');
  const sync = read('../js/media/source-and-tabs.js');
  assert.ok(sync.indexOf('syncChatCopyPane(pane)') < sync.lastIndexOf('BitChat.mountHeads()'), 'copies have a composer before their Bit is placed');
  const chat = read('../js/ai/ai-bit-chat.js');
  assert.match(chat, /function mountHeads\(\) \{\n\s*if \(window\.BitFloor\) BitFloor\.ensure\(\);/);
  assert.match(chat, /if \(window\.BitFloor\) BitFloor\.status\(statusNow\);/);
  assert.match(read('../js/ai/ai.js'), /if \(window\.BitFloor\) BitFloor\.hold\(''\);/, 'the hello goes with the welcome');
});

test('Bit listens while there is a draft, and the turn wins over the typing', () => {
  assert.match(read('../js/ai/ai-bit-chat.js'), /return STATUS_MOOD\[statusNow\] \|\| \(typingNow \? 'listen' : 'idle'\);/);
  assert.match(read('../js/ai/bit-composer.js'), /root\.BitChat\.typing\(!!document\.querySelector\(ROW \+ '\.has-draft'\)\)/);
});

test("replies: Bit's bubble with its pose beside it, the person's plain on the right, suggestions on their side", () => {
  const conv = read('../components/AIPanel/AIPanelConversation.css');
  assert.match(read('../js/ai/ai-bit-chat.js'), /const AVATAR_PX = 44;/);
  assert.match(conv, /\.ai-msg-bit \{[^}]*width: 44px; margin: -12px -12px 0;/, 'the stage drawn at 44px, Bit itself in a 20px column');
  assert.match(conv, /\.ai-msg-assistant \.ai-msg-bubble \{[^}]*background: var\(--bit-bubble\)/);
  assert.match(conv, /--bit-bubble: linear-gradient\(var\(--bit-fill\) 0 0\) var\(--control-bg/, "on the person's bubble's ground, so a light theme shows it");
  assert.match(conv, /\.ai-msg-user \.ai-msg-bubble \{[^}]*background: var\(--control-bg/);
  assert.match(conv, /\.bit-say:not\(:has\(\.bit-say-line:not\(:empty\), \.ai-status:not\(:empty\)\)\),\n\.bit-say-tight \.bit-say:not\(:has\(\.ai-status:not\(:empty\)\)\) \{ display: none; \}/);
  assert.match(conv, /@container bitchat \(max-width: 300px\) \{ \.bit-floor-bit \{ display: none; \} \}/, 'a narrow pane keeps its composer');
  const replies = read('../components/AIPanel/AIPanelReplies.css');
  assert.match(replies, /\.ai-choices:not\(\.ai-ask\) \{[^}]*align-self: flex-end/);
  assert.doesNotMatch(replies, /\.ai-choice[^{]*\{[^}]*border: 1px/, 'no bordered row under a reply');
  for (const css of [conv, replies, read('../components/MediaPanel/MediaPanel.css')]) {
    assert.doesNotMatch(css, /cubic-bezier\([^)]*,\s*1\.[1-9]/, 'no spring that overshoots');
  }
  assert.match(conv, /prefers-reduced-motion: reduce\) \{\n\s*\.ai-msg, \.bit-say-bubble \{ animation: none; \}/);
});

test("voice: the person's words above Bit, Bit's in its bubble with the tail toward it, the ambient card stays plain", () => {
  const voice = read('../components/AIPanel/AIPanelVoice.css');
  const room = 'body.ai-voice-mode:not(.ai-voice-ambient)';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(voice, new RegExp(`${esc(room)} \\.ai-voice-words \\{ display: contents; \\}`));
  assert.match(voice, new RegExp(`${esc(room)} \\.ai-voice-user \\{\\n\\s*order: -1;[^}]*background: var\\(--voice-you-bubble\\)`), 'said first, read first');
  assert.match(voice, new RegExp(`${esc(room)} \\.ai-voice-user:empty \\{ visibility: hidden; \\}`), 'its place stays, Bit does not jump');
  assert.match(voice, new RegExp(`${esc(room)} \\.ai-voice-reply \\{[^}]*background: var\\(--voice-bit-bubble\\)`));
  assert.match(voice, /--voice-bit-bubble: linear-gradient\(color-mix\(in oklab, var\(--bit-tint\) 20%, transparent\) 0 0\) #[0-9a-f]{6};/, "the person's Bit over a solid ground: the room is dark on every theme");
  // The tail is the words' own ::before, so the reply's scroll box never clips it.
  const tails = voice.match(/\.ai-voice-words:has\(\.ai-voice-reply:not\(:empty\)\)::before \{[^}]*\}/g) || [];
  assert.equal(tails.length, 2, 'one under Bit, one beside it on a wide screen');
  assert.match(tails[0], /margin-bottom: calc\(-1 \* var\(--voice-gap\) - 1px\);[^}]*clip-path: var\(--px-tail-up\)/);
  assert.match(tails[1], /grid-area: 2 \/ 1;[^}]*clip-path: var\(--px-tail\)/);
  assert.ok(voice.indexOf(tails[0]) < voice.indexOf('@media (min-aspect-ratio: 2/1)'), 'the wide layout comes later, so it wins');
  const bubbled = [...voice.matchAll(/([^{}]*\.ai-voice-(?:user|reply)[^{]*)\{[^}]*background/g)].map((m) => m[1].trim());
  assert.ok(bubbled.length >= 2 && bubbled.every((sel) => sel.startsWith(room)), `bubbles stay out of the ambient card: ${bubbled}`);
  assert.doesNotMatch(read('../components/AIPanel/AIPanelAmbientVoice.css'), /ai-voice-aura|--voice-bit-bubble/);
  // No breathing halo behind Bit (a glow loop): Bit, its bars and its bubble are the presence.
  assert.doesNotMatch(voice, /ai-voice-aura|vx-breathe/);
  assert.doesNotMatch(read('../index.html'), /ai-voice-aura/);
  assert.match(voice, /prefers-reduced-motion: reduce\) \{[^}]*\}\n\s*body\.ai-voice-mode \.ai-voice-user, body\.ai-voice-mode \.ai-voice-reply \{ animation: none; \}/);
});
