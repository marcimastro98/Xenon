// tools/app-shots: the dashboard copy serves the working tree read-only and the
// shooter only knows its own scenes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, appFile } from '../../tools/app-shots/serve.mjs';
import { pickScenes } from '../../tools/app-shots/shoot.mjs';
import { SCENES } from '../../tools/app-shots/scenes.mjs';

test('"/" is the dashboard and data/ is never served', () => {
  assert.match(appFile('/'), /server[\\/]index\.html$/);
  assert.match(appFile('/js/sparks-mail.js?v=1'), /server[\\/]js[\\/]sparks-mail\.js$/);
  assert.equal(appFile('/data/settings.json'), null);
  assert.equal(appFile('/../package.json'), null);
});

test('the copy answers APIs empty and writes nothing', async () => {
  const app = await startApp(0);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.match(await (await fetch(`${base}/`)).text(), /<script src="js\/sparks-mail\.js"><\/script>/);
    assert.deepEqual(await (await fetch(`${base}/settings`)).json(), {});
    assert.equal((await fetch(`${base}/api/ai/xenon/balance`)).status, 404);
    assert.equal((await fetch(`${base}/data/settings.json`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/settings`, { method: 'POST', body: '{"x":1}' })).json(), { ok: false });
    const ctl = new AbortController();
    const live = await fetch(`${base}/events`, { signal: ctl.signal });
    assert.equal(live.headers.get('content-type'), 'text/event-stream');
    ctl.abort();
  } finally {
    await app.stop();
  }
});

test('scenes are picked by name, an unknown one is an error, none means all', () => {
  assert.deepEqual(pickScenes([]), Object.keys(SCENES));
  assert.deepEqual(pickScenes(['sparks-mail', '--out', 'x']), ['sparks-mail']);
  assert.throws(() => pickScenes(['nope']), /unknown scene: nope/);
  for (const [name, s] of Object.entries(SCENES)) assert.equal(typeof s.open, 'function', name);
});
