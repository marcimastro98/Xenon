// The native splitter and its proof (tools/restructure/native-*.mjs): a file is cut
// by moving whole items, each new file imports what its items name, and the proof
// refuses anything that is not the same items with the same text.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareGroups, sameItem } from '../../tools/restructure/native-proof.mjs';
import { recordSplit } from '../../tools/restructure/native-split.mjs';
import { splitMembers } from '../../tools/restructure/native-split-members.mjs';
import { splitRust } from '../../tools/restructure/native-split-rust.mjs';

const RUST = [
  '//! Where the window goes.',
  '',
  'use std::sync::Mutex;',
  'use tauri::Manager;',
  '',
  'use crate::prefs;',
  '',
  '/// The last place the window had.',
  'static LAST: Mutex<Option<Rect>> = Mutex::new(None);',
  '',
  'struct Rect {',
  '    left: i32,',
  '    top: i32,',
  '}',
  '',
  'impl Rect {',
  '    fn origin() -> Self {',
  '        Rect { left: 0, top: 0 }',
  '    }',
  '}',
  '',
  '// Reads the saved place, or the corner.',
  'pub(crate) fn place(app: &tauri::AppHandle) -> i32 {',
  '    let rect = pick(app);',
  '    *LAST.lock().unwrap() = None;',
  '    rect.left + prefs::offset()',
  '}',
  '',
  'fn pick(app: &tauri::AppHandle) -> Rect {',
  '    let _ = app.get_webview_window("main");',
  '    Rect::origin()',
  '}',
  '',
  '#[cfg(target_os = "linux")]',
  'fn only_linux() -> Mutex<i32> {',
  '    Mutex::new(1)',
  '}',
  '',
].join('\n');

const rustPlan = {
  origin: 'src/monitor.rs',
  parts: [
    { file: 'src/monitor/pick.rs', about: 'Which rectangle the window gets.', items: ['fn pick', 'struct Rect', 'impl Rect'] },
    { file: 'src/monitor/linux.rs', about: 'What only Linux needs.', items: ['fn only_linux'] },
  ],
};

function cutRust(plan = rustPlan, otherWords = new Set(['place'])) {
  return splitRust({ origin: plan.origin, text: RUST, plan, otherWords });
}

