// Issue #142: a Deck key with a keyboard shortcut (a TeamSpeak soundboard hotkey)
// pressed while CS2 ran full screen took the focus away from the game and gave
// it to a random app. deck-hotkey.ps1 always skipped the window in front, on
// the assumption that it was the dashboard the user had just tapped. With
// "Keep games focused" the touch does not take the foreground, and a key
// pressed on a paired phone takes nothing either: the window in front was the
// game itself, and the script focused whatever lay beneath it.
//
// macOS and Linux never had the problem: the helper's `keys` mode and
// xdotool/ydotool send to whatever is frontmost and move nothing.
//
// The script is PowerShell with inline C#, which no test here can run, so the
// rules are asserted on the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PS = readFileSync(new URL('../deck-hotkey.ps1', import.meta.url), 'utf8');

function method(name) {
  const at = PS.indexOf(name + '(');
  assert.ok(at > 0, name + ' exists');
  const open = PS.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < PS.length; i++) {
    if (PS[i] === '{') depth++;
    else if (PS[i] === '}' && --depth === 0) return PS.slice(at, i + 1);
  }
  return PS.slice(at);
}

test('the window in front is the target unless it is Xenon itself', () => {
  const body = method('public static IntPtr FindTarget');
  const first = body.indexOf('if (Eligible(fg) && !IsDashboard(ProcessOf(fg), Title(fg))) return fg;');
  assert.ok(first > 0, 'the foreground is checked first');
  assert.ok(first < body.indexOf('GW_HWNDNEXT'), 'before walking to the window beneath it');
});

test('Xenon is recognised on every surface a key can be tapped on', () => {
  const body = method('public static bool IsDashboard');
  assert.match(body, /p == "xenon-native"/, 'the Xenon app');
  assert.match(body, /p == "icue"/, 'the iCUE panel');
  assert.match(body, /t == "Xenon"/, 'a browser tab titled after the page');
  for (const sep of ['-', '\\\\u2013', '\\\\u2014']) {
    assert.match(body, new RegExp(`StartsWith\\("Xenon ${sep} "\\)`), `browser title with "${sep}"`);
  }
});

test('the desktop and the taskbar are never a target', () => {
  // After Win+D the desktop is in front; sending a game's shortcut to it, or
  // to the taskbar, would be a silent miss.
  const body = method('public static bool IsShell');
  for (const cls of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']) {
    assert.ok(body.includes(`"${cls}"`), cls);
  }
  assert.match(method('static bool Eligible'), /return !IsShell\(ClassOf\(h\)\);/);
});

test('a window already in front is not asked to come forward again', () => {
  const body = method('public static bool Focus');
  const early = body.indexOf('if (GetForegroundWindow() == target) return true;');
  assert.ok(early > 0, 'no focus dance for the window that has it');
  assert.ok(early < body.indexOf('ShowWindow(target, SW_RESTORE)'), 'and no restore either');
});

test('the type-text mode and the dry run use the same rule', () => {
  // Both call FindTarget; a second copy of the old walk would bring the bug back.
  assert.equal((PS.match(/GW_HWNDNEXT\)/g) || []).length, 1, 'one z-order walk in the whole script');
  assert.match(PS, /\$ttTarget = \[XenonHotkey\]::FindTarget\(\)/);
  assert.match(PS, /\$tgt = \[XenonHotkey\]::FindTarget\(\)/);
});

test('the C# block declares what the new rule calls', () => {
  assert.match(PS, /public static extern int GetClassName\(IntPtr h, System\.Text\.StringBuilder s, int max\);/);
  assert.match(PS, /System\.Diagnostics\.Process\.GetProcessById\(\(int\)pid\)\.ProcessName/);
});
