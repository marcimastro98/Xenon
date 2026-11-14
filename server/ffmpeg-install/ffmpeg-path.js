// Where ffmpeg is on this computer: the copy next to the engine, the one a package manager
// installed, or the one on the PATH.

const fs = require('node:fs');
const path = require('node:path');
const { findFirstFile } = require('./lookup.js');
const SERVER_DIR = path.join(__dirname, '..');

function getFfmpegPath() {
  if (process.env.XEH_FFMPEG) return process.env.XEH_FFMPEG;
  if (process.platform !== 'win32') {
    // Homebrew's two prefixes (Apple Silicon, then Intel) before falling back
    // to PATH — a LaunchAgent starts with a minimal PATH that often lacks both.
    const unixCandidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    const found = unixCandidates.find(candidate => fs.existsSync(candidate));
    return found || 'ffmpeg';
  }
  const localCandidates = [
    path.join(SERVER_DIR, 'ffmpeg.exe'),
    path.join(SERVER_DIR, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ];
  const local = localCandidates.find(candidate => fs.existsSync(candidate));
  if (local) return local;

  if (process.env.LOCALAPPDATA) {
    const wingetPackages = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const wingetFfmpeg = findFirstFile(wingetPackages, 'ffmpeg.exe', 5);
    if (wingetFfmpeg) return wingetFfmpeg;
  }

  return 'ffmpeg.exe';
}

module.exports = { getFfmpegPath };
