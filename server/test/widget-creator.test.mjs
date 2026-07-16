// Tests for the no-code widget generator (server/js/widget-templates.js): every
// template × option matrix must produce a payload the REAL server validator
// (validateWidgetPayload → normalizeManifest) accepts, with no injection escape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const WT = req('../js/widget-templates.js');
const sdk = req('../sdk-widgets.js');

const TEMPLATE_IDS = Object.keys(WT.TEMPLATES);

// Build an id the same way the wizard would, but deterministically for tests.
function payloadFor(templateId, options, extra) {
  return WT.buildWidgetPayload({
    templateId,
    id: 'test-' + templateId,
    name: (extra && extra.name) || ('Test ' + templateId),
    author: (extra && extra.author) || 'Tester',
    options: options || WT.defaultOptions(templateId),
  });
}

function manifestOf(payload) {
  const f = payload.files.find((x) => x.path === 'manifest.json');
  return JSON.parse(Buffer.from(f.data, 'base64').toString('utf8'));
}
function fileText(payload, path) {
  const f = payload.files.find((x) => x.path === path);
  return f ? Buffer.from(f.data, 'base64').toString('utf8') : null;
}

test('every template has default options and lists cleanly', () => {
  assert.ok(TEMPLATE_IDS.length >= 5);
  for (const id of TEMPLATE_IDS) {
    const def = WT.defaultOptions(id);
    assert.equal(typeof def, 'object');
  }
  const list = WT.listTemplates();
  assert.equal(list.length, TEMPLATE_IDS.length);
  for (const t of list) assert.match(t.i18n.name, /^wc_/);
});

test('defaults produce a payload the real validator accepts', () => {
  for (const id of TEMPLATE_IDS) {
    const payload = payloadFor(id);
    assert.ok(payload, id + ' built');
    const v = sdk.validateWidgetPayload(payload);
    assert.equal(v.ok, true, id + ' → ' + (v.reason || 'ok'));
    // Declared entry file is present.
    assert.ok(payload.files.some((f) => f.path === v.manifest.entry));
    // Always five files, well under caps.
    assert.equal(payload.files.length, 5);
  }
});

test('option matrix: toggles flipped, extreme sizes, adversarial text all validate', () => {
  const adversarial = [
    '</script><img src=x onerror=alert(1)>',
    '../../etc/passwd',
    '   line sep',
    'éè unicode \u{1f600}',
    'a'.repeat(500),
    '"quotes" and \\backslashes\\',
    '',
  ];
  for (const id of TEMPLATE_IDS) {
    const def = WT.defaultOptions(id);
    for (const txt of adversarial) {
      const opts = { ...def };
      // Flip every boolean and inject adversarial text into every string field.
      WT.TEMPLATES[id].options.forEach((o) => {
        if (o.type === 'toggle') opts[o.key] = !def[o.key];
        else if (o.type === 'text') opts[o.key] = txt;
        else if (o.type === 'range') opts[o.key] = 3;
      });
      const payload = WT.buildWidgetPayload({ templateId: id, id: 'adv-' + id, name: txt || 'x', author: txt, options: opts });
      const v = sdk.validateWidgetPayload(payload);
      assert.equal(v.ok, true, id + ' / ' + JSON.stringify(txt).slice(0, 30) + ' → ' + (v.reason || 'ok'));
    }
  }
});

test('adversarial text cannot break out of the widget.js script string', () => {
  const bad = '</script><script>alert(1)</script> x';
  const payload = payloadFor('label', { ...WT.defaultOptions('label'), text: bad, subtitle: bad });
  const js = fileText(payload, 'widget.js');
  // No raw closing script tag survives in the generated source.
  assert.equal(/<\/script/i.test(js), false);
  // And the embedded CFG round-trips back to the exact original text.
  const m = js.match(/JSON\.parse\((".*?")\);/);
  assert.ok(m, 'CFG literal present');
  const cfg = JSON.parse(JSON.parse(m[1]));
  assert.equal(cfg.text, bad);
  assert.equal(cfg.subtitle, bad);
});

test('preview doc never contains a raw closing script tag', () => {
  for (const id of TEMPLATE_IDS) {
    const doc = WT.buildPreviewDoc(id, { ...WT.defaultOptions(id), title: '</script>x', text: '</script>x' });
    assert.equal(/<\/script(?!>)|<\/script>(?!<\/body)/i.test(doc.replace('</scr' + 'ipt></body>', '')), false, id);
    assert.match(doc, /Content-Security-Policy/);
    assert.match(doc, /connect-src 'none'/);
  }
});

