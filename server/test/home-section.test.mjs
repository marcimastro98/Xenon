// The home choices in Settings (js/smart-home/home-section.js): the doorbell card and its phone
// push, Bit's camera question and the home log, each saved through the normal settings path, and
// shown only where Home Assistant or the cameras are connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const SRC = readFileSync(new URL('../js/smart-home/home-section.js', import.meta.url), 'utf8');

function rig(home) {
  const dom = makeDom();
  const saves = [];
  const ctx = {
    document: dom.document, console,
    hubSettings: { home, homeAssistant: { url: 'http://ha.example:8123', tokenSet: true }, unifi: {} },
    normalizeSettings: (v) => v,
    saveHubSettings: () => { saves.push(JSON.parse(JSON.stringify(ctx.hubSettings.home))); },
    t: (k) => `t:${k}`,
  };
  ctx.window = ctx;
  vm.runInNewContext(SRC, ctx);
  return { ctx, dom, saves };
}

const rowOf = (wrap, key) => wrap.querySelectorAll('.settings-toggle-row').find((r) => r.textContent.includes(`t:${key}`));

test('the home log is on unless switched off, and its switch saves the choice', () => {
  const { ctx, saves } = rig({ doorbell: true, doorbellPush: true, bitCameras: 'ask' });
  const wrap = ctx.HomeSection.build();
  const row = rowOf(wrap, 'home_log');
  assert.ok(row, 'the log switch is there');
  const box = row.querySelector('input');
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent({ type: 'change' });
  assert.equal(saves.at(-1).log, false);
  assert.equal(saves.at(-1).bitCameras, 'ask', 'the other choices are kept');
  const off = rig({ doorbell: true, doorbellPush: true, bitCameras: 'ask', log: false });
  assert.equal(rowOf(off.ctx.HomeSection.build(), 'home_log').querySelector('input').checked, false);
});

test('the section sits only under what is connected', () => {
  const { ctx, dom } = rig({});
  const ha = dom.mkEl('div');
  ha.id = 'settings-smarthome-hub';
  const cams = dom.mkEl('div');
  cams.id = 'settings-unifi-hub';
  dom.document.body.append(ha, cams);
  ctx.HomeSection.mount();
  assert.equal(ha.querySelectorAll('.home-section').length, 1);
  assert.equal(cams.querySelectorAll('.home-section').length, 0);
  ctx.HomeSection.mount();
  assert.equal(ha.querySelectorAll('.home-section').length, 1, 'mounted again, never twice');
});
