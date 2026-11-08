// The Widgets section of the Xenon menu: two levels, the map of the screens, and the
// way back. The rows are the shape server/menu-widgets.js sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const View = require('../js/xenon-menu-widget-view.js');
const XenonMenuMap = require('../js/xenon-menu-map.js');
const LayerSee = require('../js/layer-see.js');
globalThis.window = { XenonMenuWidgetView: View, XenonMenuMap, LayerSee, matchMedia: () => ({ matches: false }) };
const { create, onPage } = require('../js/xenon-menu-widgets.js');

function node(tag, cls = '', txt = '') {
  const n = {
    tag, cls, txt: txt == null ? '' : txt, kids: [], attrs: {}, dataset: {}, on: {}, disabled: false, focused: 0, frames: null,
    classList: { add() {}, remove() {}, toggle() {} },
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    append(...xs) { n.kids.push(...xs.filter((x) => x !== '')); },
    prepend(x) { n.kids.unshift(x); },
    appendChild(x) { n.kids.push(x); return x; },
    replaceChildren(...xs) { n.kids = xs; },
    setAttribute(k, v) { n.attrs[k] = v; },
    addEventListener(k, f) { n.on[k] = f; },
    focus() { n.focused += 1; },
    animate(frames) { n.frames = frames; },
  };
  return n;
}
const all = (n) => (typeof n === 'string' ? [] : [n, ...n.kids.flatMap(all)]);
const named = (root, txt) => all(root).find((n) => n.txt === txt);
const say = (x) => (x && (x.text || x.key)) || '';

const rect = { x: 0.7, y: 0.05, w: 0.25, h: 0.2 };
const corner = (id, value = 'top-right') => ({
  kind: 'choice', id: `${id}:corner`, label: { key: 'where' }, value,
  options: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((c) => ({ value: c, label: { key: c }, act: { run: { corner: c } } })),
});
const widget = (id, page, over = {}) => ({
  kind: 'widget', id, label: { text: id }, value: [{ key: 'on-desktop' }], act: { run: { remove: id } }, on: true,
  acts: { on: { run: 'on' }, off: { run: 'off' } }, page, group: 'desktop', shown: true,
  at: { surface: 'desktop', rect, opacity: 0.8, ratio: 16 / 9, lead: id, monitor: '' },
  tune: [
    { kind: 'tunehead', id: `${id}:h-where`, label: { key: 'where-head' } },
    { kind: 'place', id: `${id}:place`, label: { key: 'place' }, value: 'desktop', options: [] },
    { kind: 'choice', id: `${id}:screen`, label: { key: 'screen' }, value: 'a', options: [
      { value: 'a', label: { text: 'Dell' }, ratio: 16 / 9, act: { run: { monitor: 'a' } } },
      { value: 'b', label: { text: 'Edge' }, ratio: 32 / 9, act: { run: { monitor: 'b' } } },
    ] },
    corner(id),
    { kind: 'when', id: `${id}:when`, label: { key: 'when' } },
    { kind: 'tunehead', id: `${id}:h-look`, label: { key: 'look' } },
    { kind: 'choice', id: `${id}:opacity`, label: { key: 'opacity' }, value: '80', options: [] },
  ],
  ...over,
});
const add = { kind: 'add', id: 'add', label: { key: 'add' }, filters: [], choices: [
  { value: 'weather', label: { text: 'Weather' }, act: { run: 'place-weather' } },
  { value: 'perf', label: { text: 'Perf' }, rec: { key: 'in-game' }, act: { run: 'place-perf' } },
] };
const pages = (value = 'p1') => ({ kind: 'pages', id: 'pages', label: { key: 'pages' }, how: { key: 'how' }, value, options: [
  { value: 'p1', label: { text: 'Uno' }, act: { run: 'to-p1' } },
  { value: 'p2', label: { text: 'Due' }, act: { run: 'to-p2' } },
  { value: 'new', label: { key: 'new-page' }, act: { run: 'new' } },
] });
const pageEditRow = (page = 'p1') => ({ kind: 'pageEdit', id: 'pageEdit', page, name: 'Uno', says: [{ key: 'by-hand' }], widgets: 1, max: 32 });
const twoPages = (rows = []) => ({ id: 'widgets', title: { key: 'w' }, sub: { key: 's' }, rows: [
  add, pages(),
  { kind: 'key', id: 'pageKey', label: { key: 'page-key' } },
  pageEditRow(),
  { kind: 'when', id: 'pageWhen', label: { key: 'page-when' } },
  { kind: 'toggle', id: 'shown', label: { key: 'shown' }, on: true, acts: { on: { run: 'all-on' }, off: { run: 'all-off' } } },
  { kind: 'button', id: 'edit', label: { key: 'edit' }, act: { run: 'edit' }, closes: true },
  { kind: 'button', id: 'store', label: { key: 'store' } },
  { kind: 'button', id: 'yourWidgets', label: { key: 'mine' } },
  { kind: 'button', id: 'ownWidget', label: { key: 'own' } },
  { kind: 'guide', id: 'guide', label: { key: 'guide' } },
  widget('w1', 'p1'), widget('w2', 'p2'),
  ...rows,
] });

