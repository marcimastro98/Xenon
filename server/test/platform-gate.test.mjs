// Which Rust files `npm run check:platform-apis` may leave unread (tools/platform-gate.mjs). The
// check itself needs the cargo registry; the rule is text in, verdict out, and is held here.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// A split file comes back with its parts after it: the gate at its head reads the same.
import { readFileSync } from './native-source.mjs';

import { insideGatedFn, oneSystemOnly, parentFiles, stripComments, wholeFileSystem } from '../../tools/platform-gate.mjs';

const file = (/** @type {string[]} */ ...lines) => lines.join('\n');

test('only the plain gate naming one system gates a whole file', () => {
  assert.equal(wholeFileSystem(file('//! What this is.', '#![cfg(target_os = "linux")]', '', 'use std::ffi::c_int;')), 'linux');
  assert.equal(wholeFileSystem(file('#![allow(dead_code)]', '#![cfg( target_os = "macos" )]', 'fn a() {}')), 'macos');
  assert.equal(wholeFileSystem(file('/* a block', ' comment */', '#![cfg(target_os = "windows")]\r', 'fn a() {}')), 'windows');
});

test('several systems, a negation, a condition on something else and cfg_attr never count', () => {
  for (const gate of [
    '#![cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]',
    '#![cfg(any(target_os = "linux"))]',
    '#![cfg(not(target_os = "macos"))]',
    '#![cfg(all(target_os = "linux", feature = "x11"))]',
    '#![cfg_attr(target_os = "linux", allow(dead_code))]',
    '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]',
    '#![cfg(windows)]',
    '#![cfg(target_os = "linux")] // and more',
    '#![cfg(target_os = "linux")] #![cfg(target_os = "macos")]',
    '#![cfg(target_family = "unix")]',
  ]) {
    const verdict = wholeFileSystem(file('//! Doc.', gate, 'fn a() {}'));
    // A trailing comment is not code: that one line is the plain gate again.
    assert.equal(verdict, gate.endsWith('// and more') ? 'linux' : '', gate);
  }
});

test('a gate counts only before the first item, and not when it is written in a comment', () => {
  assert.equal(wholeFileSystem(file('use std::ffi::c_int;', '#![cfg(target_os = "linux")]')), '');
  assert.equal(wholeFileSystem(file('// #![cfg(target_os = "linux")]', 'fn a() {}')), '');
  assert.equal(wholeFileSystem(file('#[cfg(target_os = "linux")]', 'fn a() {}')), '', 'an outer attribute gates one item');
  assert.equal(wholeFileSystem(file('#![cfg(any(', '    target_os = "linux",', '))]', 'fn a() {}')), '');
  assert.equal(wholeFileSystem(''), '');
});

test('a file cut out of a gated one is gated with it, and a mod.rs gates nothing', () => {
  assert.deepEqual(parentFiles('layers/anchor_x11/xlib.rs'), ['layers/anchor_x11.rs', 'layers.rs']);
  assert.deepEqual(parentFiles('lib.rs'), []);
  const tree = new Map([
    ['layers/mod.rs', '#![cfg(target_os = "linux")]\nmod anchor_x11;'],
    ['layers/anchor_x11.rs', '//! X11.\n#![cfg(target_os = "linux")]\nmod xlib;'],
    ['layers/anchor_x11/xlib.rs', 'pub(super) struct Api { transient_for: usize }'],
    ['layers/pad.rs', '#![cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]\nmod read;'],
    ['layers/pad/read.rs', 'fn read() {}'],
    ['layers/spec.rs', 'pub struct Spec;'],
  ]);
  const read = (/** @type {string} */ name) => tree.get(name) ?? null;
  assert.equal(oneSystemOnly('layers/anchor_x11.rs', read), true);
  assert.equal(oneSystemOnly('layers/anchor_x11/xlib.rs', read), true);
  assert.equal(oneSystemOnly('layers/pad.rs', read), false);
  assert.equal(oneSystemOnly('layers/pad/read.rs', read), false, 'under a file gated to several systems');
  // layers/mod.rs is gated here, and still the files of its folder are read.
  assert.equal(oneSystemOnly('layers/spec.rs', read), false);
  assert.equal(oneSystemOnly('layers/mod.rs', read), true, 'the file itself says so');
});

test('a call inside a function gated at the left margin is handled, anything after it is not', () => {
  const lines = stripComments(file(
    '#[cfg(target_os = "macos")]',                                      // 0
    'fn native_handle(win: &Window) -> Option<isize> {',                // 1
    '    Some(win.ns_window().ok()? as isize)',                         // 2
    '}',                                                                // 3
    '',                                                                 // 4
    'fn other(win: &Window) -> Option<isize> {',                        // 5
    '    Some(win.ns_window().ok()? as isize)',                         // 6
    '}',                                                                // 7
    '#[cfg(windows)]',                                                  // 8
    'pub(super) unsafe fn third(win: &Window) {',                       // 9
    '    win.hwnd();',                                                  // 10
    '}',                                                                // 11
    '#[cfg(target_os = "linux")]',                                      // 12
    'fn short() -> u8 { 1 }',                                           // 13
    'const AFTER: usize = gtk_window();',                               // 14
    'impl Thing {',                                                     // 15
    '    #[cfg(target_os = "linux")]',                                  // 16
    '    fn inner(&self) {',                                            // 17
    '        self.gtk_window();',                                       // 18
    '    }',                                                            // 19
    '}',                                                                // 20
  )).split('\n');
  assert.equal(insideGatedFn(lines, 2), true);
  assert.equal(insideGatedFn(lines, 1), true);
  assert.equal(insideGatedFn(lines, 4), false, 'after the closing brace');
  assert.equal(insideGatedFn(lines, 6), false, 'a function with no gate');
  assert.equal(insideGatedFn(lines, 10), false, 'cfg(windows) does not name target_os: left to the check');
  assert.equal(insideGatedFn(lines, 14), false, 'after a function written on one line');
  assert.equal(insideGatedFn(lines, 18), false, 'a method is not at the margin: left to the check');
});

test('on the real app: the two files gated to all three systems are read, the one-system files are not', () => {
  const at = (/** @type {string} */ name) => { try { return readFileSync(new URL(`../../apps/native/src-tauri/src/${name}`, import.meta.url), 'utf8'); } catch { return null; } };
  for (const read of ['layers/desks.rs', 'layers/pad.rs', 'layers/mod.rs', 'main.rs', 'lib.rs']) assert.equal(oneSystemOnly(read, at), false, read);
  for (const skipped of ['layers/desks_x11.rs', 'layers/pad_macos.rs', 'layers/win32.rs', 'layers/anchor_x11/xlib.rs', 'layers/ffi/ask.rs', 'layers/glow_macos/image.rs', 'webview_guard.rs']) {
    assert.equal(oneSystemOnly(skipped, at), true, skipped);
  }
  // The check takes the rule from here and holds no rule of its own.
  const check = readFileSync(new URL('../../tools/check-platform-apis.mjs', import.meta.url), 'utf8');
  assert.match(check, /import \{ insideGatedFn, oneSystemOnly, stripComments \} from '\.\/platform-gate\.mjs';/);
  assert.doesNotMatch(check, /function (gatedAsAWhole|underAGatedFile|stripComments)\(/);
});
