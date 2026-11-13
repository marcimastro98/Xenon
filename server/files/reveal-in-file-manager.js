// Shows a file in the file manager of this operating system, selected where the system can do
// that.

const { spawn } = require('node:child_process');
const path = require('node:path');

// "Show me where this is" — the one path an executable result may take, because
// revealing something runs nothing. Companion to openExternalPath, and shared
// for the same reason: each platform's file manager has its own verb, and
// `explorer /select,` is a Windows spelling rather than a portable one. Linux
// has no universal equivalent, so the honest fallback is opening the containing
// FOLDER — it answers the same question without pretending to a selection
// nobody can make. Argv array everywhere; the path is one argument.
function revealInFileManager(p, dir) {
  const target = String(p);
  const folder = dir || path.dirname(target);
  // explorer.exe does NOT parse its command line with CommandLineToArgvW: it
  // wants the quotes around the PATH, not around the whole `/select,` token.
  // Node quotes any argument containing a space, so `'/select,' + target`
  // reached it as "/select,C:\Users\...\My Projects\..." — which explorer
  // gives up on and answers by opening the DEFAULT folder (Documents), with no
  // error anywhere. That is not the edge case: almost every real path has a
  // space in it, so "show in folder" opened an unrelated window for most users,
  // in Spotlight and in the transfer widget alike. windowsVerbatimArguments
  // hands the line over unquoted so the quotes can go where explorer expects.
  // It is NOT a shell (no cmd.exe, so &, | and > stay inert) — but since Node
  // is no longer escaping, refuse the one character that could re-cut the
  // arguments. A double quote is illegal in a Windows path, so this can only
  // ever fire on something that was never a real file.
  if (process.platform === 'win32' && target.includes('"')) {
    console.warn('[reveal] refusing a path containing a quote');
    return;
  }
  const child = process.platform === 'win32'
    ? spawn('explorer.exe', ['/select,"' + target + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
    : process.platform === 'darwin'
      ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' });
  // A missing file manager raises an ASYNC 'error' on the child, which the
  // caller's try/catch cannot see — unhandled, it takes the whole server down.
  // That is not hypothetical: xdg-utils is genuinely absent on minimal Linux
  // installs, and POST /api/transfer/reveal is reachable from a paired phone,
  // so one tap could end the backend. Revealing is best-effort by nature.
  child.on('error', (e) => console.warn('[reveal] no file manager:', e && e.message));
  child.unref();
}

module.exports = { revealInFileManager };