function rig(over = {}) {
  const log = { acts: [], redraws: 0, shows: 0, cleared: 0 };
  const main = node('main');
  main.scrollTop = 40;
  main.querySelectorAll = () => all(main).filter((n) => n.dataset.keep);
  const DRAW = Object.fromEntries(['status', 'toggle', 'checks', 'choice', 'pages', 'mode', 'button', 'key', 'pageEdit', 'place', 'guide', 'tunehead', 'when'].map((k) => [k, (r) => node('row', k, r.id)]));
  const widgets = create({
    el: node,
    button: (cls, label) => node('button', cls, label),
    say, tt: (k) => k, fill: (s, v) => `${s}:${Object.values(v).join(',')}`, factLine: (list) => list.map(say).join(' '),
    icon: (n) => node('svg', 'xm-ic', n),
    switchFor: (r) => { const s = node('switch', 'xm-switch'); s.dataset.keep = r.id; return s; },
    perform: async (_row, act, onDone) => { log.acts.push(act); if (onDone) onDone(over.res || {}); return true; },
    redraw: () => { log.redraws += 1; },
    server: 'http://x', DRAW, Place: { picture: () => node('img', 'xm-app-icon') }, Palette: null,
    pageEdit: { typing: () => !!over.typing, drawScreen: (r) => ({ name: node('field', 'xm-page-name', r.name), gone: node('div', 'xm-gone') }) },
    peek: over.peek, main, clearFind: () => { log.cleared += 1; }, show: () => { log.shows += 1; widgets.reset(); },
  });
  DRAW.widget = widgets.drawRow;
  const body = (s) => { const box = node('body'); box.append(...widgets.screen(s).body); return box; };
  // What a redraw does: the screen goes on the page, then the focus settles.
  const paint = (s) => {
    const shown = widgets.screen(s);
    main.replaceChildren(...[shown.back, shown.action, ...shown.body].filter(Boolean));
    widgets.settle();
    return shown;
  };
  return { widgets, log, main, body, paint };
}

test('the picture: on an app the top corners stay under the window buttons, the size to scale', () => {
  const at = (c, w = 320, h = 200) => ({ surface: 'anchor', corner: c, app: 'Spotify', width: w, height: h });
  assert.deepEqual(View.spot(at('top-left')), { x: 3, y: 17, w: 25, h: 25, o: 1 });
  assert.deepEqual(View.spot(at('bottom-right')), { x: 72, y: 69, w: 25, h: 25, o: 1 });
  assert.equal(View.spot(at('top-left', 40, 40)).w, 14, 'never too small to see');
  assert.equal(View.spot(at('top-left', 4000, 4000)).h, 60, 'never over the whole window');
  assert.equal(View.spot({ surface: 'anchor', corner: 'top-left', app: 'x' }).w, 14, 'a size not known yet still draws');
});

