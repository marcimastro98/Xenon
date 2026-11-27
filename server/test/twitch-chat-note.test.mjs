// The watching widget's chat said "Waiting for the first message" above a chat
// that was already talking.
//
// The note is written by paintChat(), which runs on a state change or the 60s
// poll. Lines arrive through pushChat() straight from the socket and were added
// to the log without touching the note, so the first messages scrolled in under
// a line that said none had come. The first line now ends the wait itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';

const WIDGET = readFileSync(new URL('../js/streaming/twitchwatch-widget.js', import.meta.url), 'utf8');

// The widget is a browser IIFE, so pushChat is lifted out and run against stubs,
// the same trick twitch-live-refresh.test.mjs uses for loadTab.
function harness() {
  const at = WIDGET.indexOf('  function pushChat(entry) {');
  assert.notEqual(at, -1, 'js/streaming/twitchwatch-widget.js must still declare pushChat');
  const end = WIDGET.indexOf('\n  }', at) + 4;
  const src = WIDGET.slice(at, end);

  const note = { style: { display: '' } };
  const log = { lines: [] };
  const queries = [];
  const frames = [];
  const ctx = {
    CHAT_MAX: 120,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    publishChatSoon: () => {},
    document: {
      querySelectorAll: (sel) => {
        queries.push(sel);
        if (sel === '.tww-chat-log') return [log];
        if (sel === '.tww-chat-note') return [note];
        return [];
      },
    },
  };
  // eslint-disable-next-line no-new-func
  const pushChat = new Function('ctx', `
    const { CHAT_MAX, requestAnimationFrame, publishChatSoon, document } = ctx;
    let chatSeq = 0;
    let chatFrame = 0;
    let chatLines = [];
    function drawChat() { chatFrame = 0; ctx.log.lines = chatLines.slice(); }
    ${src}
    return pushChat;
  `)(Object.assign(ctx, { log }));
  // Runs the frames the page would have drawn by now.
  const paint = () => { frames.splice(0).forEach((fn) => { fn(); }); };
  return { pushChat, note, log, queries, frames, paint };
}

test('the first chat line hides the waiting note', () => {
  const h = harness();
  h.pushChat({ name: 'a', text: 'hello' });
  h.paint();
  assert.equal(h.log.lines.length, 1, 'the line still reaches the log');
  assert.equal(h.note.style.display, 'none', '"Waiting for the first message" must go with the first message');
});

test('later lines leave the note alone, one query per chat at most', () => {
  // A busy chat is many lines a second: the note is settled once, not per line.
  const h = harness();
  h.pushChat({ name: 'a', text: 'one' });
  h.pushChat({ name: 'b', text: 'two' });
  h.pushChat({ name: 'c', text: 'three' });
  assert.equal(h.queries.filter((q) => q === '.tww-chat-note').length, 1);
  h.paint();
  assert.equal(h.log.lines.length, 3);
});

test('a burst of lines is drawn in one frame, not one layout per line', () => {
  // A busy channel fell behind: every line measured the log again before the next.
  const h = harness();
  for (let i = 0; i < 50; i++) h.pushChat({ name: 'n' + i, text: 'line ' + i });
  assert.equal(h.frames.length, 1, 'one frame asked for the whole burst');
  h.paint();
  assert.equal(h.log.lines.length, 50);
  h.pushChat({ name: 'z', text: 'after' });
  assert.equal(h.frames.length, 1, 'the next line asks for the next frame');
});