test('streams and actions survive normalizeManifest and depend on options', () => {
  // nowplaying: controls flip the media action on/off.
  const noCtl = manifestOf(payloadFor('nowplaying', { ...WT.defaultOptions('nowplaying'), showControls: false }));
  assert.deepEqual(noCtl.actions, []);
  const withCtl = manifestOf(payloadFor('nowplaying', { ...WT.defaultOptions('nowplaying'), showControls: true }));
  assert.deepEqual(withCtl.actions, ['media']);
  assert.deepEqual(withCtl.streams, ['media']);
  // meter always needs system.
  assert.deepEqual(manifestOf(payloadFor('meter')).streams, ['system']);
  // clock needs nothing.
  assert.deepEqual(manifestOf(payloadFor('clock')).streams, []);
  // label: status only when the badge is on.
  assert.deepEqual(manifestOf(payloadFor('label', { ...WT.defaultOptions('label'), showStatus: false })).streams, []);
  assert.deepEqual(manifestOf(payloadFor('label', { ...WT.defaultOptions('label'), showStatus: true })).streams, ['status']);
});

test('normalizeOptions clamps colours, fonts, enums, ranges and datetimes', () => {
  const o = WT.normalizeOptions('clock', {
    accent: 'javascript:alert(1)', size: 99, font: 'evil-font', format24: 'yes',
    title: 'x'.repeat(999),
  });
  assert.equal(o.accent, '#7c5cff');           // non-hex → default
  assert.equal(o.size, 3);                       // clamped to max
  assert.equal(o.font, 'inter');                 // unknown → default
  assert.equal(o.format24, true);                // truthy coerced
  assert.equal(o.title.length, 40);              // capped

  const m = WT.normalizeOptions('meter', { metrics: ['cpu', 'evil', 'gpu'], style: 'spiral' });
  assert.deepEqual(m.metrics, ['cpu', 'gpu']);   // unknown metric dropped
  assert.equal(m.style, 'bar');                  // out-of-enum → default

  const cd = WT.normalizeOptions('countdown', { target: 'not-a-date' });
  assert.equal(cd.target, '');                   // invalid datetime → empty
  const cd2 = WT.normalizeOptions('countdown', { target: '2026-12-31T23:59' });
  assert.equal(cd2.target, '2026-12-31T23:59');  // valid datetime kept
});

test('xgen.json round-trips template + normalized options (the Edit contract)', () => {
  const opts = { ...WT.defaultOptions('meter'), title: 'My rig', style: 'ring', metrics: ['cpu', 'gpu'] };
  const payload = payloadFor('meter', opts);
  const xgen = JSON.parse(fileText(payload, 'xgen.json'));
  assert.equal(xgen.v, 1);
  assert.equal(xgen.template, 'meter');
  assert.deepEqual(xgen.options, WT.normalizeOptions('meter', opts));
});

test('slugId always yields a valid widget id', () => {
  const cases = ['My Widget!!!', '   ', '123', '---', 'ÜÑÍÇÖDÉ', 'a', 'A'.repeat(80)];
  for (const c of cases) {
    const id = WT.slugId(c);
    assert.match(id, WT.WIDGET_ID_RE, 'slug of ' + JSON.stringify(c) + ' = ' + id);
  }
});

test('buildWidgetPayload rejects an unknown template', () => {
  assert.equal(WT.buildWidgetPayload({ templateId: 'nope' }), null);
});

test('generated widget.js parses as valid JavaScript for every template', () => {
  for (const id of TEMPLATE_IDS) {
    const js = fileText(payloadFor(id), 'widget.js');
    // Compile without running — catches template syntax errors the payload
    // validator can't see (it never executes widget.js).
    assert.doesNotThrow(() => new Function(js), id + ' widget.js parses');
  }
});

test('generated index.html links external css/js and inlines no script', () => {
  for (const id of TEMPLATE_IDS) {
    const html = fileText(payloadFor(id), 'index.html');
    assert.match(html, /<link rel="stylesheet" href="widget\.css">/);
    assert.match(html, /<script src="widget\.js">/);
    // No inline script body (CSP script-src 'self' would block it anyway).
    assert.equal(/<script>[^]*?<\/script>/i.test(html), false, id);
  }
});

test('generated widgets choose readable authored accent text and accept explicit tile overrides', () => {
  const lightCss = fileText(payloadFor('label', { ...WT.defaultOptions('label'), accent: '#ffffff' }), 'widget.css');
  const darkCss = fileText(payloadFor('label', { ...WT.defaultOptions('label'), accent: '#000000' }), 'widget.css');
  assert.match(lightCss, /--on-accent:#111111/);
  assert.match(darkCss, /--on-accent:#ffffff/);
  const js = fileText(payloadFor('label'), 'widget.js');
  assert.match(js, /t\.overrides/);
  assert.match(js, /indexOf\("accent"\)/);
});
