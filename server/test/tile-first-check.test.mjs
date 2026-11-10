// A tile that does not know yet whether it is unlocked asks the server. The grid renders many times
// while the page starts, and each render used to send its own question until the first answer came
// back: 14 for Lyrics, each with a second one for the pass, in the first seconds of every load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const TILES = [
  { file: 'lyrics-widget.js', mount: 'lyrics-widget-mount', api: 'LyricsWidget', state: '/api/features/lyrics' },
  { file: 'devclean-widget.js', mount: 'devclean-widget-mount', api: 'DevCleanWidget', state: '/api/features/devclean' },
];

function load({ file, mount: mountClass, api }) {
  const dom = makeDom();
  const mount = dom.mkEl('div');
  mount.className = mountClass;
  mount.getClientRects = () => [{}];
  dom.document.body.appendChild(mount);
  dom.document.readyState = 'complete';
  dom.document.querySelectorAll = (selector) => (selector.includes(mountClass) ? [mount] : []);
  dom.document.querySelector = (selector) => (selector.includes(mountClass) ? mount : null);

  const asked = [];
  const waiting = [];
  const window = { addEventListener() {}, DevCleanPitch: { render: () => dom.mkEl('div') } };
  const fetch = (url) => {
    asked.push(url);
    return new Promise((resolve) => { waiting.push(resolve); });
  };
  const source = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    window, document: dom.document, fetch, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });

  const answerAll = async (body) => {
    while (waiting.length) {
      waiting.shift()({ status: 200, ok: true, json: async () => body });
      await settle();
    }
  };
  return { asked, answerAll, render: () => window[api].renderWidgets() };
}

for (const tile of TILES) {
  test(`${tile.file}: renders in a burst ask once whether it is unlocked`, async () => {
    const page = load(tile);
    for (let render = 0; render < 5; render += 1) page.render();
    await settle();
    assert.equal(page.asked.filter((url) => url === tile.state).length, 1);
  });

  test(`${tile.file}: the answer ends the question`, async () => {
    const page = load(tile);
    await page.answerAll({ ok: true, unlocked: false });
    page.render();
    await settle();
    assert.equal(page.asked.filter((url) => url === tile.state).length, 1);
  });

  test(`${tile.file}: a server that does not answer leaves the tile locked, not asking in a loop`, async () => {
    const page = load(tile);
    await page.answerAll({ ok: false });
    page.render();
    page.render();
    await settle();
    assert.equal(page.asked.filter((url) => url === tile.state).length, 1);
  });
}
