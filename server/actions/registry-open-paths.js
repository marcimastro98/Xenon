'use strict';
// Which files an action refuses to open because opening them runs code, and which scripts the
// runScript action may start, per system. Part of the action registry: only registry.js
// requires this file.

const fs = require('node:fs');

// Executable / script extensions that must NOT be reachable via openFile (which
// opens with the registered handler). A folder or a document is fine; a .bat or
// .ps1 would run code on one tap. openApp is the only path that may launch exes.
// Plus the types that run code the moment they open without being a program
// on their face: management consoles (.msc, abused as "GrimResource"),
// compiled help (.chm), Python and Office add-ins, ClickOnce and App Installer
// manifests, Windows Script Components, PowerShell data and console files,
// settings shortcuts, troubleshooter packs, Remote Desktop files, themes,
// cabinets and disk images (which mount and show their own contents).
// Also: Windows Sandbox configs (.wsb — its LogonCommand runs on open),
// standalone update packages (.msu), every macro-enabled Office type (the
// "-m" formats, .xlsb, legacy .xla/.xlm add-ins), the remaining Python
// launchers (.pyzw/.pyo), the Monad/PowerShell 2 console and session files,
// Access projects/databases that carry AutoExec macros, shell scraps (.shb/
// .shs/.xnk), and the rest of the Outlook "Level 1" blocked list that a click
// can launch. MS Access table shortcuts (.mad…/.maw) are left out on purpose:
// .mat is MATLAB data far more often than an Access shortcut.
const BLOCKED_OPEN_EXT = /\.(exe|lnk|bat|cmd|com|ps1|psm1|psd1|ps1xml|psc1|vbs|vbe|js|jse|wsf|wsh|ws|wsc|sct|hta|scr|pif|reg|msi|msp|mst|cpl|jar|gadget|inf|appref-ms|jnlp|url|website|scf|library-ms|search-ms|desktop|msc|chm|py|pyw|pyz|pyc|xll|xlam|ppam|application|appinstaller|msix|msixbundle|appx|appxbundle|xbap|settingcontent-ms|diagcab|rdp|theme|themepack|cab|iso|img|vhd|vhdx|one|msh|mht|mhtml|wsb|msu|docm|dotm|xlsm|xltm|xlsb|xla|xlm|pptm|potm|ppsm|sldm|pyzw|pyo|msh1|msh2|mshxml|msh1xml|msh2xml|ps2|ps2xml|psc2|pssc|cdxml|ade|adp|mde|accde|mda|shb|shs|xnk|vb|vbp|ins|isp|its|hlp|vsmacros|vsw|printerexport|webpnp)$/i;

// The same rule, restated for the platforms where `open`/`xdg-open` is the
// handler. The list above is a Windows vocabulary: none of those extensions
// means anything to LaunchServices, which instead runs a .command in Terminal,
// launches an .app or an .appex, executes a .workflow, and hands a .py to the
// Python Launcher — exactly the one-tap code execution the blocklist exists to
// stop. It is kept separate rather than merged so the Windows boundary stays
// byte-for-byte what it was; a name like .sh or .py is a document there and has
// been openable since the feature shipped.
const BLOCKED_OPEN_EXT_POSIX = /\.(command|app|appex|workflow|terminal|action|definition|osax|prefpane|qlgenerator|saver|mdimporter|plugin|bundle|kext|pkg|mpkg|dmg|webloc|fileloc|inetloc|scpt|scptd|applescript|shortcut|sh|bash|zsh|csh|ksh|fish|py|pyw|rb|pl|php|lua|tcl|awk|run|appimage|tool|term)$/i;

// The name the extension test looks at. Trailing separators are dropped first:
// `/x/Evil.app/` names the same bundle as `/x/Evil.app` and `open` launches it,
// but the trailing slash used to hide the extension from the regex. Trailing
// dots/spaces and an NTFS `::$DATA` stream suffix go too, because Windows
// resolves `run.bat.` and `run.bat::$DATA` to run.bat.
function _openGateName(p) {
  let v = String(p == null ? '' : p).trim();
  for (let prev = null; prev !== v;) {
    prev = v;
    v = v.replace(/[\\/]+$/, '').replace(/::\$DATA$/i, '').replace(/[.\s]+$/, '');
  }
  return v;
}

// Extensions that open in a viewer or an editor by their name alone.
const DOCUMENT_EXT = /\.(pdf|txt|md|rtf|csv|tsv|log|docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|key|epub|jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif|mp3|wav|flac|m4a|aac|ogg|opus|mp4|m4v|mov|mkv|avi|webm|zip|7z|rar|tar|gz)$/i;

