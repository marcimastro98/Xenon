// Starts the program that plays a WAV file on this operating system, without needing a window
// in focus.

const { spawn } = require('node:child_process');
const { psQuote } = require('../ps-quote.js');

// Spawn a blocking, focus-independent WAV player for the current platform.
// Windows: SoundPlayer.PlaySync() through PowerShell. Elsewhere: afplay on
// macOS (built in), aplay on Linux. The Windows one-liner also deletes the file
// on a clean exit; the others leave that to the caller, which unlinks anyway.
function _spawnWavPlayer(wavPath) {
  if (process.platform === 'darwin') {
    return spawn('/usr/bin/afplay', [wavPath]);
  }
  if (process.platform === 'linux') {
    return spawn('aplay', ['-q', wavPath]);
  }
  // The path is the user's temp folder, which can hold an apostrophe or a
  // typographic quote (C:\Users\D'Amico, D’Amico): quoted by psQuote().
  const ps = `(New-Object System.Media.SoundPlayer -ArgumentList ${psQuote(wavPath)}).PlaySync();` +
             `try { Remove-Item -LiteralPath ${psQuote(wavPath)} -Force -EA SilentlyContinue } catch {}`;
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
}

module.exports = { _spawnWavPlayer };
