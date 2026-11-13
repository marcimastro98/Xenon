// The reader behind the native splits (tools/restructure/native-*.mjs): how Rust, C#
// and Swift text is cut into tokens and items, and how `use` lines are read and written.
// A wrong reading here would cut an item in half, so each rule that decides where an
// item ends has its case.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileItems, bodyItems } from '../../tools/restructure/native-items.mjs';
import { langOf, lex } from '../../tools/restructure/native-lex.mjs';
import { boundName, deeperPath, useLeaves, writeUses } from '../../tools/restructure/native-use.mjs';
import { callsTrait, commonCfg, coversEverything, wordsOf } from '../../tools/restructure/native-wire.mjs';

const kinds = (text, lang) => lex(text, lang).filter((token) => token.kind !== 'space').map((token) => `${token.kind}:${text.slice(token.start, token.end)}`);
const keys = (text, lang) => fileItems(text, lang).items.map((item) => item.key);

test('a file is read by its language', () => {
  assert.equal(langOf('apps/native/src-tauri/src/lib.rs'), 'rust');
  assert.equal(langOf('helper/IndexHost.cs'), 'cs');
  assert.equal(langOf('helper-mac/Sources/xenon-helper/IndexHost.swift'), 'swift');
});

test('every character of a file belongs to exactly one token', () => {
  const text = 'fn a() { let s = "}"; } // done\n/* { */ struct B;\n';
  const tokens = lex(text, 'rust');
  assert.equal(tokens.map((token) => text.slice(token.start, token.end)).join(''), text);
});

test('a brace inside a Rust string, raw string, char or comment is not code', () => {
  assert.deepEqual(kinds('"a}b"', 'rust'), ['string:"a}b"']);
  assert.deepEqual(kinds('r#"a"}"#', 'rust'), ['string:r#"a"}"#']);
  assert.deepEqual(kinds("'}'", 'rust'), ["string:'}'"]);
  assert.deepEqual(kinds('/* a /* } */ b */', 'rust'), ['comment:/* a /* } */ b */']);
});

test("a Rust lifetime is not the start of a character", () => {
  const text = "fn f<'a>(x: &'a str) -> &'a str { x }\nfn g() {}\n";
  assert.deepEqual(keys(text, 'rust'), ['fn f', 'fn g']);
});

test('a C# verbatim or interpolated string keeps its braces to itself', () => {
  assert.deepEqual(kinds('@"a""}"', 'cs'), ['string:@"a""}"']);
  assert.equal(kinds('$"{x}}}"', 'cs').length, 1);
});

test('a Swift string with code inside is one token', () => {
  assert.equal(kinds('"a \\(b("}")) c"', 'swift').length, 1);
});

test('Rust items carry their comments, attributes and visibility', () => {
  const text = [
    '//! About the file.',
    '',
    'use std::io;',
    '',
    '/// Says hello.',
    '#[cfg(windows)]',
    'pub(crate) fn hello() {}',
    '',
    'struct Point { x: i32 }',
    'impl Point { fn new() -> Self { Point { x: 0 } } }',
    'impl Drop for Point { fn drop(&mut self) {} }',
    'static COUNT: u32 = 0;',
    'mod inner { fn deep() {} }',
    'mod other;',
    '',
  ].join('\n');
  const { items, header } = fileItems(text, 'rust');
  assert.equal(header, '//! About the file.\n');
  assert.deepEqual(items.map((item) => item.key), ['use std::io', 'fn hello', 'struct Point', 'impl Point', 'impl Drop for Point', 'static COUNT', 'mod inner', 'mod other']);
  const hello = items[1];
  assert.equal(hello.vis, 'pub(crate)');
  assert.deepEqual(hello.cfg, ['#[cfg(windows)]']);
  assert.equal(text.slice(hello.lead, hello.end), '\n/// Says hello.\n#[cfg(windows)]\npub(crate) fn hello() {}\n');
  // The items cover the file: nothing between them is lost.
  assert.equal(header + items.map((item) => text.slice(item.lead, item.end)).join(''), text);
});

