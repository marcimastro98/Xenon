// The live Discord watch is stopped through one function. Six places used to carry the same
// line; the settings save was one of them, and it can only leave server.js once it stops
// writing a variable of that file.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { discordWatch, stopDiscordWatch } = require('../discord/watch-stop.js');
const ENGINE = engineSource();
const count = (text) => ENGINE.split(text).length - 1;

test('no watch runs until one is started', () => {
  assert.equal(discordWatch.stop, null);
  assert.doesNotThrow(() => stopDiscordWatch());
  assert.equal(discordWatch.stop, null);
});

test('stopping calls what the watch gave back once, and forgets it', () => {
  let stopped = 0;
  discordWatch.stop = () => { stopped += 1; };
  stopDiscordWatch();
  assert.deepEqual([stopped, discordWatch.stop], [1, null]);
  stopDiscordWatch();
  assert.equal(stopped, 1, 'a second stop does nothing');
});

test('what the watch gave back is called bare, as the line it replaces called it', () => {
  let self = 'not called';
  discordWatch.stop = function stop() { 'use strict'; self = this; };
  stopDiscordWatch();
  assert.equal(self, undefined);
});

test('a stop that throws leaves the watch as it was, as the line it replaces did', () => {
  const broken = () => { throw new Error('socket gone'); };
  discordWatch.stop = broken;
  assert.throws(() => stopDiscordWatch(), /socket gone/);
  assert.equal(discordWatch.stop, broken);
  discordWatch.stop = null;
});

test('the engine starts and stops the watch through the module only', () => {
  assert.equal(count('discordStopWatch'), 0, 'the variable the engine kept is gone');
  assert.equal(count('stopDiscordWatch();'), 7, 'the six places, and where the watch is refreshed');
  assert.equal(count('discordWatch.stop = '), 1, 'set in one place: where the watch starts');
  assert.equal(count('discordWatch.stop('), 0, 'never called as a method of the object');
});