// Real filesystem lookups, used only when the gate is asked about the platform
// it is actually running on (so tests that pass another platform stay pure).
function _realStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// `statPath(path)` → a fs.Stats-like object or null. Optional: when omitted it
// defaults to the real fs.statSync, but only for the host platform — the
// extension lists stay a pure function of the name everywhere.
function isBlockedOpenPath(p, platform, statPath) {
  const v = _openGateName(p);
  if (BLOCKED_OPEN_EXT.test(v)) return true;
  const plat = platform || process.platform;
  if (plat === 'win32') return false;
  if (BLOCKED_OPEN_EXT_POSIX.test(v)) return true;
  // What the name cannot tell us. `open` (macOS) picks the app by extension,
  // so a file with a known document extension opens in that app even with an
  // execute bit; a file with no extension, or one the system does not know,
  // is a Unix executable to it and runs in Terminal (xdg-open can do the
  // same). So an executable file is refused unless its extension is a known
  // document type: a PDF on a FAT/exFAT stick, where every file shows as
  // executable, still opens.
  const stat = typeof statPath === 'function' ? statPath
    : (plat === process.platform ? _realStat : null);
  // Stat the path as given (only trailing slashes dropped): the dot/space
  // trimming above is a Windows naming rule and would name another file here.
  const real = String(p == null ? '' : p).trim().replace(/\/+$/, '');
  if (!stat || !real) return false;
  const st = stat(real);
  if (!st) return false;
  if (typeof st.isFile === 'function' && st.isFile() && (st.mode & 0o111) && !DOCUMENT_EXT.test(real)) return true;
  // A directory that is shaped like an application bundle is launched by
  // LaunchServices even without a bundle extension (the "package" Finder bit),
  // so on macOS refuse any directory carrying Contents/Info.plist.
  if (plat === 'darwin' && typeof st.isDirectory === 'function' && st.isDirectory()) {
    if (stat(real + '/Contents/Info.plist')) return true;
  }
  return false;
}

// The 'runScript' action is the ONE deliberate, user-configured path that may
// launch a batch/PowerShell script (openFile blocks these on purpose — it opens
// with the registered handler, where a .ps1 would land in Notepad and a .bat
// would run on a single tap of anything the user double-clicks). It's no more
// privileged than openApp, which already launches arbitrary executables — the
// user picks the exact script in the editor. The path is validated to a real
// script here; execution goes through deck-actions.ps1's 'runscript' verb, which
// dispatches each type to its interpreter (Windows scripts run directly;
// .ps1 → powershell -File; .py/.js/.rb/.pl/.php/.lua/.r → their interpreter;
// .jar → java -jar; .vbs/.vbe/.wsf → cscript; .sh/.bash → bash). By default it
// runs in a VISIBLE window (an installer or interactive script needs its
// console); the key can opt into a hidden window. The interpreter must be on
// PATH — a missing one degrades to a clean {ok:false} (the key flashes red).
const RUNNABLE_SCRIPT_EXT = /\.(bat|cmd|ps1|py|pyw|js|cjs|mjs|rb|pl|php|lua|r|jar|vbs|vbe|wsf|sh|bash)$/i;

// The same list where the interpreters are POSIX ones (server.js's
// POSIX_SCRIPT_RUNNERS is the other half). It has to be its own list in both
// directions: .bat/.ps1/.vbs mean nothing here and are better refused at this
// boundary than spawned and left to fail, while .command/.zsh are real script
// types the Windows list has no reason to carry.
const RUNNABLE_SCRIPT_EXT_POSIX = /\.(sh|bash|zsh|command|py|pyw|js|cjs|mjs|rb|pl|php|lua|r|jar)$/i;

// AppleScript is macOS-only: `.scpt`/`.applescript` run through osascript,
// which is only in POSIX_SCRIPT_RUNNERS on darwin. Accepting them on Linux
// would be a key that validates here and then fails at run time with "no
// interpreter" — the exact gate/runner drift the CLAUDE.md invariant forbids,
// which is why this is a SEPARATE, platform-gated regex rather than two more
// alternatives in the list above.
const RUNNABLE_SCRIPT_EXT_DARWIN = /\.(scpt|applescript)$/i;

function isRunnableScriptPath(p, platform) {
  const v = String(p == null ? '' : p).trim();
  const plat = platform || process.platform;
  if (plat === 'win32') return RUNNABLE_SCRIPT_EXT.test(v);
  if (RUNNABLE_SCRIPT_EXT_POSIX.test(v)) return true;
  return plat === 'darwin' && RUNNABLE_SCRIPT_EXT_DARWIN.test(v);
}

module.exports = {
  BLOCKED_OPEN_EXT, BLOCKED_OPEN_EXT_POSIX, _openGateName, DOCUMENT_EXT, _realStat,
  isBlockedOpenPath, RUNNABLE_SCRIPT_EXT, RUNNABLE_SCRIPT_EXT_POSIX, RUNNABLE_SCRIPT_EXT_DARWIN,
  isRunnableScriptPath,
};
