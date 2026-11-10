// fps-reader-log.js: what the main PresentMon writes to server.log. A counter that
// went blank in a game must be explainable afterwards, without a line per retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReaderLog, createStderrTail } = require('../fps-reader-log.js');

function rig() {
  const lines = [];
  const clock = { t: 10_000_000 };
  return { lines, clock, log: createReaderLog((line) => lines.push(line), () => clock.t) };
}

test('the reader starting and pausing is one line each way, however often it is said', () => {
  const { lines, log } = rig();
  log.reading(true);
  log.reading(true);
  log.reading(false);
  log.reading(false);
  assert.deepEqual(lines, ['fps: reading frames for a dashboard or a recording', 'fps: not reading frames, no dashboard, recording or game is open']);
});

test('PresentMon ending is written once, until frames come again', () => {
  const { lines, clock, log } = rig();
  log.rows();
  assert.deepEqual(lines, [], 'rows from a healthy reader say nothing');
  log.ended(clock.t - 1_820_000, 'code 1');
  log.ended(clock.t - 1000, 'code 1');
  assert.deepEqual(lines, ['fps: PresentMon ended after 1820 s (code 1), starting it again'], 'its retries add nothing');
  log.rows();
  log.rows();
  assert.deepEqual(lines.slice(1), ['fps: PresentMon reading again'], 'once: when it came back tells whether a game ran by then');
  log.ended(clock.t - 3000, 'ENOENT');
  assert.equal(lines[2], 'fps: PresentMon ended after 3 s (ENOENT), starting it again');
});

// PresentMon 1.10 writes warnings and errors on stderr, in pieces. Exit code 6 alone
// says only that its trace did not start; the error line says why.
const WARNING = 'warning: PresentMon requires elevated privilege in order to query processes that are\n'
  + "         short-running or started on another account.\n";

test("an end carries PresentMon's own error line, however its stderr arrived", () => {
  const tail = createStderrTail();
  tail.add(WARNING);
  tail.add('error: failed to start trace session');
  tail.add(' (error=1450).\n');
  assert.equal(tail.explain('code 6'), 'code 6, error: failed to start trace session (error=1450).');
});

test('warnings alone explain nothing', () => {
  const tail = createStderrTail();
  tail.add(WARNING);
  assert.equal(tail.explain('code 0'), 'code 0');
});

test('the line stays short and only the end of stderr is kept', () => {
  const long = createStderrTail();
  long.add('error: ' + 'y'.repeat(1000) + '\n');
  assert.equal(long.explain('code 6'), 'code 6, ' + ('error: ' + 'y'.repeat(1000)).slice(0, 200));
  const flooded = createStderrTail();
  flooded.add('error: early\n');
  flooded.add('x'.repeat(5000));
  assert.equal(flooded.explain('code 1'), 'code 1', 'kept to its last 2000 characters, never grown for hours');
});
