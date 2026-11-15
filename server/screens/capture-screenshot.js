// Takes one picture of a screen with ffmpeg.

const fs = require('node:fs');
const { privateTmpFile } = require('../files/private-tmp.js');
const { execFilePromise } = require('../programs/exec-file-promise.js');
const { _capShrinkToWidth } = require('./shrink-to-width.js');
const { getFfmpegPath } = require('../ffmpeg-install/ffmpeg-path.js');

// Capture a screenshot; `monitor` is an optional {x,y,width,height} region.
// Returns base64 JPEG.
//
// `opts.maxWidth` caps the output width (the AI vision path wants a small
// payload; the share card wants the panel near native — an Edge capture loses a
// quarter of its width at the 1920 default). `opts.quality` is ffmpeg -q:v,
// lower is better. Both default to the historic values, so callers that pass no
// opts produce a byte-identical command line.
async function captureScreenshot(monitor, opts) {
  const maxWidth = Math.min(3840, Math.max(640, Math.trunc(Number(opts && opts.maxWidth)) || 1920));
  const quality = String(Math.min(31, Math.max(1, Math.trunc(Number(opts && opts.quality)) || 3)));
  const tmpPath = privateTmpFile('xenon_ss_', '.jpg');
  try {
    if (process.platform === 'darwin') {
      // screencapture is built in and needs no ffmpeg: -x silences the shutter,
      // -t jpg matches what the callers expect. It captures the main display;
      // -R takes a region in global screen coordinates, which is exactly the
      // rectangle the monitor picker already hands us.
      const args = ['-x', '-t', 'jpg'];
      if (monitor && monitor.width > 0 && monitor.height > 0) {
        args.push('-R', `${monitor.x},${monitor.y},${monitor.width},${monitor.height}`);
      }
      args.push(tmpPath);
      // Without the Screen Recording grant macOS writes a desktop-picture-only
      // image rather than failing, so there is nothing to detect here — the
      // grant is a first-run prompt the user answers once.
      await execFilePromise('/usr/sbin/screencapture', args, { timeout: 15000 });
      await _capShrinkToWidth(tmpPath, maxWidth);
      const shot = await fs.promises.readFile(tmpPath);
      return shot.toString('base64');
    }
    const ffmpeg = getFfmpegPath();
    const ffmpegArgs = ['-y'];
    if (process.platform === 'linux') {
      // x11grab addresses a screen as DISPLAY plus an optional +x,y origin, and
      // takes the whole screen when no size is given. There is deliberately no
      // Wayland path: capturing there goes through the xdg-desktop-portal
      // screencast API, which is a permission dialog and a PipeWire stream, not
      // an ffmpeg input — so under Wayland this fails and says so, rather than
      // silently returning someone's idea of a screen.
      const display = process.env.DISPLAY || ':0.0';
      ffmpegArgs.push('-f', 'x11grab', '-framerate', '1');
      if (monitor && monitor.width > 0 && monitor.height > 0) {
        ffmpegArgs.push('-video_size', `${monitor.width}x${monitor.height}`);
        ffmpegArgs.push('-i', `${display}+${monitor.x || 0},${monitor.y || 0}`);
      } else {
        ffmpegArgs.push('-i', display);
      }
    } else {
      ffmpegArgs.push('-f', 'gdigrab', '-framerate', '1');
      if (monitor && monitor.width > 0 && monitor.height > 0) {
        ffmpegArgs.push('-offset_x', String(monitor.x), '-offset_y', String(monitor.y), '-video_size', `${monitor.width}x${monitor.height}`);
      }
      ffmpegArgs.push('-i', 'desktop');
    }
    ffmpegArgs.push('-vframes', '1', '-q:v', quality, '-vf', `scale='min(${maxWidth},iw)':-2`, tmpPath);
    await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
    const imgBuffer = await fs.promises.readFile(tmpPath);
    return imgBuffer.toString('base64');
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { captureScreenshot };