test('the glide runs only when the widget moved, in percent of itself', () => {
  const to = { x: 70, y: 5, w: 25, h: 20 };
  assert.equal(View.glideFrames(null, to), null);
  assert.equal(View.glideFrames({ ...to, o: 0.4 }, to), null, 'a new opacity does not move it');
  const [from, end] = View.glideFrames({ x: 5, y: 5, w: 25, h: 20 }, to);
  assert.match(from.transform, /^translate\(-260%, 0%\) scale\(1, 1\)$/);
  assert.equal(end.transform, 'none');
});

test('a widget stays on the real screen only while its own screen is open', () => {
  const asked = [];
  const peek = { show: (id) => asked.push(id), held: () => true };
  const { widgets, log, paint, main } = rig({ peek });
  const s = twoPages([widget('lw_a', 'p1', { now: { key: 'hidden' }, peek: { key: 'held' } })]);
  paint(s);
  assert.equal(asked.at(-1), null, 'the list holds nothing');
  all(main).find((n) => n.dataset.keep === 'lw_a:open').on.click();
  assert.equal(log.redraws, 1);
  const shown = paint(s);
  assert.equal(asked.at(-1), 'lw_a');
  assert.equal(shown.sub.text, 'held', 'the words say it is held up');
  widgets.screen({ id: 'other', rows: [] });
  assert.equal(asked.at(-1), null, 'another section lets it go');
  paint(s);
  assert.equal(asked.at(-1), 'lw_a');
  widgets.stepBack();
  paint(s);
  assert.equal(asked.at(-1), null);
});

test('where the menu may not hold it up, its screen says it is hidden', () => {
  const peek = { show: () => {}, held: () => false };
  const { paint, main } = rig({ peek });
  const s = twoPages([widget('lw_a', 'p1', { now: { key: 'hidden' }, peek: { key: 'held' } })]);
  paint(s);
  all(main).find((n) => n.dataset.keep === 'lw_a:open').on.click();
  assert.equal(paint(s).sub.text, 'hidden');
});

test('the screen keeps every choice the picture does not already carry, in server order', () => {
  const ids = View.choiceParts(widget('w1', 'p1')).map((x) => x.id);
  assert.deepEqual(ids, ['w1:place', 'w1:when', 'w1:h-look', 'w1:opacity']);
  assert.equal(View.partOf(widget('w1', 'p1'), 'corner').value, 'top-right');
  assert.equal(View.partOf(widget('w1', 'p1'), 'nope'), undefined);
});

test('only the widgets section is laid out here, and not without widget layers', () => {
  const { widgets } = rig();
  assert.equal(widgets.screen({ id: 'now', rows: [add] }), null);
  assert.equal(widgets.screen({ id: 'widgets', rows: [{ kind: 'status', id: 'noLayers' }] }), null);
});

test('the list shows one page: its widgets, how pages change and the add button', () => {
  const { widgets, body } = rig();
  const s = twoPages();
  assert.deepEqual(onPage(s.rows, 'p1').map((r) => r.id), ['w1']);
  assert.deepEqual(onPage(s.rows, '').map((r) => r.id), ['w1', 'w2'], 'with one page nothing is told apart');
  const page = body(s);
  assert.ok(named(page, 'how'), 'how pages change sits next to their names');
  assert.ok(!named(page, 'pageKey'), 'the key to change page lives on the screen of a page, it read as one here');
  assert.equal(named(page, 'Uno').attrs['aria-pressed'], 'true');
  assert.equal(named(page, 'Due').attrs['aria-pressed'], 'false');
  assert.ok(named(page, 'w1') && !named(page, 'w2'));
  assert.ok(named(widgets.screen(s).action, 'add'));
});

test('pressing another page changes the page on the screen; pressing the current one does nothing', () => {
  const { log, body } = rig();
  const page = body(twoPages());
  named(page, 'Uno').on.click();
  assert.equal(log.acts.length, 0);
  named(page, 'Due').on.click();
  assert.deepEqual(log.acts, [{ run: 'to-p2' }]);
});

test('an empty page says so and the one add button moves into the middle of it', () => {
  const { widgets, body } = rig();
  const s = { ...twoPages(), rows: [add, pages('p2'), pageEditRow('p2'), widget('w1', 'p1')] };
  assert.equal(widgets.screen(s).action, null);
  const page = body(s);
  assert.ok(named(page, 'xmenu_page_empty:Due'));
  assert.ok(named(page, 'add'));
});

