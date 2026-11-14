import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSource } from './browser-source.mjs';

// A permission prompt shown while the page loads is one nobody asked for: browsers quiet or
// refuse it. The calendar asks at the first touch, or when the person adds an event.
test('the calendar never asks for notifications while the page loads', () => {
  const source = browserSource('server/js/calendar.js');
  const asks = source.split('\n').filter((line) => line.includes('Notification.requestPermission()'));
  assert.equal(asks.length, 2, 'the two places that ask: the first touch and a new event');
  const atShow = source.slice(source.indexOf('function showCalendar('), source.indexOf('function renderCalendar('));
  assert.match(atShow, /addEventListener\('pointerdown', \(\) => \{ try \{ Promise\.resolve\(Notification\.requestPermission\(\)\)/);
  assert.match(atShow, /\{ once: true \}\);/);
  assert.doesNotMatch(atShow, /^\s*try \{ Promise\.resolve\(Notification\.requestPermission\(\)\)/m);
});
