'use strict';
// The recording options by voice (set_recording_options): the same choices as
// Settings → Capture, written through the same updateCaptureSettings.
// "keep" leaves a choice as it is; no choice at all only reads them. The
// folder choice applies to recordings, screenshots, benchmark files, bug
// reports or the bug report's log folder (folderFor), each a folder of its own.
//
// deps (injected), under d.capture:
//   options()               the options in force (capture-settings.js shape)
//   setOptions(change, fs)  saves a change, and the folders in fs ({ folder,
//                           shotFolder, benchFolder }: a path or '' = default)
//   pickFolder(kind)        the folder dialog on the PC for 'recording',
//                           'screenshot' or 'benchmark': { ok, path } / { ok, cancelled }
const path = require('path');

// The AI's word for what is saved → the dialog's kind and the settings key.
const FOR = Object.freeze({
  recordings: { kind: 'recording', key: 'folder', fallback: 'Videos/Xenon (default)' },
  screenshots: { kind: 'screenshot', key: 'shotFolder', fallback: 'Pictures/Xenon (default)' },
  benchmarks: { kind: 'benchmark', key: 'benchFolder', fallback: 'Documents/Xenon/Benchmark (default)' },
  bugReports: { kind: 'bugreport', key: 'bugFolder', fallback: 'Documents/Xenon/Bug reports (default)' },
  bugLogs: { kind: 'buglogs', key: 'bugLogs', fallback: 'none (no logs are added)' },
});
// Only the folder's name reaches the AI, marked as the user's choice so it is
// never mistaken for the standard one.
const nameOf = (dir, fallback) => (dir ? `${path.basename(dir) || dir.slice(0, 3)} (chosen by the user)` : fallback);

const num = v => Number(v);

// The AI's words → a change to hubSettings.capture.
function changeOf(a) {
  const c = {};
  if (a.fps && a.fps !== 'keep') c.fps = num(a.fps);
  if (a.size && a.size !== 'keep') c.height = a.size === 'native' ? 0 : num(a.size);
  if (a.quality && a.quality !== 'keep') c.quality = a.quality;
  if (a.pill && a.pill !== 'keep') c.badge = a.pill === 'show';
  if (a.limit && a.limit !== 'keep') c.maxGB = a.limit === 'none' ? 0 : num(a.limit);
  return c;
}

// What the AI hears back: no path, only the folder's name.
function describe(o) {
  return {
    fps: o.fps,
    size: o.height ? o.height : 'native',
    quality: o.quality,
    pill: o.badge ? 'show' : 'hide',
    limitGB: o.maxGB ? o.maxGB : 'none',
    folder: nameOf(o.folder, FOR.recordings.fallback),
    screenshotFolder: nameOf(o.shotFolder, FOR.screenshots.fallback),
    benchmarkFolder: nameOf(o.benchFolder, FOR.benchmarks.fallback),
    bugReportFolder: nameOf(o.bugFolder, FOR.bugReports.fallback),
    bugLogFolder: nameOf(o.bugLogs, FOR.bugLogs.fallback),
  };
}

async function run(d, action) {
  const c = d && d.capture;
  if (!c || typeof c.options !== 'function' || typeof c.setOptions !== 'function') return { ok: false, error: 'unavailable' };
  const a = action || {};
  const change = changeOf(a);
  const target = FOR[a.folderFor] || FOR.recordings;
  let folder;
  if (a.folder === 'default') folder = '';
  if (a.folder === 'pick') {
    if (typeof c.pickFolder !== 'function') return { ok: false, error: 'unavailable' };
    const picked = await c.pickFolder(target.kind);
    if (!picked || !picked.ok) return { ok: false, error: (picked && picked.error) || 'failed' };
    if (picked.cancelled) {
      // The other choices still count; the folder stays as it was.
      const kept = Object.keys(change).length ? await c.setOptions(change) : c.options();
      return { ok: true, cancelled: true, ...describe(kept) };
    }
    folder = picked.path;
  }
  if (!Object.keys(change).length && folder === undefined) return { ok: true, ...describe(c.options()) };
  const saved = await c.setOptions(change, folder === undefined ? {} : { [target.key]: folder });
  return { ok: true, saved: true, ...describe(saved) };
}

module.exports = { run, changeOf, describe };
