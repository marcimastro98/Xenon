// macOS gives the first click on a window of an app in the background to the app, which only
// comes forward: on the dashboard a permission card then needed two clicks (#159). Every
// window a person clicks while working in another app must take that first click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './native-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the dashboard window takes the first click on macOS', () => {
  const src = read('../../apps/native/src-tauri/src/startup/main_window.rs');
  const built = src.slice(src.indexOf('WebviewWindowBuilder::new(app, "main"'), src.indexOf('.center();'));
  assert.match(built, /\.accept_first_mouse\(true\)/);
});

test('the widget windows on the desktop take it too', () => {
  assert.match(read('../../apps/native/src-tauri/src/layers/window.rs'), /\.accept_first_mouse\(true\)/);
});
