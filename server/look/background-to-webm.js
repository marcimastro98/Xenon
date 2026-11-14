// Turns an MP4 background into a WebM the dashboard plays.

const fs = require('node:fs');
const { BACKGROUND_TRANSCODE_TIMEOUT_MS } = require('../http/upload-limits.js');
const { execFilePromise } = require('../programs/exec-file-promise.js');
const { getFfmpegPath } = require('../ffmpeg-install/ffmpeg-path.js');

async function transcodeMp4BackgroundToWebm(sourcePath, targetPath) {
  const ffmpeg = getFfmpegPath();
  await execFilePromise(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-vf', 'fps=30,scale=1920:-2',
    '-an',
    '-c:v', 'libvpx',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-b:v', '6M',
    '-maxrate', '8M',
    '-bufsize', '12M',
    '-auto-alt-ref', '0',
    targetPath,
  ], { timeout: BACKGROUND_TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Converted WebM is empty');
  return stat;
}

module.exports = { transcodeMp4BackgroundToWebm };
