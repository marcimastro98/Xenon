// The disk analysis window (js/disk-widget.js): one list that opens row by row, Esc, nothing left
// behind when it closes, and the tile's confirm panel with the keys of every other window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/disk-widget.js');

function between(from, to) {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return SRC.slice(start, end);
}
// A table of the widget cut to its own end, whatever follows it where it lives.
const table = (name) => `${between(`  const ${name} = {`, '\n  };\n')}\n  };`;

const PARTS = [
  table('CAT_META'),
  table('CATEGORY_GUIDE'),
  between('  function el(tag, cls, text) {', '  // Paths are shown inside'),
  between('  function btn(cls, label, onClick, title) {', '  function withTransition('),
  between('  function closeAdvisorModal() {', '  // ── AI report markdown'),
  between('  function advisorRiskWords(risk) {', '  function advisorRecoveryItems('),
  between('  function advisorRecoveryItems(a) {', '  // A treemap with dozens'),
  between('  function advisorHead() {', '  async function openTreeNode('),
  between('  function renderConfirm() {', '  function renderCleaning() {'),
].join('\n');

const ANALYSIS = {
  used: 800, free: 200, usedPercent: 80, freePercent: 20, safeBytes: 300, reviewBytes: 50, duplicateBytes: 70,
  categories: [
    { id: 'temp', bytes: 100, count: 12, risk: 'safe' },
    { id: 'browserCache', bytes: 200, count: 40, risk: 'safe' },
    { id: 'installers', bytes: 0, count: 0, risk: 'review' },
    { id: 'recycleBin', bytes: 50, count: 3, risk: 'permanent' },
  ],
};

function rig({ analysis = ANALYSIS, aiReady = true, withFocus = true } = {}) {
  const { document, descendants } = makeDom();
  const frozen = new Set();
  const held = [];
  const calls = [];
  const window = { ambientFreeze: (token, on) => { if (on) frozen.add(token); else frozen.delete(token); } };
  if (withFocus) {
    window.DialogFocus = {
      hold(root, { onEsc }) {
        const entry = { root, onEsc, stillInPage: () => root.parentNode !== null };
        held.push(entry);
        return () => {
          calls.push(['let go', entry.stillInPage()]);
          held.splice(held.indexOf(entry), 1);
        };
      },
    };
  }
  const ctx = {
    window, document, Math, Set,
    tr: (key) => key,
    fmtSize: (n) => `${n} B`,
    fmtNumber: String,
    pathLeaf: (p) => String(p).split('\\').pop(),
    ltrPath: String,
    categoryName: (id) => id,
    analysis: () => analysis,
    drivePresentation: () => ({ primary: 'System', details: ['C:', 'NTFS'] }),
    advisorAiReady: () => aiReady,
    advisorFullContext: () => false,
    openSettingsCategory: (id) => calls.push(['settings', id]),
    beginReview: (id) => calls.push(['review', id]),
    runAdvisorAi: () => calls.push(['ask']),
    // What the widget knows while the page runs is one object (js/disk-widget/known.js).
    diskState: {
      overview: {
        root: 'C:\\',
        tree: [{ p: 'C:\\', s: 900 }, { p: 'C:\\Games', s: 500 }],
        topFiles: [{ n: 'movie.mkv', p: 'C:\\Video\\movie.mkv', s: 40 }],
        categories: { temp: { items: [{ i: 1, p: 'C:\\t', s: 1, kind: 'file' }] } },
      },
      status: { roots: [{ i: 0 }] },
      selRoot: 0,
      activeView: 'overview',
      advisorModal: null,
      advisorAiRequest: 0,
      confirmCat: 'temp',
      selectedIds: new Set([1]),
      cleaning: false,
    },
    advisorLetGo: null,
    riskLabel: (risk) => risk,
    selectedSummary: () => ({ bytes: 1, count: 1 }),
    categoryItems: () => [{ i: 1, p: 'C:\\t', s: 1, kind: 'file' }],
    runClean: () => calls.push(['clean']),
    renderAll: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(PARTS, ctx);
  const all = (cls, from = document.body) =>
    descendants(from).filter((n) => String(n.className).split(' ').includes(cls));
  const one = (cls, from) => all(cls, from)[0] || null;
  return { ctx, document, frozen, held, calls, all, one };
}

test('every kind of file is one row that opens, largest first, and a row with nothing more stays plain', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  const rows = r.all('diskw-modal-cat');
  assert.deepEqual(rows.map((row) => r.one('diskw-modal-cat-name', row).textContent),
    ['browserCache', 'temp', 'disk_verified_copies', 'recycleBin']);
  assert.deepEqual(rows.map((row) => r.one('diskw-modal-cat-size', row).textContent), ['200 B', '100 B', '70 B', '50 B']);
  assert.deepEqual(rows.map((row) => row.tag), ['details', 'details', 'div', 'details']);
  assert.ok(rows.filter((row) => row.tag === 'details').every((row) => row.getAttribute('name') === 'diskw-cat'));
  assert.equal(r.one('diskw-modal-caret', rows[2]), null, 'no caret on a row that does not open');
});

test('a category with nothing in it is not listed', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  assert.equal(r.all('diskw-risk-review').length, 1, 'only the copies');
});

