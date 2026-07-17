// Rich Discord SDK data is deliberately host-mediated. These source-contract
// checks pin the security boundary: packages select a named stream, never a URL,
// and only visible granted tiles can ask the host to refresh private snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const customWidget = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
const main = readFileSync(join(ROOT, 'server', 'js', 'main.js'), 'utf8');

test('Discord snapshot loaders use only fixed local routes', () => {
  for (const route of [
    '/stream/discord/channels',
    '/stream/discord/roster',
    '/stream/discord/sounds',
    '/stream/discord/notifications',
  ]) {
    assert.ok(customWidget.includes("api('" + route + "')"), route + ' must stay host-selected');
  }
  assert.match(customWidget, /const LOCAL_STREAM_LOADERS = Object\.freeze\(\{/);
  assert.doesNotMatch(customWidget, /LOCAL_STREAM_LOADERS\s*\[\s*msg\.(?:url|endpoint|path)/);
});

test('Discord refresh requires the exact grant and a visible non-service frame', () => {
  assert.match(customWidget, /grant\.streams\.includes\(stream\)\s*\|\|\s*!LOCAL_STREAM_LOADERS\[stream\]/);
  assert.match(customWidget, /entry\.service\s*\|\|\s*document\.hidden/);
  assert.match(customWidget, /d\.type === 'refresh'/);
  assert.match(customWidget, /REFRESH_MIN_INTERVAL_MS/);
});

test('live Discord notifications are folded into the granted SDK snapshot', () => {
  assert.match(main, /CustomWidget\.onDiscordNotification\(d\)/);
  assert.match(customWidget, /function onDiscordNotification\(item\)/);
  assert.match(customWidget, /hide:\s*prev\s*\?\s*!!prev\.hide\s*:\s*true/);
});
