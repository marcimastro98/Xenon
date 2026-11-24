// The Fans section as the menu draws it (js/menu/xenon-menu-airflow.js), on the small DOM:
// the head and the first steps, four tabs that change in place, fan cards that open, the
// speeds read again only while the Fans tab shows, and the Linux line that copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';
import { airflowView, newView } from './airflow-view-fixture.mjs';

const require = createRequire(import.meta.url);
const { airflowSection } = require('../menu/menu-airflow.js');
const SRC = readFileSync(new URL('../js/menu/xenon-menu-airflow.js', import.meta.url), 'utf8');

// What the menu hands the drawer, kept plain: a key reads as itself, vars after it.
const say = (x) => {
  if (!x) return '';
  if (Array.isArray(x)) return x.map(say).join(', ');
  if (x.pair) return x.pair.map(say).join(': ');
  if (typeof x.text === 'string') return x.text;
  return x.vars ? `${x.key}${JSON.stringify(x.vars)}` : x.key;
};

function rig({ clipboard = true, answer = null } = {}) {
  const { document } = makeDom();
  const timers = new Map();
  let nextTimer = 1;
  const fetched = [];
  const performed = [];
  const env = {
    document,
    navigator: { clipboard: clipboard ? { writeText: async (t) => { env.copied = t; } } : { writeText: async () => { throw new Error('denied'); } } },
    getSelection: () => ({ removeAllRanges() { env.selection = null; }, addRange(r) { env.selection = r.node; } }),
    fetch: async (url) => { fetched.push(url); return { ok: true, json: async () => answer }; },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    setTimeout: () => 0,
    copied: null, selection: null,
  };
  document.visibilityState = 'visible';
  document.createRange = () => ({ node: null, selectNodeContents(n) { this.node = n; } });
  const ctx = vm.createContext({ ...env, window: undefined, module: undefined });
  vm.runInContext(SRC.replace("typeof window !== 'undefined' ? window : globalThis", 'globalThis'), ctx);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const view = ctx.XenonMenuAirflow.create({
    el, button: (cls, label) => { const b = el('button', cls, label); b.type = 'button'; return b; },
    say, tt: (k) => (k === 'locale' ? 'en-US' : k), fill: (s, vars) => `${s}${JSON.stringify(vars)}`, icon: () => null,
    perform: (_row, act) => performed.push(act), server: 'http://127.0.0.1:3030',
    row: (x) => { const n = el('div', 'row row-' + x.kind); n.dataset.row = x.id; return n; },
  });
  const mount = (v) => {
    const r = airflowSection({ airflow: v })[0];
    const page = view.draw(r);
    document.body.appendChild(page);
    return page;
  };
  return { document, view, mount, timers, fetched, performed, env };
}

const tabs = (page) => page.querySelectorAll('.xm-wtab');
const tabNamed = (page, id) => tabs(page).find((b) => b.dataset.keep === 'airflow-tab:' + id);
const tick = async (timers) => { for (const t of [...timers.values()]) t.fn(); await settle(); };

test('driving: the head says why, no steps, four tabs with Now chosen', () => {
  const { mount } = rig();
  const page = mount(airflowView({ why: 'heat-gpu' }));
  assert.ok(page.classList.contains('xm-air--driving'));
  assert.equal(page.querySelector('.xm-air-title').textContent, 'airflow_state_driving');
  assert.equal(page.querySelector('.xm-air-line').textContent, 'airflow_why_heat_gpu');
  assert.equal(page.querySelector('.xm-air-steps'), null);
  assert.deepEqual(tabs(page).map((b) => [b.textContent, b.getAttribute('aria-selected')]), [
    ['airflow_tab_now', 'true'], ['airflow_tab_fans', 'false'], ['airflow_tab_health', 'false'], ['airflow_tab_options', 'false'],
  ]);
  assert.deepEqual(page.querySelectorAll('.row').map((n) => n.dataset.row), ['airflow-drive', 'airflow-mode', 'airflow-slider']);
});