test('nothing placed on the only page: the server words, the add button and the guide', () => {
  const { body } = rig();
  const none = { kind: 'status', id: 'noWidgets', label: { key: 'none' }, value: { key: 'hint' } };
  const page = body({ id: 'widgets', rows: [add, none, { kind: 'guide', id: 'guide' }, { kind: 'button', id: 'newPage' }] });
  assert.ok(named(page, 'none') && named(page, 'hint') && named(page, 'add'));
  assert.ok(named(page, 'guide') && named(page, 'newPage'));
});

test('a row: the whole row opens the widget, the switch stays its own, an off widget says so', () => {
  const { widgets, log } = rig();
  const row = widgets.drawRow(widget('w1', 'p1'));
  assert.ok(all(row).some((n) => n.tag === 'switch'));
  assert.ok(row.cls.includes('xm-wrow'));
  const off = widgets.drawRow(widget('w1', 'p1', { shown: false }));
  assert.ok(off.cls.includes('xm-row--off'));
  assert.ok(named(off, ''), 'the sub line exists');
  named(row, 'w1').on.click();
  assert.equal(log.cleared, 1, 'from the search results too');
  assert.equal(log.shows, 1);
});

test('opening a widget goes to its screen, Back and Esc return with the focus on its row', () => {
  const { widgets, main, log, paint } = rig();
  const s = twoPages();
  named(widgets.drawRow(widget('w1', 'p1')), 'w1').on.click();
  const shown = paint(s);
  assert.equal(shown.title.text, 'w1');
  assert.equal(main.scrollTop, 0, 'a new level starts at the top');
  assert.equal(shown.back.focused, 1);
  assert.equal(log.redraws, 1);
  assert.equal(widgets.stepBack(), true);
  paint(s);
  const row = all(main).find((n) => n.dataset.keep === 'w1:open');
  assert.equal(row.focused, 1);
  assert.equal(widgets.stepBack(), false, 'at the list Esc belongs to the menu');
});

const mapRow = { kind: 'map', id: 'map', label: { key: 'show-me' }, screens: [{ key: '', label: { text: 'Dell' }, width: 1600, height: 900, x: 0, y: 0 }, { key: 'b', label: { text: 'Edge' }, width: 800, height: 225, x: 0, y: 900 }] };
const withMap = (rows = []) => { const s = twoPages(rows); return { ...s, rows: [mapRow, ...s.rows] }; };

test('the widget screen: the map and the question first, every other choice under one row, and it can be taken off', async () => {
  const { widgets, log, paint, main } = rig();
  const s = withMap();
  named(widgets.drawRow(widget('w1', 'p1')), 'w1').on.click();
  paint(s);
  assert.equal(all(main).filter((n) => n.cls.startsWith('xm-corner')).length, 0, 'a free widget has no corner buttons');
  assert.equal(all(main).filter((n) => n.cls === 'xm-mapscreen').length, 2);
  assert.ok(all(main).some((n) => n.cls.includes('xm-mapw') && n.cls.includes('is-picked')));
  assert.equal(all(main).filter((n) => n.cls === 'xm-mapgrip').length, 1, 'a corner to pull, only on the widget in view');
  assert.ok(named(main, 'see_drag_hint'));
  assert.ok(!named(main, 'w1:h-where') && !named(main, 'w1:corner') && !named(main, 'w1:screen'), 'nothing said twice');
  assert.ok(named(main, 'w1:place'));
  assert.ok(!named(main, 'w1:when') && !named(main, 'w1:opacity') && !named(main, 'xmenu_remove_widget'), 'closed at first');
  const more = () => all(main).find((n) => n.dataset.keep === 'w1:more');
  assert.equal(more().attrs['aria-expanded'], 'false');
  more().on.click();
  paint(s);
  assert.equal(more().attrs['aria-expanded'], 'true');
  assert.ok(named(main, 'w1:when') && named(main, 'w1:opacity'));
  await named(main, 'xmenu_remove_widget').on.click();
  assert.deepEqual(log.acts.at(-1), { run: { remove: 'w1' } });
  assert.equal(paint(s).title.key, 'w', 'back on the list');
});

