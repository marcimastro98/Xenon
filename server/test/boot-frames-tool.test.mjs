// tools/boot-frames/sheet.mjs: a contact sheet is only useful if each picture is the frame asked for.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickFrames } from '../../tools/boot-frames/sheet.mjs';

const FILES = ['f000-000045.png', 'f009-001511.png', 'f010-001676.png', 'f123-015040.png', 'notes.txt'];

test('frames come back in the order asked, with their time', () => {
  assert.deepEqual(pickFrames(FILES, [10, 0, 123]), [
    { file: 'f010-001676.png', ms: 1676 },
    { file: 'f000-000045.png', ms: 45 },
    { file: 'f123-015040.png', ms: 15040 },
  ]);
});

test('a frame that is not there says so', () => {
  assert.throws(() => pickFrames(FILES, [11]), /no frame 11/);
});