test('a Rust file is cut into a parent and child modules', () => {
  const { files } = cutRust();
  assert.deepEqual(Object.keys(files).sort(), ['src/monitor.rs', 'src/monitor/linux.rs', 'src/monitor/pick.rs']);
  const parent = files['src/monitor.rs'];
  assert.match(parent, /^\/\/! Where the window goes\.\n/);
  assert.match(parent, /^mod pick;$/m);
  // A file whose items all stand under one cfg is a module under that cfg.
  assert.match(parent, /^#\[cfg\(target_os = "linux"\)\]\nmod linux;$/m);
  assert.match(parent, /^use pick::\{pick, Rect\};$/m);
  // The parent keeps what it still uses and loses the import only the moved code needed.
  assert.match(parent, /^use std::sync::Mutex;$/m);
  assert.doesNotMatch(parent, /use tauri::Manager;/);
  assert.match(parent, /^pub\(crate\) fn place\(/m);
});

test('a new file imports exactly what its items name, and says what it is for', () => {
  const pick = cutRust().files['src/monitor/pick.rs'];
  assert.match(pick, /^\/\/ Which rectangle the window gets\.\n\nuse tauri::Manager;\n\n/);
  assert.doesNotMatch(pick, /Mutex|prefs/);
  const linux = cutRust().files['src/monitor/linux.rs'];
  assert.match(linux, /^use std::sync::Mutex;$/m);
  // The whole file is Linux-only through its `mod` line, so the item's own cfg is not repeated on the import.
  assert.equal(linux.match(/cfg\(target_os/g).length, 1);
});

test('what another file of the split uses gets pub(super), and nothing else does', () => {
  const pick = cutRust().files['src/monitor/pick.rs'];
  assert.match(pick, /^pub\(super\) fn pick\(/m);
  assert.match(pick, /^pub\(super\) struct Rect \{$/m);
  assert.match(pick, /^ {4}pub\(super\) left: i32,$/m);
  assert.match(pick, /^ {4}top: i32,$/m);
  assert.match(pick, /^ {4}fn origin\(\) -> Self \{$/m);
});

test('a name another module of the crate reaches for is handed on by the parent', () => {
  const plan = { origin: 'src/monitor.rs', parts: [{ file: 'src/monitor/place.rs', about: 'Puts the window.', items: ['fn place', 'static LAST'] }] };
  const { files } = cutRust(plan);
  assert.match(files['src/monitor.rs'], /^pub\(crate\) use place::place;$/m);
  assert.match(files['src/monitor/place.rs'], /^use super::\{pick, Rect\};$/m);
  assert.match(files['src/monitor/place.rs'], /^use crate::prefs;$/m);
});

test('the parts of a crate root are named from the crate, and widen to the crate', () => {
  const plan = { origin: 'src/lib.rs', parts: [{ file: 'src/pick.rs', about: 'Which rectangle.', items: ['fn pick'] }] };
  const { files } = splitRust({ origin: plan.origin, text: RUST, plan, otherWords: new Set() });
  assert.match(files['src/pick.rs'], /^pub\(crate\) fn pick\(/m);
  assert.match(files['src/pick.rs'], /^use crate::Rect;$/m);
});

test('a plan that names nothing, a wrong folder or an item twice is refused', () => {
  const part = (extra) => ({ origin: 'src/monitor.rs', parts: [{ file: 'src/monitor/a.rs', about: 'x', ...extra }] });
  assert.throws(() => cutRust(part({ items: ['fn missing'] })), /no item is called/);
  assert.throws(() => cutRust(part({ lines: [[900, 950]] })), /Nothing goes to/);
  assert.throws(() => cutRust({ origin: 'src/monitor.rs', parts: [{ file: 'src/elsewhere/a.rs', about: 'x', items: ['fn pick'] }] }), /must sit in/);
  const twice = { origin: 'src/monitor.rs', parts: [{ file: 'src/monitor/a.rs', about: 'x', items: ['fn pick'] }, { file: 'src/monitor/b.rs', about: 'y', items: ['fn pick'] }] };
  assert.throws(() => cutRust(twice), /claimed by two parts/);
});

test('the proof finds every item of a real split again', () => {
  const { files } = cutRust();
  const verdict = compareGroups({ 'src/monitor.rs': RUST }, files);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.items, 6);
  assert.equal(verdict.wider, 3);
});

test('the proof refuses a changed body, a narrower visibility, a lost item and a lost comment', () => {
  const { files } = cutRust();
  const changed = (file, from, to) => ({ ...files, [file]: files[file].replace(from, to) });
  const problems = (after) => compareGroups({ 'src/monitor.rs': RUST }, after).problems.join('\n');
  assert.match(problems(changed('src/monitor/pick.rs', 'left: 0', 'left: 1')), /"Rect fn origin" is not an item the files had before/);
  assert.match(problems(changed('src/monitor.rs', 'pub(crate) fn place', 'fn place')), /"fn place" lost visibility/);
  assert.match(problems(changed('src/monitor/linux.rs', /#\[cfg[^\n]*\nfn only_linux[^]*$/, '')), /"fn only_linux" is gone/);
  assert.match(problems(changed('src/monitor.rs', '// Reads the saved place, or the corner.\n', '')), /fn place|a comment is gone/);
});

test('two versions of an item are the same only when visibility alone differs, and only wider', () => {
  assert.deepEqual(sameItem('fn a() {}\n', 'pub(super) fn a() {}\n', 'rust'), { same: true, wider: 1 });
  assert.equal(sameItem('pub(crate) fn a() {}\n', 'pub(super) fn a() {}\n', 'rust').same, false);
  assert.equal(sameItem('fn a() {}\n', 'pub(super) fn a() { }\n', 'rust').same, false);
  assert.deepEqual(sameItem('private func a() {}\n', 'func a() {}\n', 'swift'), { same: true, wider: 1 });
  assert.equal(sameItem('func a() {}\n', 'private func a() {}\n', 'swift').same, false);
});

const CS = [
  '// Indexes files.',
  'using System;',
  '',
  'namespace Demo;',
  '',
  'internal static class Host',
  '{',
  '    private static readonly object Gate = new();',
  '',
  '    // Starts the host.',
  '    public static void Run()',
  '    {',
  '        Walk();',
  '    }',
  '',
  '    private static void Walk()',
  '    {',
  '        lock (Gate) { Console.WriteLine("}"); }',
  '    }',
  '',
  '    private sealed class Entry { public int Id; }',
  '}',
  '',
  'internal enum Kind { File, Dir }',
  '',
].join('\n');

test('C# members move to another file of the same partial class', () => {
  const plan = { origin: 'helper/Host.cs', parts: [{ file: 'helper/Host.Walk.cs', about: 'Walks the disk.', type: 'Host', items: ['method Walk', 'type Entry'] }, { file: 'helper/Kind.cs', about: 'What an entry is.', types: ['Kind'] }] };
  const { files } = splitMembers({ origin: plan.origin, text: CS, plan, lang: 'cs' });
  assert.match(files['helper/Host.cs'], /^internal static partial class Host$/m);
  assert.doesNotMatch(files['helper/Host.cs'], /void Walk|class Entry|enum Kind|\n\n$/);
  assert.match(files['helper/Host.Walk.cs'], /^\/\/ Walks the disk\.\n\nusing System;\n\nnamespace Demo;\n\ninternal static partial class Host\n\{\n {4}private static void Walk\(\)/);
  assert.match(files['helper/Host.Walk.cs'], /class Entry \{ public int Id; \}\n\}\n$/);
  assert.match(files['helper/Kind.cs'], /namespace Demo;\n\ninternal enum Kind \{ File, Dir \}\n$/);
  assert.deepEqual(compareGroups({ 'helper/Host.cs': CS }, files).problems, []);
});

test('a C# field with a starting value stays where its order is kept', () => {
  const plan = { origin: 'helper/Host.cs', parts: [{ file: 'helper/Host.State.cs', about: 'x', type: 'Host', items: ['field Gate'] }] };
  assert.throws(() => splitMembers({ origin: plan.origin, text: CS, plan, lang: 'cs' }), /field with a starting value/);
});

const SWIFT = [
  'import Foundation',
  '',
  'enum Host {',
  '    private static var held = false',
  '    private static let quiet = 3',
  '',
  '    static func run() {',
  '        if held { wait() }',
  '    }',
  '',
  '    // Waits for the hold to end.',
  '    private static func wait() {',
  '        _ = quiet',
  '    }',
  '}',
  '',
].join('\n');

test('Swift members move to an extension, and what the other file uses loses private', () => {
  const plan = { origin: 'Sources/Host.swift', parts: [{ file: 'Sources/Host+Wait.swift', about: 'Waiting.', type: 'Host', items: ['func wait'] }] };
  const { files, notes } = splitMembers({ origin: plan.origin, text: SWIFT, plan, lang: 'swift' });
  assert.match(files['Sources/Host+Wait.swift'], /^\/\/ Waiting\.\n\nimport Foundation\n\nextension Host \{\n {4}\/\/ Waits for the hold to end\.\n {4}static func wait\(\) \{/);
  assert.match(files['Sources/Host.swift'], /^ {4}static let quiet = 3$/m);
  assert.match(files['Sources/Host.swift'], /^ {4}private static var held = false$/m);
  assert.equal(notes.length, 2);
  assert.deepEqual(compareGroups({ 'Sources/Host.swift': SWIFT }, files).problems, []);
});

test('the list of splits keeps a part that is split again under its first file', () => {
  let ledger = recordSplit({}, 'src/lib.rs', ['src/b.rs', 'src/a.rs']);
  assert.deepEqual(ledger, { 'src/lib.rs': ['src/a.rs', 'src/b.rs'] });
  ledger = recordSplit(ledger, 'src/a.rs', ['src/a/x.rs']);
  assert.deepEqual(ledger, { 'src/lib.rs': ['src/a.rs', 'src/a/x.rs', 'src/b.rs'] });
});

const WITH_MACRO = [
  'use std::cell::RefCell;',
  '',
  'thread_local! {',
  '    static STATE: RefCell<i32> = const { RefCell::new(0) };',
  '}',
  '',
  'fn read() -> i32 {',
  '    STATE.with(|state| *state.borrow())',
  '}',
  '',
  'pub fn show() -> i32 {',
  '    read()',
  '}',
  '',
].join('\n');

test('a static declared inside a macro stays in the parent, and a part reaches it from there', () => {
  const plan = { origin: 'src/win.rs', parts: [{ file: 'src/win/read.rs', about: 'Reads the state.', items: ['fn read'] }] };
  const { files } = splitRust({ origin: plan.origin, text: WITH_MACRO, plan, otherWords: new Set() });
  assert.match(files['src/win/read.rs'], /^use super::STATE;$/m);
  assert.match(files['src/win.rs'], /^thread_local! \{\n {4}static STATE: /m);
  const moved = { origin: 'src/win.rs', parts: [{ file: 'src/win/state.rs', about: 'The state.', items: ['call thread_local'] }] };
  assert.throws(() => splitRust({ origin: moved.origin, text: WITH_MACRO, plan: moved, otherWords: new Set() }), /declared inside a macro/);
});
