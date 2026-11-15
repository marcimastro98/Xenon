'use strict';
// The operating system's colour scheme, for the dashboard's "Auto" appearance.
//
// The obvious source is the WebView's own `prefers-color-scheme`, and it is the
// wrong one: it is unreliable in exactly the moments that matter. On Windows the
// embedded WebView could report light on a dark desktop; on macOS it reports
// light for a moment after the display wakes, which fired the media-query
// listener and repainted the whole dashboard white — and nothing afterwards
// disagreed, because nothing else on that platform knew any better. Reported on
// Discord from a Mac mini (Sep 2026): dark before the screen slept, white after
// it woke, every time.
//
// So the OS is asked directly, with its own tool, and that reading is what Auto
// resolves against. The answer is a TRI-STATE and the third value is the whole
// point: `null` means "no reading here", and the dashboard falls back to the
// media query. Answering an unknown with `false` would be the same bug wearing a
// different hat — a dashboard painted light because nobody could say otherwise.
const { execFile } = require('child_process');

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

// AppsUseLightTheme: 0x0 = dark apps, 0x1 = light apps.
function decodeWindows(err, stdout) {
  if (err || !stdout) return null;
  const m = String(stdout).match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
  return m ? parseInt(m[1], 16) === 0 : null;
}

// AppleInterfaceStyle holds "Dark" while the Mac is dark. In light mode the key
// does not exist at all, so `defaults` exits non-zero with nothing to print —
// and that silence IS the light answer, not a failed read. The two are told
// apart by whether `defaults` could be run at all: a spawn failure or a timeout
// is an unknown, a clean non-zero exit is light.
function decodeDarwin(err, stdout) {
  if (err && (err.code === 'ENOENT' || err.killed === true || err.signal)) return null;
  return /\bdark\b/i.test(String(stdout == null ? '' : stdout));
}

// GNOME's schema, and the desktops that copy it. `prefer-dark` is the only value
// that means dark; `default` means the desktop states no preference, which is
// not the same as light — so it reads as no answer and the media query decides.
function decodeLinux(err, stdout) {
  if (err) return null;
  const v = String(stdout == null ? '' : stdout).trim().replace(/^'|'$/g, '');
  if (/prefer-dark/i.test(v)) return true;
  if (/prefer-light/i.test(v)) return false;
  return null;
}

const PROBES = Object.freeze({
  win32:  { cmd: 'reg',       args: ['query', WIN_KEY, '/v', 'AppsUseLightTheme'],            decode: decodeWindows },
  darwin: { cmd: 'defaults',  args: ['read', '-g', 'AppleInterfaceStyle'],                    decode: decodeDarwin },
  linux:  { cmd: 'gsettings', args: ['get', 'org.gnome.desktop.interface', 'color-scheme'],   decode: decodeLinux },
});

/** Resolves { osDark: true | false | null }. Never rejects: a platform with no
 *  probe, a missing tool and a hung one all mean the same thing to the caller. */
function read(platform = process.platform, run = execFile) {
  const probe = Object.hasOwn(PROBES, platform) ? PROBES[platform] : null;
  if (!probe) return Promise.resolve({ osDark: null });
  return new Promise((resolve) => {
    let settled = false;
    const done = (osDark) => {
      if (settled) return;
      settled = true;
      resolve({ osDark: typeof osDark === 'boolean' ? osDark : null });
    };
    try {
      run(probe.cmd, probe.args, { windowsHide: true, timeout: 4000 },
        (err, stdout) => { try { done(probe.decode(err, stdout)); } catch { done(null); } });
    } catch { done(null); }
  });
}

module.exports = { read, decodeWindows, decodeDarwin, decodeLinux, PROBES };