test('first run: the steps with the one now marked, the buttons run the next step', () => {
  const { mount, performed } = rig();
  const page = mount(newView());
  const steps = page.querySelectorAll('.xm-air-steplist li');
  assert.deepEqual(steps.map((li) => li.className), ['is-done', 'is-now', '', '']);
  assert.equal(steps[1].getAttribute('aria-current'), 'step');
  const [check] = page.querySelectorAll('.xm-air-acts button');
  assert.ok(check.classList.contains('ui-btn--primary'));
  check.click();
  assert.deepEqual(performed, [{ run: { type: 'airflowCheck', do: 'start' } }]);
});

test('a tab changes in place, and the speeds are read only while Fans shows', async () => {
  const answer = { ok: true, fans: [{ id: 'lhm:chip0:0', rpm: 1200.4, duty: 52.6, xenon: false }] };
  const { mount, timers, fetched, document } = rig({ answer });
  const page = mount(airflowView());
  assert.equal(timers.size, 0, 'nothing to read on Now');
  tabNamed(page, 'fans').click();
  assert.equal(tabNamed(page, 'fans').getAttribute('aria-selected'), 'true');
  const cards = page.querySelectorAll('.xm-air-fan');
  assert.equal(cards.length, 4);
  assert.equal(cards[0].querySelector('.xm-air-speed').textContent, 'airflow_rpm{"n":"813"} · airflow_duty{"n":"31"}');
  assert.ok(cards[0].querySelector('.xm-air-by').classList.contains('is-xenon'));
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 2000);

  await tick(timers);
  assert.deepEqual(fetched, ['http://127.0.0.1:3030/airflow']);
  const first = page.querySelectorAll('.xm-air-fan')[0];
  assert.equal(first.querySelector('.xm-air-speed').textContent, 'airflow_rpm{"n":"1,200"} · airflow_duty{"n":"53"}');
  assert.equal(first.querySelector('.xm-air-by').textContent, 'airflow_by_pc', 'the PC took it back between two menus');

  document.visibilityState = 'hidden';
  await tick(timers);
  assert.equal(fetched.length, 1, 'a hidden page reads nothing');
  document.visibilityState = 'visible';

  tabNamed(page, 'health').click();
  assert.equal(timers.size, 0, 'off the Fans tab the reading stops');
});

test('a fan card opens its choices and closes again, keeping the keyboard on it', () => {
  const { mount, document } = rig();
  const page = mount(airflowView());
  tabNamed(page, 'fans').click();
  const top = () => page.querySelectorAll('.xm-air-fantop')[2];
  top().focus();
  top().click();
  assert.equal(top().getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, top(), 'the new card has the focus the old one had');
  assert.deepEqual(page.querySelectorAll('.xm-air-fan.is-open .row').map((n) => n.dataset.row), [
    'airflow-leave-lhm:chip0:2', 'airflow-pump-lhm:chip0:2', 'airflow-place-lhm:chip0:2',
  ]);
  top().click();
  assert.equal(page.querySelectorAll('.xm-air-fan.is-open').length, 0);
});

test('driving with the sensor service out of date: which fans stay with the PC, why, and its button', () => {
  const { mount } = rig();
  const page = mount(airflowView({ unavailable: { lhm: 'outdated', link: null } }));
  const head = page.querySelector('.xm-air-head');
  assert.deepEqual(head.querySelectorAll('.xm-air-line').map((n) => [n.textContent, n.classList.contains('xm-tone-warn')]), [
    ['airflow_why_idle', false], ['airflow_part_pc', true], ['airflow_unavail_outdated', false],
  ]);
  assert.equal(head.querySelector('button').textContent, 'airflow_btn_update');
});

