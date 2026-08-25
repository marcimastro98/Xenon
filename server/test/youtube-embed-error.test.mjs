// Which YouTube embed errors are about the VIDEO, and which are about this PC.
//
// Reported as issue #126, on macOS: authentication works, every list loads, and
// no video plays — "YouTube Error 153 – Video player configuration error", with
// YouTube offering "Open in the browser".
//
// The widget already had a good answer for a video that refuses to embed: say
// so, offer the browser, and REMEMBER the id so the list can mark it without the
// user tapping it twice. What it did not have was the distinction. 153 is not a
// statement about a video — it is the embed rejecting the referrer it was opened
// with, and it fails on every video equally. Treating it like 101/150 did two
// wrong things at once: it told the reporter "this video cannot be played inside
// apps", sending him hunting for one that would work, and it marked each video
// he tried as unplayable — marks that would have outlived the actual fix.
//
// The reported failure itself is not reproduced here; it needs a Mac and a
// linked YouTube account. What IS pinned is everything downstream of the code
// YouTube hands back, which is the part that made one broken thing look like a
// broken library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../js/youtube-widget.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// The onError branch is lifted out and RUN, rather than pattern-matched: the
// property that matters is "which ids end up in the refused set", and reading
// the source cannot answer that.
function runOnError(codes) {
  const at = WIDGET.indexOf("} else if (d.event === 'onError') {");
  const end = WIDGET.indexOf("} else if (d.event === 'infoDelivery'", at);
  assert.ok(at > -1 && end > at, 'js/youtube-widget.js must still handle onError');
  const body = WIDGET.slice(WIDGET.indexOf('{', at) + 1, end);

  const refused = new Set();
  const player = { blocked: false, state: -1, errCode: 0 };
  let painted = 0;
  const fn = new Function('player', 'refused', 'cur', 'paintLibrary', 'paintPlayer', 'info', body);
  for (const [i, code] of codes.entries()) {
    fn(player, refused, () => ({ id: 'vid' + i }), () => { painted += 1; }, () => {}, code);
  }
  return { refused: [...refused], player, painted };
}

// ── The reported case ────────────────────────────────────────────────────────

test('a 153 never marks the video that hit it', () => {
  const r = runOnError([153]);
  assert.deepEqual(r.refused, [], 'the video is not at fault and must not be marked');
  assert.equal(r.player.blocked, true, 'but the player still says something instead of sitting blank');
  assert.equal(r.player.errCode, 153, 'and remembers which answer it got');
});

// The shape of the reported session: the user works down his liked videos.
test('a whole library tapped through under 153 comes out unmarked', () => {
  const r = runOnError(Array(8).fill(153));
  assert.deepEqual(r.refused, [], 'eight taps, eight failures, nothing marked unplayable');
  assert.equal(r.painted, 0, 'and the list is never repainted, because nothing about it changed');
});

// ── The case that was already right ──────────────────────────────────────────

test('101 and 150 still mark the video, because those are about the video', () => {
  assert.deepEqual(runOnError([101]).refused, ['vid0']);
  assert.deepEqual(runOnError([150]).refused, ['vid0']);
});

test('the other codes are shown but not remembered', () => {
  // 2 bad parameter, 5 player fault, 100 video gone. None of them says "this
  // video may not be embedded", which is the only claim the mark makes.
  for (const code of [2, 5, 100]) {
    assert.deepEqual(runOnError([code]).refused, [], `error ${code} must not mark the video`);
  }
});

test('a missing or junk code is treated as not-about-the-video', () => {
  for (const code of [undefined, null, 'nope', NaN]) {
    const r = runOnError([code]);
    assert.deepEqual(r.refused, [], `${String(code)} must not mark the video`);
    assert.equal(r.player.blocked, true, 'and must still explain itself');
  }
});

// ── What the user is told ────────────────────────────────────────────────────

test('153 gets its own sentence, and it does not blame the video', () => {
  const at = WIDGET.indexOf('function blockedText()');
  assert.notEqual(at, -1, 'blockedText must still exist');
  const body = WIDGET.slice(at, WIDGET.indexOf('\n  }', at));
  assert.match(body, /errCode === 153/);
  assert.match(body, /youtube_embed_config/);
  assert.match(body, /youtube_no_embed/, 'and the per-video sentence is still there for 101/150');
});

// The overlay is built once and only shown/hidden on repaint, so text set at
// build time would freeze — on the first error seen, and in the language that
// was active then.
test('the overlay text is refreshed on every paint, not just on build', () => {
  const at = WIDGET.indexOf("card.querySelector('.yt-blocked')");
  const near = WIDGET.slice(at, at + 400);
  assert.match(near, /\.yt-blocked-txt'\)\.textContent = blockedText\(\)/);
});

test('the new sentence is translated in every language the app ships', () => {
  const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];
  const re = /(^|[\s{,])youtube_embed_config\s*:/;
  const found = new Set();
  let cur = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) cur = ns[1];
    if (re.test(line)) found.add(cur);
  }
  assert.deepEqual(LANGS.filter((l) => !found.has(l)), []);
});

// ── The state cannot get stuck ───────────────────────────────────────────────

// A code left behind from a previous video would put the wrong sentence on the
// next failure — and, worse, keep saying "not the video" about one that IS.
test('every place that clears blocked also clears the code', () => {
  const clears = WIDGET.match(/player\.blocked = false/g) || [];
  const withCode = WIDGET.match(/player\.blocked = false;? player\.errCode = 0|player\.blocked = false; player\.errCode = 0/g) || [];
  assert.equal(clears.length, withCode.length, 'a blocked reset that forgets the code leaves a stale sentence');
  assert.ok(clears.length >= 4, 'all four reset paths are still here');
});
