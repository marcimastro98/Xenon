'use strict';
// AirPods and Beats on Windows, which keeps no level for them: the helper listens to what
// they broadcast. Nothing is sent, so this stands with asking switched off. The helper is
// optional and an older one does not know this mode: both just mean no reading.

const path = require('path');
const { execFile } = require('child_process');
const { devicesFrom } = require('./apple-adverts');

const HELPER = path.join(__dirname, '..', 'helper', 'xenon-helper.exe');
const MODE = 'apple-battery';
const LIMIT_MS = 12 * 1000;
const GUARD_KEY = 'apple-adverts';

function runHelper() {
  return new Promise((resolve, reject) => {
    execFile(HELPER, [MODE], { timeout: LIMIT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function readApple(guard, run = runHelper) {
  guard.enter(GUARD_KEY);
  try {
    return devicesFrom(JSON.parse(await run()));
  } catch {
    return [];
  } finally {
    guard.leave();
  }
}

module.exports = { readApple };
