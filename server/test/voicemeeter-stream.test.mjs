// The `voicemeeter` SDK stream reaches widgets: the server polls the mixer and
// broadcasts a change (server.js refreshVoicemeeterWatch), the dashboard hands
// it to granted widgets (main.js), and so do the pages that run widgets
// without the dashboard (js/widget-feed.js). It was declared and documented but
// never forwarded, so no widget ever got it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const feed = require('../js/widget-feed.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the dashboard and the widget-only pages forward the stream to widgets', () => {
  assert.equal(feed.PLAIN_STREAMS.voicemeeter, 'voicemeeter');
  assert.match(read('../js/main.js'), /es\.addEventListener\('voicemeeter', e => \{\n\s+try \{ if \(window\.CustomWidget\) window\.CustomWidget\.onData\('voicemeeter', JSON\.parse\(e\.data\)\); \} catch \{\}/);
});

test('a dashboard that connects later gets the mixer as last read, not silence', () => {
  const server = read('../server.js');
  assert.ok(server.includes('if (vmLastJson) { try { res.write(`event: voicemeeter\\ndata: ${vmLastJson}\\n\\n`); } catch (e) { /* ignore */ } }'));
  assert.ok(server.includes("broadcastSSE('voicemeeter', v);"));
});