test('an empty drive says so, and promises no rows to open', () => {
  const r = rig({ analysis: { ...ANALYSIS, duplicateBytes: 0, categories: [] } });
  r.ctx.openAdvisorModal();
  assert.equal(r.all('diskw-modal-cat').length, 0);
  assert.equal(r.one('diskw-modal-empty').textContent, 'disk_no_cleanup_candidates');
  assert.ok(!r.all('diskw-modal-section-intro').some((n) => n.textContent === 'disk_recovery_map_hint'));
});

test('Esc closes it and leaves nothing held, frozen or locked', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  assert.equal(r.held[0].root, r.one('diskw-advisor-dialog'));
  assert.ok(r.frozen.has('disk-advisor'), 'a full-screen blur must stop what paints under it');
  assert.ok(r.document.body.classList.contains('diskw-advisor-open'));
  r.held[0].onEsc();
  assert.equal(r.one('diskw-advisor-modal'), null);
  assert.equal(r.held.length, 0);
  assert.equal(r.frozen.size, 0);
  assert.equal(r.document.body.classList.contains('diskw-advisor-open'), false);
});

test('the window lets go before it leaves the page, or Tab and Esc stay trapped', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  r.ctx.closeAdvisorModal();
  assert.deepEqual(r.calls[0], ['let go', true]);
});

test('opening it again does not pile up', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  r.ctx.openAdvisorModal();
  assert.equal(r.all('diskw-advisor-modal').length, 1);
  assert.equal(r.held.length, 1);
});

test('a tap on the dark around it closes it, a tap inside does not', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  const overlay = r.one('diskw-advisor-modal');
  const tap = (target) => (overlay._handlers.click || []).forEach((fn) => fn({ target }));
  tap(r.one('diskw-advisor-dialog'));
  assert.ok(r.one('diskw-advisor-modal'));
  tap(overlay);
  assert.equal(r.one('diskw-advisor-modal'), null);
});

test('Review closes the window and goes to the tile', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  const row = r.all('diskw-modal-cat')[3];
  r.one('diskw-modal-review', row).click();
  assert.equal(r.one('diskw-advisor-modal'), null);
  assert.equal(r.ctx.diskState.activeView, 'clean');
  assert.deepEqual(r.calls.at(-1), ['review', 'recycleBin']);
});

test('the key at the end asks Bit, or sets Bit up when there is nobody to ask', () => {
  const ready = rig();
  ready.ctx.openAdvisorModal();
  assert.equal(ready.one('diskw-modal-ask').textContent, 'disk_ai_deepen');
  ready.one('diskw-modal-ask').click();
  assert.deepEqual(ready.calls.at(-1), ['ask']);
  assert.ok(ready.one('diskw-advisor-modal'), 'the answer lands in the window');

  const none = rig({ aiReady: false });
  none.ctx.openAdvisorModal();
  assert.equal(none.one('diskw-modal-ask').textContent, 'disk_ai_configure');
  none.one('diskw-modal-ask').click();
  assert.equal(none.one('diskw-advisor-modal'), null);
  assert.deepEqual(none.calls.at(-1), ['settings', 'ai']);
});

test('the head names the drive in plain words, with no dotted string', () => {
  const r = rig();
  r.ctx.openAdvisorModal();
  const line = r.one('diskw-modal-heading').children[1];
  assert.equal(line.textContent, 'System, C:, NTFS');
});

test('it still opens on a page without the keyboard helper', () => {
  const r = rig({ withFocus: false });
  r.ctx.openAdvisorModal();
  assert.ok(r.one('diskw-advisor-modal'));
  r.ctx.closeAdvisorModal();
  assert.equal(r.one('diskw-advisor-modal'), null);
});

test('the tile asks with Cancel on the left, the action on the right, and one way out', () => {
  const r = rig();
  const box = r.ctx.renderConfirm();
  const keys = r.one('diskw-confirm-actions', box).children;
  assert.equal(keys[0].textContent, 'disk_cancel');
  assert.ok(keys[1].className.includes('diskw-btn-danger'));
  assert.equal(r.one('diskw-icon-btn', box), null);
  assert.ok(!between('  function renderConfirm() {', '  function renderCleaning() {').includes(' · '));
});

test('no sparkle or check mark as a picture in the window', () => {
  const code = between('  function advisorHead() {', '  async function openTreeNode(') + between('  async function runAdvisorAi(', '  function advisorHead() {');
  assert.ok(!/[✦✓▰▤]/.test(code));
});

test('a row that opens is a stop on the keyboard path', () => {
  assert.match(read('../js/dialog-focus.js'), /const TABBABLE = '[^']*\bsummary\b/);
});

test('the widget window carries what the window needs, in order', () => {
  const layer = read('../js/layer-tiles.js');
  const entry = layer.slice(layer.indexOf("disk: tile('disk'"), layer.indexOf("devclean: tile('devclean'"));
  assert.ok(entry.includes("'styles/liquid-sheets.css'"));
  assert.ok(entry.indexOf("'js/dialog-focus.js'") > 0 && entry.indexOf("'js/dialog-focus.js'") < entry.indexOf("'js/disk-widget.js'"));
});

test('it sits with the other windows, under notifications', () => {
  const css = read('../components/DiskWidget/DiskWidget.css');
  const overlay = css.slice(css.indexOf('.diskw-advisor-modal {'), css.indexOf('.diskw-advisor-dialog {'));
  assert.match(overlay, /z-index: 2000;/);
});