test('the list: the map on top, the widgets under the answer they gave, what shows now counted', () => {
  const { widgets, paint, main } = rig();
  const s = withMap([widget('w3', 'p1', { group: 'game', shown: false }), widget('w4', 'p1', { group: 'always' })]);
  paint(s);
  const heads = all(main).filter((n) => n.cls === 'xm-tunehead').map((n) => n.txt);
  assert.deepEqual(heads, ['see_always', 'see_game', 'see_desktop'], 'in the order of the question, only those in use');
  assert.equal(all(main).filter((n) => n.cls.includes('xm-mapw')).length, 2, 'the view "now": the one on a game is not on the map');
  assert.ok(named(main, 'see_count:2,3'));
  all(main).find((n) => n.dataset.keep === 'view:game').on.click();
  paint(s);
  assert.equal(all(main).filter((n) => n.cls.includes('xm-mapw')).length, 2, 'in a game: its own and the always one');
  assert.equal(widgets.holds(), false);
});

test('the window of an app sits under the widgets, so it never takes their drag', () => {
  const css = readFileSync(new URL('../components/XenonMenu/XenonMenuWidgets.css', import.meta.url), 'utf8');
  const layer = (rule) => Number(css.split(`${rule} {`)[1].match(/z-index: (\d+)/)[1]);
  assert.ok(layer('.xm-mapapp') < layer('.xm-mapw'));
});

test('a widget on an app shows on the map inside its window, and a tap opens it', () => {
  const { widgets, paint, main } = rig();
  const on = widget('w5', 'p1', { group: 'app', at: { surface: 'anchor', corner: 'bottom-right', app: 'Spotify', width: 320, height: 200, lead: 'w5' } });
  const s = withMap([on]);
  paint(s);
  all(main).find((n) => n.dataset.keep === 'view:app').on.click();
  paint(s);
  const win = all(main).find((n) => n.cls === 'xm-mapapp');
  assert.ok(named(win, 'Spotify'));
  assert.ok(all(win).some((n) => n.cls.includes('is-bottom-right')));
  win.on.click();
  assert.equal(paint(s).title.text, 'w5');
  assert.equal(widgets.stepBack(), true);
});

test('a corner on an app moves the widget with a glide, the one it sits in does nothing', () => {
  const { widgets, log, paint, main } = rig();
  const at = (corner) => ({ surface: 'anchor', corner, app: 'Spotify', width: 320, height: 200 });
  const on = (c) => { const s = twoPages(); return { ...s, rows: s.rows.map((r) => (r.id === 'w1' ? widget('w1', 'p1', { at: at(c) }) : r)) }; };
  named(widgets.drawRow(widget('w1', 'p1', { at: at('top-right') })), 'w1').on.click();
  paint(on('top-right'));
  const corners = all(main).filter((n) => n.cls.startsWith('xm-corner'));
  assert.equal(corners.length, 4);
  corners[1].on.click();
  assert.equal(log.acts.length, 0);
  corners[2].on.click();
  assert.deepEqual(log.acts.at(-1), { run: { corner: 'bottom-left' } });
  paint(on('bottom-left'));
  assert.ok(all(main).find((n) => n.cls.startsWith('xm-stage-widget')).frames, 'it glides to the new corner');
});

test('a widget on an app draws the window with its name and picture, and a word for the top corner', () => {
  const { widgets, paint, main } = rig();
  const at = { surface: 'anchor', corner: 'top-right', app: 'Spotify', width: 320, height: 200, icon: 'data:image/png;base64,AA' };
  const s = { ...twoPages(), rows: [add, pages(), widget('w1', 'p1', { at })] };
  named(widgets.drawRow(s.rows[2]), 'w1').on.click();
  paint(s);
  assert.ok(named(main, 'Spotify'));
  assert.ok(all(main).some((n) => n.cls === 'xm-app-icon'));
  assert.ok(named(main, 'xmenu_anchor_top_caption'));
  assert.ok(all(main).find((n) => n.cls.startsWith('xm-stage ')).cls.includes('xm-stage--anchor'));
});

