import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'call-modal.js'), 'utf8');

// Why this test exists, stated plainly because it is the only client-side render
// test in the repo and the reason is specific.
//
// The call card shipped with a ReferenceError in card(): a `const caps =
// call.caps || {}` line was deleted during a refactor that restructured the
// buttons into two rows. Nothing caught it. `node --check` passes — it is
// syntactically fine. The unit tests cover the SERVER modules. The visual
// preview used hand-written HTML rather than this function, so it rendered a
// card that looked right while the real one threw.
//
// What the user saw was the worst possible shape of that bug: paint() creates
// the overlay and takes the ambient-freeze token BEFORE it builds the card, so
// the throw left a full-screen blurred backdrop over a frozen dashboard with
// nothing in it, and no way to dismiss it.
//
// So this runs the real module against a minimal DOM and asserts the things
// that failure would break: every caps shape renders, the overlay opens and
// closes, and the freeze is released exactly as often as it is taken.

// ── A DOM small enough to read, big enough to run this module ───────────────
function makeDom() {
  const freezeLog = [];
  const mkEl = (tag) => {
    const node = {
      tag,
      className: '',
      _text: '',
      innerHTML: '',
      children: [],
      parentElement: null,
      style: {},
      dataset: {},
      hidden: false,
      disabled: false,
      type: '',
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; },
      get childElementCount() { return this.children.length; },
      appendChild(c) { c.parentElement = node; node.children.push(c); return c; },
      append(...cs) { for (const c of cs) node.appendChild(c); },
      replaceChildren(...cs) { node.children = []; for (const c of cs) node.appendChild(c); },
      insertAdjacentElement(_pos, c) { return node.parentElement ? node.parentElement.appendChild(c) : c; },
      remove() {
        const p = node.parentElement;
        if (p) p.children = p.children.filter(x => x !== node);
        node.parentElement = null;
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      classList: {
        add(c) { if (!node.className.split(' ').includes(c)) node.className = (node.className + ' ' + c).trim(); },
        remove(c) { node.className = node.className.split(' ').filter(x => x && x !== c).join(' '); },
        contains(c) { return node.className.split(' ').includes(c); },
        toggle(c, on) { if (on) this.add(c); else this.remove(c); },
      },
      // Depth-first search over the tree by a single class selector — all this
      // module ever asks for.
      querySelector(sel) {
        const want = sel.replace(/^\./, '');
        const walk = (n) => {
          for (const c of n.children) {
            if (c.className.split(' ').includes(want)) return c;
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(node);
      },
    };
    return node;
  };

  const body = mkEl('body');
  const document = {
    body,
    readyState: 'complete',
    createElement: mkEl,
    createDocumentFragment: () => mkEl('#fragment'),
    addEventListener() {},
    querySelector(sel) { return body.querySelector(sel); },
    hidden: false,
  };
  const window = {
    ambientFreeze(token, on) { freezeLog.push({ token, on: !!on }); },
    XenonSound: { ring() {} },
    t: (k) => k,
    addEventListener() {},
  };
  window.window = window;
  return { window, document, body, freezeLog };
}

function loadModule() {
  const dom = makeDom();
  const ctx = {
    window: dom.window,
    document: dom.document,
    // The two shared helpers the module aliases from utils.js.
    makeEl(tag, cls, text) {
      const n = dom.document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    apiJson: async () => ({ ok: true }),
    hubSettings: { calls: { enabled: true, sound: false } },
    t: (k) => k,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { void fn; return 0; },
    clearTimeout: () => {},
    Date,
    JSON,
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'call-modal.js' });
  assert.ok(dom.window.CallModal, 'the module must publish window.CallModal');
  return { ...dom, CallModal: dom.window.CallModal };
}

const CALL = (o = {}) => ({
  id: o.id || 'c1',
  at: Date.now(),
  endsAt: Date.now() + 45000,
  appId: o.appId || 'discord',
  appName: o.appName || 'Discord',
  // `in`, not `||`: an empty caller is a case worth testing (a number with no
  // contact name), and `||` would quietly replace it with the default.
  caller: 'caller' in o ? o.caller : 'Nani00',
  detail: o.detail || 'Nani00 ha avviato una chiamata.',
  video: !!o.video,
  icon: o.icon || '',
  source: o.source || 'discord',
  silenced: !!o.silenced,
  caps: 'caps' in o ? o.caps : { answer: true, decline: false, open: true, silence: true, via: 'rpc' },
});

// ── The tests ──────────────────────────────────────────────────────────────

test('a ringing call renders a card, and the card is not empty', () => {
  const dom = loadModule();
  dom.CallModal.onCalls({ calls: [CALL()] });
  const overlay = dom.body.querySelector('.call-overlay');
  assert.ok(overlay, 'the overlay must be in the document');
  const card = dom.body.querySelector('.call-card');
  assert.ok(card, 'the overlay must contain a card');
  assert.ok(card.childElementCount >= 5,
    'an overlay with an empty card is the exact bug this test exists for');
});

test('every capability shape renders without throwing', () => {
  const shapes = {
    'discord, answerable': { caps: { answer: true, decline: false, open: true, silence: true, via: 'rpc' } },
    'teams, answer + decline': { appId: 'teams', source: 'notification', caps: { answer: true, decline: true, open: true, silence: true, via: 'hotkey' } },
    'nothing answerable': { appId: 'phonelink', source: 'notification', caps: { answer: false, decline: false, open: true, silence: true, via: '' } },
    'not even openable': { caps: { answer: false, decline: false, open: false, silence: true, via: '' } },
    'video ring': { video: true },
    'silenced': { silenced: true },
    // A card whose caps the server never sent. Reading a property off it is what
    // threw in production, so the missing-object case is pinned too.
    'no caps at all': { caps: undefined },
    'no caller name': { caller: '' },
  };
  for (const [name, o] of Object.entries(shapes)) {
    const dom = loadModule();
    assert.doesNotThrow(() => dom.CallModal.onCalls({ calls: [CALL(o)] }), name);
    assert.ok(dom.body.querySelector('.call-card'), name + ': no card rendered');
  }
});

test('an empty list closes the overlay — this is how a ring ends', () => {
  const dom = loadModule();
  dom.CallModal.onCalls({ calls: [CALL()] });
  assert.ok(dom.body.querySelector('.call-overlay'));
  dom.CallModal.onCalls({ calls: [] });
  assert.equal(dom.body.querySelector('.call-overlay'), null,
    'the server broadcasts an empty list when the ring ends; the card must go');
});

test('the ambient freeze is released exactly as often as it is taken', () => {
  // The freeze blurs and stops the whole dashboard behind the card. Leaking the
  // token leaves a frozen, dimmed dashboard with no visible cause and no way to
  // recover short of a reload.
  const dom = loadModule();
  dom.CallModal.onCalls({ calls: [CALL()] });
  dom.CallModal.onCalls({ calls: [CALL({ id: 'c2', caller: 'Anna' })] });   // repaint, same overlay
  dom.CallModal.onCalls({ calls: [] });
  const taken = dom.freezeLog.filter(e => e.on).map(e => e.token);
  const freed = dom.freezeLog.filter(e => !e.on).map(e => e.token);
  assert.deepEqual(taken, freed, 'every token taken must be given back, and no other');
});

test('a second card does not take a second freeze token', () => {
  const dom = loadModule();
  dom.CallModal.onCalls({ calls: [CALL()] });
  dom.CallModal.onCalls({ calls: [CALL({ id: 'c2' })] });
  assert.equal(dom.freezeLog.filter(e => e.on).length, 1,
    'the overlay is reused, so it must not acquire again');
});

test('a malformed push never throws and never leaves a half-built overlay', () => {
  for (const bad of [null, undefined, {}, { calls: null }, { calls: [null] }, { calls: [{}] }]) {
    const dom = loadModule();
    assert.doesNotThrow(() => dom.CallModal.onCalls(bad), JSON.stringify(bad));
  }
});

test('the avatar shows letters, not whatever the contact name contains', () => {
  // Real contact names carry emoji ("Amore 🐔"), and taking the emoji as the
  // second initial put a picture in the circle instead of a letter.
  const cases = [
    ['Amore 🐔', 'A'],
    ['Marco Rossi', 'MR'],
    ['🐔', ''],
    ['', ''],
    ['Анна Иванова', 'АИ'],   // non-Latin scripts must still work
    ['田中 太郎', '田太'],
  ];
  for (const [caller, want] of cases) {
    const dom = loadModule();
    dom.CallModal.onCalls({ calls: [CALL({ caller })] });
    const avatar = dom.body.querySelector('.call-avatar');
    assert.equal(avatar.textContent, want, JSON.stringify(caller));
  }
});

test('an app icon is rendered as an image only when its scheme is allowed', () => {
  const allowed = ['data:image/png;base64,AAAA', 'https://cdn.example/a.png'];
  const refused = ['javascript:alert(1)', 'http://cdn.example/a.png', 'data:text/html,<b>x', 'not a url'];
  for (const icon of allowed) {
    const dom = loadModule();
    dom.CallModal.onCalls({ calls: [CALL({ icon })] });
    const ico = dom.body.querySelector('.call-app-ico');
    assert.equal(ico.children.length, 1, icon + ' should render an <img>');
    assert.equal(ico.children[0].tag, 'img', icon);
  }
  for (const icon of refused) {
    const dom = loadModule();
    dom.CallModal.onCalls({ calls: [CALL({ icon })] });
    const ico = dom.body.querySelector('.call-app-ico');
    assert.equal(ico.children.length, 0, icon + ' must not become an <img> src');
    assert.ok(ico.innerHTML.includes('svg'), icon + ' should fall back to the glyph');
  }
});
