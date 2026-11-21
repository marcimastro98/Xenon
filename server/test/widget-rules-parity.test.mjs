// The widget id rule and the tile sizes are told to coding assistants in three
// places: the xenon-mcp bridge (a separate npm package that cannot require the
// app), the bridge's ops inside Xenon, and Bit's create_widget tool. Each one
// must say what the SDK really accepts, so an id or size the tools offer is
// never refused at install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WIDGET_ID_RE } = require('../widget-sdk/package-names.js');
const { TILE_SIZES } = require('../widget-sdk/manifest-limits.js');
const { TOOLS } = require('../../packages/mcp/src/tools.js');
const { deckCreatorAiFunctions } = require('../ai/core-tools-deck-creator.js');

const lengths = Array.from({ length: 60 }, (_, i) => i + 1).filter((n) => WIDGET_ID_RE.test('a'.repeat(n)));
const MIN = lengths[0];
const MAX = lengths[lengths.length - 1];

test('the id length the SDK accepts is one unbroken range', () => {
  assert.equal(lengths.length, MAX - MIN + 1);
});

test('the xenon-mcp bridge states the SDK id length', () => {
  const id = TOOLS.find((t) => t.name === 'check_widget').inputSchema.properties.id;
  assert.match(id.description, new RegExp(`\\b${MIN} to ${MAX} characters\\b`));
});

test('the xenon-mcp bridge offers exactly the SDK tile sizes', () => {
  const size = TOOLS.find((t) => t.name === 'new_widget').inputSchema.properties.size;
  assert.deepEqual(size.enum, [...TILE_SIZES]);
});

test("Bit's create_widget states the SDK id length", () => {
  const tool = deckCreatorAiFunctions().find((t) => t.name === 'create_widget');
  assert.match(tool.parameters.properties.id.description, new RegExp(`\\b${MIN}-${MAX} chars\\b`));
});

test('a pump screen takes exactly the widget ids the SDK installs', () => {
  const Faces = require('../js/pump/pump-faces.js');
  assert.equal(Faces.WIDGET_ID_RE.source, WIDGET_ID_RE.source);
  assert.deepEqual(Faces.normalizeFace({ face: 'widget', id: 'my-clock' }), { face: 'widget', id: 'my-clock' });
  for (const id of ['', 'a', 'My-Clock', '../x', 'a'.repeat(MAX + 1), undefined]) {
    assert.equal(Faces.normalizeFace({ face: 'widget', id }), null, String(id));
  }
  assert.ok(!Faces.FACES.includes('widget'), 'never in the list a Deck key or "next" picks from');
});
