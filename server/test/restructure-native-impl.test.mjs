// Moving some methods of one big Rust `impl` block (tools/restructure/native-split-impl.mjs):
// the new file opens the same block again, and the proof compares the methods one by one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareGroups } from '../../tools/restructure/native-proof.mjs';
import { splitRust } from '../../tools/restructure/native-split-rust.mjs';

const WITH_IMPL = [
  'use std::path::Path;',
  '',
  'struct Backend {',
  '    frames: u32,',
  '    busy: bool,',
  '}',
  '',
  '#[cfg(windows)]',
  'impl Backend {',
  '    fn new() -> Self {',
  '        Backend { frames: 0, busy: false }',
  '    }',
  '',
  '    /// Saves the frames that are waiting.',
  '    fn save(&mut self, to: &Path) -> bool {',
  '        self.busy = to.exists();',
  '        self.count() > 0',
  '    }',
  '',
  '    fn count(&self) -> u32 {',
  '        self.frames',
  '    }',
  '}',
  '',
  'pub fn run() -> bool {',
  '    Backend::new().save(Path::new("."))',
  '}',
  '',
].join('\n');

const implPlan = { origin: 'src/win.rs', parts: [{ file: 'src/win/save.rs', about: 'Saves what was captured.', members: [{ impl: 'Backend', items: ['fn save'] }] }] };

test('some methods of a big impl block move, and the new file opens the same block again', () => {
  const { files } = splitRust({ origin: implPlan.origin, text: WITH_IMPL, plan: implPlan, otherWords: new Set() });
  const save = files['src/win/save.rs'];
  // The block keeps its own attribute, the method its comment and its text.
  assert.match(save, /^#\[cfg\(windows\)\]\nimpl Backend \{\n {4}\/\/\/ Saves the frames that are waiting\.\n {4}pub\(super\) fn save\(&mut self, to: &Path\) -> bool \{$/m);
  assert.match(save, /^use std::path::Path;$/m);
  assert.match(save, /^use super::Backend;$/m);
  assert.match(save, /\n {4}\}\n\}\n$/);
  const parent = files['src/win.rs'];
  assert.match(parent, /^#\[cfg\(windows\)\]\nmod save;$/m);
  assert.doesNotMatch(parent, /fn save/);
  // What stays is untouched: the parent's own methods and fields are in reach of its child as they are.
  assert.match(parent, /^ {4}fn new\(\) -> Self \{$/m);
  assert.match(parent, /^ {4}fn count\(&self\) -> u32 \{$/m);
  assert.match(parent, /^ {4}busy: bool,$/m);
  const verdict = compareGroups({ 'src/win.rs': WITH_IMPL }, files);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.items, 5);
  assert.equal(verdict.wider, 1);
});

test('the proof refuses a method that moved to another type, and a plan whose members do not exist', () => {
  const { files } = splitRust({ origin: implPlan.origin, text: WITH_IMPL, plan: implPlan, otherWords: new Set() });
  const other = { ...files, 'src/win/save.rs': files['src/win/save.rs'].replace('impl Backend {', 'impl Other {') };
  assert.match(compareGroups({ 'src/win.rs': WITH_IMPL }, other).problems.join('\n'), /"Other fn save" is not an item the files had before/);
  const none = { origin: 'src/win.rs', parts: [{ file: 'src/win/save.rs', about: 'x', members: [{ impl: 'Backend', items: ['fn missing'] }] }] };
  assert.throws(() => splitRust({ origin: none.origin, text: WITH_IMPL, plan: none, otherWords: new Set() }), /no impl block has the members/);
});
