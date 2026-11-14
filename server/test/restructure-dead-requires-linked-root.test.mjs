// The tree the dead-require check reads (tools/restructure, dead-requires-disk.mjs) names every
// file from the root it was given, also when that root is reached through a link. On macOS the
// temp folder is a link, so a path measured from the unresolved root climbed out of the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diskTree } from '../../tools/restructure/dead-requires-disk.mjs';

test('a file under a root reached through a link keeps its name from the root', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'xenon-linked-root-'));
  try {
    const real = join(base, 'real');
    const linked = join(base, 'linked');
    mkdirSync(join(real, 'server', 'part'), { recursive: true });
    writeFileSync(join(real, 'server', 'part', 'lib.js'), "'use strict';\n");
    // A junction on Windows needs no special right; elsewhere the kind is ignored.
    try { symlinkSync(real, linked, 'junction'); } catch { return t.skip('this machine cannot make a link'); }

    assert.equal(diskTree(linked).real('server/part/lib.js'), 'server/part/lib.js');
    assert.equal(diskTree(real).real('server/part/lib.js'), 'server/part/lib.js');
    assert.equal(diskTree(linked).real('server/part/missing.js'), 'server/part/missing.js', 'a file that is not there keeps the name it was asked by');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