test('adding: one tap places it where it starts and opens its screen, even before the rows arrive', async () => {
  const { widgets, log, paint, main } = rig({ res: { ok: true, placed: { id: 'w9' } } });
  const s = twoPages();
  all(paint(s).action).find((n) => n.on.click).on.click();
  const shown = paint(s);
  assert.equal(shown.title.text, 'xmenu_add_to:Uno');
  assert.ok(named(main, 'store') && named(main, 'yourWidgets') && named(main, 'ownWidget') && named(main, 'guide'), 'the other ways to get one are here');
  const list = all(main).find((n) => n.cls === 'xm-addlist');
  await list.kids[1].on.click();
  assert.deepEqual(log.acts.at(-1), { run: 'place-perf' }, 'one tap, as what suits it');
  assert.ok(named(list.kids[1], 'in-game'), 'and it says what it will start as');
  assert.equal(paint(s).title.key, 'w', 'the id is not in the rows yet: the list holds the place');
  const arrived = { ...s, rows: [...s.rows, widget('w9', 'p1')] };
  assert.equal(paint(arrived).title.text, 'w9');
  assert.equal(widgets.stepBack(), true);
});

test('a widget that is gone sends its screen back to the list', () => {
  const { widgets, paint } = rig();
  const s = twoPages();
  named(widgets.drawRow(widget('w1', 'p1')), 'w1').on.click();
  paint(s);
  const gone = { ...s, rows: s.rows.filter((r) => r.id !== 'w1') };
  assert.equal(paint(gone).title.key, 'w');
  assert.equal(widgets.stepBack(), false);
});

test('the page screen: name, when, delete; a page no longer in front returns to the list', () => {
  const { widgets, paint, main } = rig();
  const s = twoPages();
  paint(s);
  named(main, 'xmenu_page_edit').on.click();
  const shown = paint(s);
  assert.equal(shown.title.text, 'Uno');
  assert.equal(shown.sub.text, 'by-hand');
  assert.ok(named(main, 'pageWhen'));
  assert.ok(all(main).some((n) => n.cls === 'xm-gone'));
  const other = { ...s, rows: s.rows.map((r) => (r.kind === 'pageEdit' ? pageEditRow('p2') : r)) };
  assert.equal(paint(other).title.key, 'w');
  assert.equal(widgets.stepBack(), false);
});

test('a redraw waits only while the page name is being typed on its own screen', () => {
  const typing = rig({ typing: true });
  assert.equal(typing.widgets.holds(), false, 'on the list the field is not there');
  typing.paint(twoPages());
  named(typing.main, 'xmenu_page_edit').on.click();
  typing.paint(twoPages());
  assert.equal(typing.widgets.holds(), true);
});

test('the key a refused combination suggests is one Xenon takes', async () => {
  const { readFileSync } = await import('node:fs');
  const S = (await import('../js/deck-shortcuts.js')).default;
  const source = readFileSync(new URL('../js/xenon-menu.js', import.meta.url), 'utf8');
  const [, key] = /KEY_TO_TRY = '([^']+)'/.exec(source);
  assert.ok(S.normalizeShortcut(key));
  assert.equal(S.reservedBy(key), '');
  assert.equal(S.reservedBy('ctrl+alt+p'), 'altgr', 'a letter with Ctrl+Alt is refused, the reason for the suggestion');
});

test('on the map the next move starts from the last one, before the server has answered', async () => {
  const { widgets, log, paint, main } = rig();
  const s = withMap();
  named(widgets.drawRow(widget('w1', 'p1')), 'w1').on.click();
  paint(s);
  const picked = all(main).find((n) => n.cls.includes('is-picked'));
  const press = (ev) => picked.on.keydown({ preventDefault() {}, ...ev });
  press({ key: 'ArrowRight' });
  press({ key: 'ArrowRight' });
  press({ key: 'ArrowRight', shiftKey: true });
  await new Promise((done) => setImmediate(done));
  const rects = log.acts.slice(-3).map((a) => a.run.rect);
  assert.deepEqual(rects, ['0.71,0.05,0.25,0.2', '0.72,0.05,0.25,0.2', '0.72,0.05,0.26,0.2']);
});
