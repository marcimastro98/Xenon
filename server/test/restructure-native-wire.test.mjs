// What the native splitter reads in code no machine here compiles (tools/restructure/native-wire.mjs,
// native-split-rust.mjs): two readings that left a part without an import it needs. A file for
// macOS or Linux is only compiled by CI, so each is held here by a test instead.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitRust } from '../../tools/restructure/native-split-rust.mjs';
import { wordsOf } from '../../tools/restructure/native-wire.mjs';
import { lex } from '../../tools/restructure/native-lex.mjs';

const words = (text) => wordsOf(text, lex(text, 'rust'), { start: 0, end: text.length });

test('what a raw pointer points at is a name the item uses, not one it declares', () => {
  const read = words('fn open(name: *const c_char, out: *mut *mut c_void) -> *mut handle { let mut count = 0; count }');
  for (const name of ['c_char', 'c_void', 'handle']) {
    assert.ok(read.used.has(name), `${name} is used`);
    assert.ok(!read.bound.has(name), `${name} is not declared here`);
  }
  // `let mut` still declares.
  assert.ok(read.bound.has('count'));
  assert.ok(!read.used.has('count'));
});

const POINTERS = [
  'use std::ffi::{c_char, c_void};',
  '',
  'type Display = c_void;',
  '',
  'struct Api {',
  '    free: unsafe extern "C" fn(*mut c_void) -> i32,',
  '    name: unsafe extern "C" fn(*mut Display) -> *const c_char,',
  '}',
  '',
  'pub fn display() -> *mut Display {',
  '    std::ptr::null_mut()',
  '}',
  '',
].join('\n');

test('a part that only points at a type imports it, though the parent names the same type too', () => {
  const plan = { origin: 'src/x11.rs', parts: [{ file: 'src/x11/api.rs', about: 'The calls.', items: ['struct Api'] }] };
  const { files } = splitRust({ origin: plan.origin, text: POINTERS, plan, otherWords: new Set(['display']) });
  assert.match(files['src/x11/api.rs'], /^use std::ffi::\{c_char, c_void\};$/m);
  assert.match(files['src/x11/api.rs'], /^use super::Display;$/m);
  // The parent keeps what it still names and lets go of what only the part points at.
  assert.match(files['src/x11.rs'], /^use std::ffi::c_void;$/m);
});

const NAMED_TRAIT = [
  'use objc2::{define_class, MainThreadMarker, MainThreadOnly};',
  'use objc2_app_kit::NSView;',
  '',
  'define_class!(',
  '    #[thread_kind = MainThreadOnly]',
  '    struct Watchdog;',
  ');',
  '',
  'fn view(mtm: MainThreadMarker) -> usize {',
  '    let made = NSView::alloc(mtm);',
  '    made.len()',
  '}',
  '',
  'fn count(mtm: MainThreadMarker) -> usize {',
  '    let _ = mtm;',
  '    0',
  '}',
  '',
  'pub fn both(mtm: MainThreadMarker) -> usize {',
  '    view(mtm) + count(mtm)',
  '}',
  '',
].join('\n');

test('a listed trait the parent names in a macro is still imported by the part that calls its methods', () => {
  const plan = { origin: 'src/glow.rs', parts: [
    { file: 'src/glow/window.rs', about: 'Makes the view.', items: ['fn view'] },
    { file: 'src/glow/count.rs', about: 'Counts.', items: ['fn count'] },
  ] };
  const { files } = splitRust({ origin: plan.origin, text: NAMED_TRAIT, plan, otherWords: new Set() });
  assert.match(files['src/glow/window.rs'], /^use objc2::\{MainThreadMarker, MainThreadOnly\};$/m);
  // A part that calls none of its methods does not import it.
  assert.doesNotMatch(files['src/glow/count.rs'], /MainThreadOnly/);
  assert.match(files['src/glow.rs'], /MainThreadOnly\};$/m, 'the parent still names it');
});