test('the members of a Rust impl can be read one by one', () => {
  const text = 'impl A {\n    pub fn one(&self) {}\n    fn two() {}\n}\n';
  const { tokens, items } = fileItems(text, 'rust');
  assert.deepEqual(bodyItems(text, tokens, 'rust', items[0]).map((item) => `${item.vis}|${item.key}`), ['pub|fn one', '|fn two']);
});

test('C# members: fields, properties, methods and nested types', () => {
  const text = [
    'using System;',
    'namespace Demo;',
    'internal static class Host',
    '{',
    '    private const int Max = 3;',
    '    private static readonly object Gate = new();',
    '    private static int Count => 1;',
    '    private static string Name { get; set; } = "a";',
    '    [DllImport("x")]',
    '    private static extern int Native(int a);',
    '    public static void Run(string[] args)',
    '    {',
    '        if (args.Length > 0) { Console.WriteLine("}"); }',
    '    }',
    '    private sealed class Entry { public int Id; }',
    '}',
    '',
  ].join('\n');
  const { tokens, items } = fileItems(text, 'cs');
  assert.deepEqual(items.map((item) => item.key), ['using System', 'namespace Demo', 'type Host']);
  assert.deepEqual(bodyItems(text, tokens, 'cs', items[2]).map((item) => item.key), ['const Max', 'field Gate', 'property Count', 'property Name', 'method Native', 'method Run', 'type Entry']);
});

test('Swift declarations end at the line where the next one starts', () => {
  const text = [
    'import Foundation',
    '',
    'enum Host {',
    '    private static var held = false',
    '    static let lock = NSLock()',
    '    static func run(_ a: Int) -> Int {',
    '        let b = a',
    '            + 1',
    '        return b',
    '    }',
    '    private static func stop() {}',
    '}',
    '',
    'final class Box {',
    '    var value: Int = 0',
    '}',
    '',
  ].join('\n');
  const { tokens, items } = fileItems(text, 'swift');
  assert.deepEqual(items.map((item) => item.key), ['import Foundation', 'enum Host', 'class Box']);
  assert.deepEqual(bodyItems(text, tokens, 'swift', items[1]).map((item) => `${item.vis}|${item.key}`), ['private|var held', '|let lock', '|func run', 'private|func stop']);
});

test('a use line is read into the names it brings in', () => {
  const leaves = useLeaves('std::{io::{self, Read as R}, sync::Mutex, fmt::*}');
  assert.deepEqual(leaves.map((leaf) => `${leaf.path.join('::')}|${leaf.name}|${boundName(leaf)}`), ['std::io|self|io', 'std::io|Read|R', 'std::sync|Mutex|Mutex', 'std::fmt|*|*']);
});

test('use lines are written one per path, std first, this crate last', () => {
  const imports = [
    { cfg: [], vis: '', leaf: { path: ['super'], name: 'place' } },
    { cfg: [], vis: '', leaf: { path: ['tauri'], name: 'Manager' } },
    { cfg: ['#[cfg(windows)]'], vis: '', leaf: { path: ['std', 'io'], name: 'Write' } },
    { cfg: [], vis: '', leaf: { path: ['std', 'sync'], name: 'Mutex' } },
    { cfg: [], vis: '', leaf: { path: ['std', 'sync'], name: 'Arc' } },
    { cfg: [], vis: 'pub(crate)', leaf: { path: ['pick'], name: 'Pick' } },
  ];
  assert.equal(writeUses(imports), [
    '#[cfg(windows)]', 'use std::io::Write;', 'use std::sync::{Arc, Mutex};', 'pub(crate) use pick::Pick;', 'use tauri::Manager;', 'use super::place;', '',
  ].join('\n'));
});

