// Moving some methods of one big Rust `impl` block (tools/restructure/native-split-impl.mjs):
// the new file opens the same block again, and the proof compares the methods one by one.
// And the tests that read a split file as text: they must go through the reader that follows the split.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { lex } from '../../tools/restructure/native-lex.mjs';
import { compareGroups } from '../../tools/restructure/native-proof.mjs';
import { splitRust } from '../../tools/restructure/native-split-rust.mjs';
import { namesFile, retargetNativeTests, toNativeReader } from '../../tools/restructure/native-test-readers.mjs';
import { reachedThrough } from '../../tools/restructure/native-wire.mjs';
import { nativeSplits } from './native-source.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

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

test('no test reads a split native file past the reader that follows the split', () => {
  const left = Object.keys(nativeSplits()).flatMap((file) => {
    const { changed, byHand } = retargetNativeTests(REPO, file, false);
    return [...changed, ...byHand].map((name) => `${name} reads ${file}`);
  });
  assert.deepEqual(left, []);
});

test('a test is pointed at the native reader by changing only where readFileSync comes from', () => {
  const plain = "import { readFileSync } from 'node:fs';\nconst rust = readFileSync('apps/native/src-tauri/src/monitor.rs', 'utf8');\n";
  assert.equal(toNativeReader(plain), plain.replace("'node:fs'", "'./native-source.mjs'"));
  assert.equal(toNativeReader(toNativeReader(plain)), toNativeReader(plain));
  const browser = "import { readFileSync } from './browser-source.mjs';\nreadFileSync('x/monitor.rs');\n";
  assert.match(toNativeReader(browser), /^import \{ readFileSync \} from '\.\/native-source\.mjs'; \/\/ .*\.\/browser-source\.mjs\n/);
  // A test that only names the file reads nothing, and one that reads it another way is for a person.
  assert.equal(toNativeReader("const name = 'monitor.rs';\n"), "const name = 'monitor.rs';\n");
  assert.equal(toNativeReader("import { readFile } from 'node:fs/promises';\nawait readFile('monitor.rs');\n"), null);
  assert.equal(namesFile("read('layers/mod.rs')", 'apps/native/src-tauri/src/layers/mod.rs'), true);
  assert.equal(namesFile("read('replay/mod.rs')", 'apps/native/src-tauri/src/layers/mod.rs'), false);
  assert.equal(namesFile("read(NATIVE + 'lib.rs')", 'apps/native/src-tauri/src/lib.rs'), false);
  assert.equal(namesFile("read('apps/native/src-tauri/src/lib.rs')", 'apps/native/src-tauri/src/lib.rs'), true);
});

test('a moved item that says super::name still finds it: the parent imports the name', () => {
  const text = ['fn show() -> bool {', '    !super::menu_aside()', '}', '', '#[cfg(test)]', 'mod tests {', '    use super::*;', '}', ''].join('\n');
  const plan = { origin: 'src/layers/win32.rs', parts: [{ file: 'src/layers/win32/sync.rs', about: 'Shows the layers.', items: ['fn show'] }] };
  const { files } = splitRust({ origin: plan.origin, text, plan, otherWords: new Set() });
  assert.match(files['src/layers/win32.rs'], /^use super::menu_aside;$/m);
  assert.match(files['src/layers/win32/sync.rs'], /^ {4}!super::menu_aside\(\)$/m);
  const own = text.replace('#[cfg(test)]', 'fn menu_aside() -> bool { true }\n\n#[cfg(test)]');
  assert.throws(() => splitRust({ origin: plan.origin, text: own, plan, otherWords: new Set() }), /has a menu_aside of its own/);
});

test('a private item another module reaches as crate::NAME is still found in the parent', () => {
  const text = ['const TASK: &str = "task";', '', 'fn start() -> &\'static str {', '    TASK', '}', '', 'fn other() {}', ''].join('\n');
  const plan = { origin: 'src/lib.rs', parts: [{ file: 'src/task.rs', about: 'The task.', items: ['const TASK', 'fn start', 'fn other'] }] };
  const other = 'use crate::{start, TASK};\nfn f() { crate::other(); super::far(); }\n';
  const reached = reachedThrough(other, lex(other, 'rust'), new Set(['crate']));
  assert.deepEqual([...reached].sort(), ['TASK', 'other', 'start']);
  const { files } = splitRust({ origin: plan.origin, text, plan, otherWords: new Set(), reached: new Set(['TASK', 'start']) });
  assert.match(files['src/lib.rs'], /^use task::\{start, TASK\};$/m);
  assert.match(files['src/task.rs'], /^pub\(crate\) const TASK: /m);
  assert.match(files['src/task.rs'], /^pub\(crate\) fn start\(/m);
  assert.match(files['src/task.rs'], /^fn other\(/m);
});

test('a function written once per system and a constant inside a format string are still imported', () => {
  const text = ['const SHIM: &str = "x";', '', '#[cfg(windows)]', 'fn nudge() {}', '', '#[cfg(target_os = "macos")]', 'fn nudge() {}', '', 'fn run() -> String {', '    nudge();', '    format!("{SHIM}\\n")', '}', ''].join('\n');
  const plan = { origin: 'src/lib.rs', parts: [{ file: 'src/nudge_windows.rs', about: 'The nudge on Windows.', lines: [[1, 4]] }] };
  const { files } = splitRust({ origin: plan.origin, text, plan, otherWords: new Set() });
  assert.match(files['src/lib.rs'], /^#\[cfg\(windows\)\]\nuse nudge_windows::nudge;$/m);
  assert.match(files['src/lib.rs'], /^use nudge_windows::SHIM;$/m);
  assert.match(files['src/nudge_windows.rs'], /^pub\(crate\) const SHIM: /m);
  // The file with the Windows one does not import the macOS one: nothing in it calls that.
  assert.doesNotMatch(files['src/nudge_windows.rs'], /macos/);
});
