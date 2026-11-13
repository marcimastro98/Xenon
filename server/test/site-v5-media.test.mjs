// The pictures of the 5.0 page (docs/5.html) are built by tools/whats-new-media/site.mjs.
// Its ffmpeg arguments and crops are pure, so what they must keep is checked here, and the
// pictures the page shows must exist, stay small, and match the app's own clips.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EDGE, SCENE_PAGE, SHARED, SITE_DIR, STEPS, chatClip, copyPlan, loopArgs, pickSteps, rawArgs, stillArgs } from '../../tools/whats-new-media/site.mjs';
import { MAX_CLIP_BYTES, OUT_DIR as APP_DIR } from '../../tools/whats-new-media/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = readFileSync(path.join(ROOT, 'docs', '5.html'), 'utf8');
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('the steps come from the command line in their own order, and an unknown one stops it', () => {
  assert.deepEqual(pickSteps([]), STEPS);
  assert.deepEqual(pickSteps(['bit', 'copy']), ['copy', 'bit']);
  assert.deepEqual(pickSteps(['--quiet', 'edge']), ['edge']);
  assert.throws(() => pickSteps(['bits']), /unknown step: bits/);
});

test('the clips the page shares with the app are copied from the app, clip and poster', () => {
  const plan = copyPlan();
  assert.equal(plan.length, SHARED.length * 2);
  for (const { from, to } of plan) {
    assert.equal(path.dirname(from), APP_DIR);
    assert.equal(path.dirname(to), SITE_DIR);
    assert.equal(path.basename(from), path.basename(to));
  }
});

test('the site shows the same clips the app does, byte for byte', () => {
  for (const { from, to } of copyPlan()) {
    assert.ok(readFileSync(from).equals(readFileSync(to)), `${path.basename(to)} differs from the app's: run node tools/whats-new-media/site.mjs copy`);
  }
});

test('the first clip is drawn at its own size, H.264 in yuv420p, with no sound', () => {
  const args = rawArgs('frames.txt', 'raw.mp4');
  assert.equal(after(args, '-i'), 'frames.txt');
  assert.equal(after(args, '-vf'), `fps=${EDGE.fps},scale=${EDGE.width}:${EDGE.height}:flags=lanczos,format=yuv420p`);
  assert.equal(after(args, '-c:v'), 'libx264');
  assert.ok(args.includes('-an'));
  assert.equal(args.at(-1), 'raw.mp4');
});

test('the loop fades its end into its start, so the jump back never shows', () => {
  const args = loopArgs('raw.mp4', 'edge.mp4', 9.5, 0.8);
  const graph = after(args, '-filter_complex');
  // The body starts where the head ends, and the head fades in over the body's last moment:
  // the last frame is the first one again.
  assert.match(graph, /\[a\]trim=start=0\.8:end=9\.5/);
  assert.match(graph, /\[b\]trim=start=0:end=0\.8/);
  assert.match(graph, /xfade=transition=fade:duration=0\.8:offset=7\.90/);
  assert.match(graph, /format=yuv420p/);
  assert.equal(after(args, '-movflags'), '+faststart');
  assert.ok(args.includes('-an'));
});

test('a recording too short for its crossfade stops the build', () => {
  assert.throws(() => loopArgs('raw.mp4', 'edge.mp4', 1.6, 0.8), /too short/);
  assert.throws(() => loopArgs('raw.mp4', 'edge.mp4', Number.NaN, 0.8), /too short/);
  // The recording the tool makes is long enough, with its poster inside the loop.
  assert.doesNotThrow(() => loopArgs('raw.mp4', 'edge.mp4', EDGE.recordMs / 1000));
  assert.ok(EDGE.posterAt < EDGE.recordMs / 1000 - EDGE.fade);
});

test('the Bit picture starts at the chat, inside the panel and its ink edge', () => {
  const panel = { x: 100, y: 50, width: 600, height: 400 };
  assert.deepEqual(chatClip(panel, 200, 24, 4), { x: 104, y: 176, width: 596, height: 274 });
  // A chat that starts at the top of the panel never takes the edge with it.
  assert.deepEqual(chatClip(panel, 60, 24, 4), { x: 104, y: 54, width: 596, height: 396 });
});

test('the Bit still is a WebP', () => {
  const args = stillArgs('bit.png', 'bit.webp');
  assert.equal(after(args, '-i'), 'bit.png');
  assert.equal(after(args, '-c:v'), 'libwebp');
  assert.equal(args.at(-1), 'bit.webp');
});

test('the scene page loads the app\'s own What\'s New, with a language for its words', () => {
  const sources = [...SCENE_PAGE.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sources, ['components/WhatsNew/WhatsNew.css', 'layer-i18n.js', 'js/whats-new-scenes.js']);
  // The words are built by the server, the other two are files it serves.
  const served = readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  assert.ok(served.includes("'/layer-i18n.js'"), 'the server no longer answers /layer-i18n.js');
  for (const file of sources.filter((f) => f !== 'layer-i18n.js')) assert.ok(existsSync(path.join(ROOT, 'server', file)), `server/${file} is gone`);
  assert.ok(SCENE_PAGE.indexOf("let lang = 'en'") < SCENE_PAGE.indexOf('layer-i18n.js'));
  const scenes = readFileSync(path.join(ROOT, 'server', 'js', 'whats-new-scenes.js'), 'utf8');
  assert.match(scenes, /window\.XenonWhatsNewScenes\s*=/);
  assert.match(scenes, /\bbit\b/);
});

test('every picture the page names exists, and every clip has its poster and stays small', () => {
  const named = [...new Set([...PAGE.matchAll(/(?:src|poster)="\/images\/v5\/([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(named.includes('edge.mp4') && named.includes('bit.webp'));
  for (const file of named) assert.ok(existsSync(path.join(SITE_DIR, file)), `docs/images/v5/${file} is missing`);
  for (const [, clip, poster] of PAGE.matchAll(/<video src="\/images\/v5\/([^"]+)" poster="\/images\/v5\/([^"]+)"/g)) {
    assert.equal(poster, clip.replace(/\.mp4$/, '.webp'));
    const bytes = statSync(path.join(SITE_DIR, clip)).size;
    assert.ok(bytes <= MAX_CLIP_BYTES, `${clip} is ${bytes} bytes`);
  }
});
