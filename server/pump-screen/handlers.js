'use strict';
// The pump screens' route handlers, made for one store and one live state
// (routes.js wires the real ones; tools/pump-face-shots wires its own). What each
// route is and who may call it: routes.js.

const fs = require('fs');
const path = require('path');
const Model = require('../js/pump/pump-model.js');
const { screenIds } = require('./moments.js');
const Edit = require('./edit.js');
const { createChange } = require('./change.js');
const { pumpStrings } = require('./strings.js');

const MAX_BODY_BYTES = 16 * 1024;
const PAGE = path.join(__dirname, '..', 'pump-face.html');
const WIDGET_PAGE = path.join(__dirname, '..', 'pump-widget.html');
const STRINGS_MARK = '<!-- pump strings -->';
// This run of the engine. A pump's page left open across an update (iCUE keeps its widget's page
// for days) loads again when an answer names another run than the one that served it (face-kit.js).
const RUN = Date.now().toString(36);

// What a face needs from the settings: the language its words came in, how temperatures
// and the time are written, and the theme's colour (a line's look can follow it).
const HEX = /^#[0-9a-f]{6}$/i;
function prefsOf(s) {
  const tempUnit = s.tempUnit === 'f' ? 'f' : 'c';
  return {
    accent: typeof s.accent === 'string' && HEX.test(s.accent) ? s.accent.toLowerCase() : '#6ee787',
    lang: typeof s.language === 'string' && s.language ? s.language : 'en',
    tempUnit,
    hwTempUnit: s.hwTempUnit === 'c' || s.hwTempUnit === 'f' ? s.hwTempUnit : tempUnit,
    clockFormat: s.clockFormat === '12' || s.clockFormat === '24' ? s.clockFormat : 'auto',
  };
}

// ring: pump-screen/ring.js, where the colours a page says go (the shots tool has none).
// presence: pump-screen/presence.js, told each time a pump's page speaks.
function createRoutes({ store, live, ring = null, presence = null, settings = () => ({}) }) {
  const change = createChange({ store, live });
  async function view() {
    const model = await store.ready();
    const screens = {};
    for (const id of screenIds(model)) {
      screens[id] = { ...Model.screenFor(model, id), set: !!model.screens[id], seen: model.seen[id] || null, here: presence ? presence.here(id) : true };
    }
    return { ok: true, screens, now: live.decide(), prefs: prefsOf(settings() || {}), run: RUN };
  }

  async function readJson(req, readBody) {
    try { return JSON.parse(await readBody(req, MAX_BODY_BYTES)); } catch { return null; }
  }

  async function write(req, _res, { json, readBody }) {
    const b = await readJson(req, readBody);
    if (!b || typeof b !== 'object') { json({ ok: false, error: 'bad_request' }); return; }
    let out;
    try { out = await change(b); }
    catch { json({ ok: false, error: 'write_failed' }); return; }
    if (out?.error) { json({ ok: false, error: out.error, ...(out.choices ? { choices: out.choices } : {}) }); return; }
    json(await view());
  }

  async function hello(req, _res, { json, readBody }) {
    const b = await readJson(req, readBody);
    const id = Model.screenId(b?.screen);
    if (!id) { json({ ok: false, error: 'bad_screen' }); return; }
    const out = await store.remember((m) => Edit.noteSeen(m, id, b));
    if (out?.model) live.push(true);
    const model = await store.ready();
    if (!model.seen[id]) { json({ ok: false, error: 'too_many_screens' }); return; }
    presence?.note(id);
    json({ ok: true, screen: id, settings: Model.screenFor(model, id), now: live.decide()[id] || null, run: RUN });
  }

  // A pump's page holds this open while it shows (presence.js): closed, the screen is away
  // in seconds. Nothing is sent but the first lines; the page reconnects itself after a second.
  async function holdOpen(req, res, { urlObj }) {
    const id = Model.screenId(urlObj?.searchParams.get('screen'));
    const model = await store.ready();
    if (!presence || !id || !model.seen[id]) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('unknown screen');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1000\n:here\n\n');
    req.on('close', presence.hold(id));
  }

  // The colours of what a pump's page shows, for the ring of lights around it.
  async function colours(req, _res, { json, readBody }) {
    const b = await readJson(req, readBody);
    const id = Model.screenId(b?.screen);
    const model = await store.ready();
    if (!id || !model.seen[id]) { json({ ok: false, error: 'bad_screen' }); return; }
    presence?.note(id);
    if (!ring?.report(id, b.colors, b.level, b.effect)) { json({ ok: false, error: 'bad_colors' }); return; }
    json({ ok: true });
  }

  async function page(_req, _res, { sendPage }) {
    const html = await fs.promises.readFile(PAGE, 'utf8');
    // JSON inside <script type="application/json">: a "<" in a translation can never close the tag.
    const prefs = prefsOf(settings() || {});
    const strings = JSON.stringify({ words: await pumpStrings(prefs.lang), prefs, run: RUN }).replace(/</g, '\\u003c');
    await sendPage(html.replace(STRINGS_MARK, `<script type="application/json" id="pump-strings">${strings}</script>`));
  }

  // A Store widget as a pump's face: the page reads the widget's id itself, never served here.
  async function widgetPage(_req, _res, { sendPage }) {
    await sendPage(await fs.promises.readFile(WIDGET_PAGE, 'utf8'));
  }

  return {
    'GET /pump': async (_req, _res, { json }) => json(await view()),
    'POST /pump': write,
    'POST /pump/hello': hello,
    'GET /pump/here': holdOpen,
    'POST /pump/colors': colours,
    'GET /pump-face': page,
    'GET /pump-widget': widgetPage,
  };
}

module.exports = { createRoutes, prefsOf, MAX_BODY_BYTES };
