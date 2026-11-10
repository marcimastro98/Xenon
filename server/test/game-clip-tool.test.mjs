// tools/whats-new-media/game-clip.mjs records a real game for the 5.0 page and keeps
// only Xenon's readings sharp. Its ffmpeg arguments are pure, so what they must keep is
// checked here: the recording stays out of the repo's pictures, and the blur covers
// everything but the box it is given.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIP, blurArgs, frameArgs, parseArgs, parseFrame, parseKeep, recordArgs } from '../../tools/whats-new-media/game-clip.mjs';

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('the steps and their options come from the command line, and a wrong one stops it', () => {
  assert.deepEqual(parseArgs(['record', '--monitor', '1', '--seconds', '10']), { step: 'record', input: null, monitor: '1', seconds: '10' });
  assert.deepEqual(parseArgs(['build', 'rec.mp4', '--keep', '1,2,3,4']), { step: 'build', input: 'rec.mp4', keep: '1,2,3,4' });
  assert.throws(() => parseArgs(['shoot']), /unknown step: shoot/);
  assert.throws(() => parseArgs([]), /unknown step: \(none\)/);
  assert.throws(() => parseArgs(['still']), /still needs the recording/);
  assert.throws(() => parseArgs(['build', 'rec.mp4']), /build needs --keep/);
  assert.throws(() => parseArgs(['record', '--monitor']), /--monitor needs a value/);
  assert.throws(() => parseArgs(['build', 'rec.mp4', '--keep', '1,2,3,4', '--name', '../x']), /bad name/);
});

test('one monitor is grabbed by Desktop Duplication, without the pointer or sound', () => {
  const args = recordArgs(1, 12, 'rec.mp4');
  assert.match(after(args, '-i'), /^ddagrab=output_idx=1:framerate=30:draw_mouse=0$/);
  assert.equal(after(args, '-t'), '12');
  assert.match(after(args, '-vf'), /^hwdownload,format=bgra/);
  assert.ok(args.includes('-an'));
  assert.equal(args.at(-1), 'rec.mp4');
  assert.throws(() => recordArgs(-1, 12, 'rec.mp4'), /bad monitor/);
  assert.throws(() => recordArgs(0, 0, 'rec.mp4'), /bad length/);
});

test('a still is one frame at the asked second', () => {
  const args = frameArgs('rec.mp4', 4, 'still.png');
  assert.equal(after(args, '-ss'), '4');
  assert.equal(after(args, '-frames:v'), '1');
  assert.equal(args.at(-1), 'still.png');
});

test('the box to keep is four whole pixel numbers with a size', () => {
  assert.deepEqual(parseKeep('20,40,360,420'), { x: 20, y: 40, width: 360, height: 420 });
  for (const bad of ['', '1,2,3', '1,2,3,4,5', '1,2,0,4', '1,2,3.5,4', '-1,2,3,4', 'a,b,c,d']) {
    assert.throws(() => parseKeep(bad), /--keep takes x,y,w,h/, bad);
  }
});

test('everything is blurred but the box, which goes back in the same place', () => {
  const keep = { x: 20, y: 40, width: 360, height: 420 };
  const graph = after(blurArgs('rec.mp4', 'out.mp4', keep, 1.5), '-filter_complex');
  assert.match(graph, new RegExp(`\\[a\\]gblur=sigma=${CLIP.blur}\\[bg\\]`));
  assert.match(graph, /\[b\]crop=360:420:20:40,format=yuva444p,geq=/);
  // Soft edges: the box fades into the blur over CLIP.feather pixels.
  assert.ok(graph.includes(`min(Y,H-1-Y))/${CLIP.feather})'[k]`));
  assert.match(graph, /\[bg\]\[k\]overlay=20:40,/);
  // Blurred at the recording's size, before it shrinks to the page's.
  assert.ok(graph.indexOf('overlay') < graph.indexOf(`scale=${CLIP.width}:${CLIP.height}`));
  assert.equal(after(blurArgs('rec.mp4', 'out.mp4', keep, 1.5), '-ss'), '1.5');
  assert.ok(CLIP.blur >= 20, 'a light blur would leave names readable');
});

test('a frame cuts a 16:9 part after the blur, so the readings stay large on the page', () => {
  assert.deepEqual(parseFrame('1920,0,1920,1080'), { x: 1920, y: 0, width: 1920, height: 1080 });
  assert.throws(() => parseFrame('0,0,1000,1000'), /--frame must be 16:9/);
  const keep = { x: 2680, y: 18, width: 1160, height: 40 };
  const graph = after(blurArgs('rec.mp4', 'out.mp4', keep, 0, parseFrame('1920,0,1920,1080')), '-filter_complex');
  assert.match(graph, /overlay=2680:18,crop=1920:1080:1920:0,fps=/, 'the box goes back in screen pixels, then the cut');
  assert.doesNotMatch(after(blurArgs('rec.mp4', 'out.mp4', keep), '-filter_complex'), /overlay=2680:18,crop/, 'no frame, the whole screen');
});
