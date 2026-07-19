// The xenon-audit-review skill decides whether a community submission is safe by
// reasoning from the sandbox CSP: "fetch cannot reach the network, so this
// finding means broken, not dangerous". That reasoning is only as true as the
// copy of the CSP written into the skill's reference file. If a directive is
// ever loosened in the code and the reference is not updated, the skill keeps
// giving the old, now-wrong answer with full confidence, and the failure is
// silent because nothing imports a markdown file.
//
// So: pin the copies. This test fails when the skill's transcription drifts from
// the live constants. Fix the markdown, not this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sdk = require(join(ROOT, 'server', 'sdk-widgets.js'));

const MODEL = readFileSync(
  join(ROOT, '.claude', 'skills', 'xenon-audit-review', 'reference', 'runtime-model.md'),
  'utf8',
);

// WIDGET_CSP is exported already joined with '; '. Split it back so each
// directive can be checked on its own line, which is how the skill lists them.
const DIRECTIVES = String(sdk.WIDGET_CSP).split(';').map((d) => d.trim()).filter(Boolean);

test('the skill quotes every live widget CSP directive verbatim', () => {
  for (const directive of DIRECTIVES) {
    assert.ok(
      MODEL.includes(directive),
      `runtime-model.md is missing the live directive "${directive}". `
      + 'The skill reasons from this list to decide what a widget can reach; update the file.',
    );
  }
});

// The inverse: a directive the skill claims but the code no longer sets would
// make it dismiss real findings as blocked. Only the directives actually present
// may appear in the widget CSP block.
test('the skill claims no widget CSP directive the code does not set', () => {
  const block = MODEL.split('```')[1] || '';
  const claimed = block.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(claimed.length > 0, 'expected the widget CSP fenced block in runtime-model.md');
  for (const line of claimed) {
    assert.ok(
      DIRECTIVES.includes(line),
      `runtime-model.md claims "${line}" but WIDGET_CSP no longer sets it.`,
    );
  }
});

// The background frame is the one place `unsafe-eval` is deliberately allowed,
// and the skill's whole per-kind split depends on that staying true: it tells
// reviewers `eval` is expected in a background and impossible in a widget. If
// custom-bg.js ever drops unsafe-eval, or sdk-widgets.js ever gains it, both
// halves of that advice invert.
test('the background frame still allows unsafe-eval and the widget CSP still does not', () => {
  const bg = readFileSync(join(ROOT, 'server', 'js', 'custom-bg.js'), 'utf8');
  const frameCsp = (bg.match(/const FRAME_CSP\s*=\s*([\s\S]*?);\s*[\r\n]/) || [])[1] || '';
  assert.ok(frameCsp, 'could not find FRAME_CSP in custom-bg.js');
  assert.match(frameCsp, /unsafe-eval/, 'the background frame no longer allows unsafe-eval');
  assert.match(frameCsp, /connect-src 'none'/, 'the background frame lost connect-src none');
  assert.ok(
    !DIRECTIVES.some((d) => d.includes('unsafe-eval')),
    'the widget CSP gained unsafe-eval: the skill tells reviewers eval cannot run in a widget',
  );
  assert.match(MODEL, /unsafe-eval/, 'runtime-model.md no longer explains the background exception');
});

// The sandbox attribute is load-bearing in a different way: `allow-same-origin`
// would give widgets a real origin, and with it cookies, localStorage and the
// parent document. The skill lists all three as impossible.
test('widget frames are still sandboxed without allow-same-origin', () => {
  const host = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
  // Only real setAttribute calls count. The file also says "NO allow-same-origin"
  // in a comment, which is the opposite of a violation.
  const sandboxCalls = [...host.matchAll(/setAttribute\(\s*'sandbox'\s*,\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(sandboxCalls.length >= 2, 'expected the tile and service frame sandbox assignments');
  for (const value of sandboxCalls) {
    assert.equal(value, 'allow-scripts', `a widget iframe is sandboxed as "${value}"`);
  }
  assert.ok(
    DIRECTIVES.includes('sandbox allow-scripts'),
    'the served sandbox directive changed',
  );
});
