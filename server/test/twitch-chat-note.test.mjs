// The watching widget's chat said "Waiting for the first message" above a chat
// that was already talking.
//
// The note is written by paintChat(), which runs on a state change or the 60s
// poll. Lines arrive through pushChat() straight from the socket and were added
// to the log without touching the note, so the first messages scrolled in under
// a line that said none had come. The first line now ends the wait itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../js/twitchwatch-widget.js', import.meta.url), 'utf8');

// The widget is a browser IIFE, so pushChat is lifted out and run against stubs,
// the same trick twitch-live-refresh.test.mjs uses for loadTab.
function harness() {
  const at = WIDGET.indexOf('  function pushChat(entry) {');
  assert.notEqual(at, -1, 'js/twitchwatch-widget.js must still declare pushChat');
  const end = WIDGET.indexOf('\n  }', at) + 4;
  const src = WIDGET.slice(at, end);

  const note = { style: { display: '' } };
  const log = { lines: [] };
  const queries = [];
  const ctx = {
    CHAT_MAX: 120,
    appendChatLine: (l, entry) => l.lines.push(entry),
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
    const { CHAT_MAX, appendChatLine, publishChatSoon, document } = ctx;
    let chatSeq = 0;
    let chatLines = [];
    ${src}
    return pushChat;
  `)(ctx);
  return { pushChat, note, log, queries };
}

test('the first chat line hides the waiting note', () => {
  const h = harness();
  h.pushChat({ name: 'a', text: 'hello' });
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
  assert.equal(h.log.lines.length, 3);
});
