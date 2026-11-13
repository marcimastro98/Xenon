// Makes a screenshot narrower in place when it is wider than asked, on macOS.

const { execFilePromise } = require('../programs/exec-file-promise.js');

// Cap a capture's width in place, the way the ffmpeg filter
// (scale='min(maxWidth,iw)') does elsewhere. screencapture writes the display's
// BACKING resolution, so a Retina panel produces a 5K JPEG where the same call
// on Windows produces a 1920-wide one — several megabytes of base64 on every AI
// vision request. sips ships with macOS, and reading the width first keeps it
// from doing the one thing `min()` never does: enlarge a smaller capture.
async function _capShrinkToWidth(file, maxWidth) {
  try {
    const { stdout } = await execFilePromise('/usr/bin/sips', ['-g', 'pixelWidth', file], { timeout: 8000 });
    const m = String(stdout || '').match(/pixelWidth:\s*(\d+)/);
    if (!m || Number(m[1]) <= maxWidth) return;
    await execFilePromise('/usr/bin/sips', ['--resampleWidth', String(maxWidth), file], { timeout: 15000 });
  } catch {
    // A capture at full resolution is still a usable capture — never fail the
    // screenshot over the size of it.
  }
}

module.exports = { _capShrinkToWidth };