test('fans: the line that nothing needs setting, then the fans, then the empty headers closed in one group', () => {
  const { mount, view } = rig();
  const fans = airflowView().fans;
  const empty = (id) => ({ ...fans[0], id, why: 'blind', rpm: 0, duty: null, xenon: false });
  const v = airflowView({ fans: [empty('lhm:chip0:8'), ...fans, empty('lhm:chip0:9')] });
  const page = mount(v);
  tabNamed(page, 'fans').click();
  const panel = page.querySelector('.xm-air-fans');
  assert.equal(panel.children[0].textContent, 'airflow_fans_intro');
  const group = panel.querySelector('.xm-air-emptyfans');
  assert.equal(group.tagName.toLowerCase(), 'details');
  assert.equal(group.open, false);
  assert.equal(group.querySelector('summary').textContent, 'airflow_fans_empty{"n":2}');
  assert.deepEqual(group.querySelectorAll('.xm-air-fan').map((n) => n.dataset.fan), ['lhm:chip0:8', 'lhm:chip0:9']);
  assert.equal(panel.querySelectorAll('.xm-air-fan').length, fans.length + 2, 'every header still has its card');
  assert.equal(panel.children.at(-1), group, 'the group comes after the fans');

  // Opened here, then the menu rebuilds after an SSE push: it stays open.
  group.open = true;
  group._handlers.toggle.forEach((fn) => fn({}));
  const again = view.draw(airflowSection({ airflow: v })[0]);
  assert.equal(again.querySelector('.xm-air-emptyfans').open, true);
});

test('the page left the menu: the next tick stops the timer and reads nothing', async () => {
  const { mount, timers, fetched } = rig({ answer: { ok: true, fans: [] } });
  const page = mount(airflowView());
  tabNamed(page, 'fans').click();
  page.remove();
  await tick(timers);
  assert.equal(timers.size, 0);
  assert.deepEqual(fetched, []);
});

test('the check shows its progress and a stop button', () => {
  const { mount, performed } = rig();
  const page = mount(newView({ state: 'checking', check: { phase: 'pair', progress: 0.25 } }));
  const bar = page.querySelector('.xm-air-progress');
  assert.equal(bar.max, 100);
  assert.equal(bar.value, 25);
  assert.equal(bar.getAttribute('aria-label'), 'airflow_state_checking');
  page.querySelector('.xm-air-acts button').click();
  assert.deepEqual(performed, [{ run: { type: 'airflowCheck', do: 'cancel' } }]);
});

test('Linux: the line to paste is shown whole and copies, or is selected where copying is refused', async () => {
  const blocked = newView({ state: 'unavailable', unavailable: { hwmon: 'access' } });
  const ok = rig();
  const page = ok.mount(blocked);
  assert.equal(page.querySelectorAll('.xm-wtab').length, 0, 'no tabs while the fans are out of reach');
  const code = page.querySelector('.xm-air-code');
  assert.match(code.textContent, /^sudo groupadd -f xenon-fans && /);
  const copy = page.querySelector('.xm-air-cmd button');
  copy.click();
  await settle();
  assert.equal(ok.env.copied, code.textContent);
  assert.equal(copy.textContent, 'airflow_copied');

  const refused = rig({ clipboard: false });
  const again = refused.mount(blocked);
  again.querySelector('.xm-air-cmd button').click();
  await settle();
  assert.equal(refused.env.selection, again.querySelector('.xm-air-code'));
});

test('how Airflow thinks: open at the first step, closed while driving, and a choice made here survives a rebuild', () => {
  const { mount, view } = rig();
  const first = mount(newView());
  const how = first.querySelector('.xm-air-how');
  assert.equal(how.tagName.toLowerCase(), 'details');
  assert.equal(how.open, true);
  assert.equal(how.querySelector('summary').textContent, 'airflow_how_title');
  assert.deepEqual(how.querySelectorAll('dt').map((n) => n.textContent).slice(0, 2), ['airflow_how_curve_t', 'airflow_how_learn_t']);
  assert.equal(how.querySelectorAll('dd').length, how.querySelectorAll('dt').length, 'every point has its text');
  assert.equal(mount(airflowView()).querySelector('.xm-air-how').open, false, 'a fresh page while driving starts closed');

  // The person closes it; the menu rebuilds after an SSE push: it stays closed.
  how.open = false;
  how._handlers.toggle.forEach((fn) => fn({}));
  const again = view.draw(airflowSection({ airflow: newView() })[0]);
  assert.equal(again.querySelector('.xm-air-how').open, false);
});