test('the compact form nests one crate in one statement and wraps between modules', () => {
  const names = Array.from({ length: 30 }, (_, n) => `a_rather_long_name_${n}`);
  const text = writeUses(names.map((name) => ({ cfg: [], vis: '', leaf: { path: ['super', `module_${name}`], name } })).concat([{ cfg: [], vis: '', leaf: { path: ['super'], name: 'top' } }]), true);
  assert.match(text, /^use super::\{\n/);
  assert.ok(text.split('\n').every((line) => line.length <= 100));
  assert.deepEqual(useLeaves(text.replace(/^use /, '').replace(/;\n$/, '')).map((leaf) => leaf.name).sort(), [...names, 'top'].sort());
});

test('a path written in the parent is rewritten for a module one level down', () => {
  const local = new Set(['pick']);
  assert.deepEqual(deeperPath(['self', 'pick', 'Pick'], local, ['super']), ['super', 'pick', 'Pick']);
  assert.deepEqual(deeperPath(['super', 'prefs'], local, ['super']), ['super', 'super', 'prefs']);
  assert.deepEqual(deeperPath(['super', 'prefs'], local, ['crate']), ['super', 'prefs']);
  assert.deepEqual(deeperPath(['pick', 'Pick'], local, ['super']), ['super', 'pick', 'Pick']);
  assert.deepEqual(deeperPath(['std', 'io'], local, ['super']), ['std', 'io']);
});

test('the words of an item tell a name it uses from one it declares', () => {
  const text = 'fn f(rect: Rect) -> bool { let found = pick(rect.left) || LIMIT > 0; found && other::go() && shown }\n';
  const { tokens, items } = fileItems(text, 'rust');
  const words = wordsOf(text, tokens, items[0]);
  for (const name of ['Rect', 'pick', 'LIMIT', 'other', 'shown']) assert.ok(words.used.has(name), name);
  for (const name of ['rect', 'found']) assert.ok(!words.used.has(name), name);
  assert.ok(words.dotted.has('left'));
  assert.ok(words.pathed.has('go'));
});

test('`a || B` is an "or", not a closure that declares B', () => {
  const text = 'fn f() -> bool { ready() || DRIVER.load() }\n';
  const { tokens, items } = fileItems(text, 'rust');
  assert.ok(wordsOf(text, tokens, items[0]).used.has('DRIVER'));
});

test('a trait is needed where one of its methods is called, and unknown traits say so', () => {
  const text = 'fn f(app: &App) { app.get_webview_window("main"); }\n';
  const { tokens, items } = fileItems(text, 'rust');
  const words = wordsOf(text, tokens, items[0]);
  assert.equal(callsTrait('Manager', words), true);
  assert.equal(callsTrait('Emitter', words), false);
  assert.equal(callsTrait('SomeTraitNobodyListed', words), null);
  assert.equal(callsTrait('SomeTraitNobodyListed', words, { SomeTraitNobodyListed: ['get_webview_window'] }), true);
});

test('cfg lines: what all share, and two halves that make a whole', () => {
  assert.deepEqual(commonCfg([['#[cfg(windows)]', '#[cfg(test)]'], ['#[cfg(windows)]']]), ['#[cfg(windows)]']);
  assert.deepEqual(commonCfg([['#[cfg(windows)]'], []]), []);
  assert.equal(coversEverything([['#[cfg(windows)]'], ['#[cfg(not(windows))]']]), true);
  assert.equal(coversEverything([['#[cfg(windows)]'], ['#[cfg(target_os = "linux")]']]), false);
});

test('code under a cfg that is false on Windows is named as unseen by this PC', async () => {
  const { seenOnWindows, unseenOnWindows } = await import('../../tools/restructure/native-cfg.mjs');
  for (const seen of ['windows', 'desktop', 'test', 'not(test)', 'all(test, windows)', 'any(windows, target_os = "macos")', 'not(target_os = "macos")', 'feature = "x"']) assert.equal(seenOnWindows(seen), true, seen);
  for (const unseen of ['unix', 'target_os = "linux"', 'not(windows)', 'all(test, target_os = "linux")', 'not(any(windows, target_os = "macos"))', 'not(debug_assertions)', 'mobile']) assert.equal(seenOnWindows(unseen), false, unseen);
  const text = '#[cfg(windows)]\nfn a() {}\nfn b() {\n    #[cfg(target_os = "macos")]\n    mac();\n    #[cfg(not(windows))]\n    other();\n    if cfg!(target_os = "linux") {}\n}\n';
  assert.deepEqual(unseenOnWindows(text), ['target_os = "macos"', 'not(windows)']);
});
