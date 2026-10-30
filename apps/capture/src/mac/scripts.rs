//! The few AppKit and Vision calls the engine needs, as JavaScript for
//! Automation run by /usr/bin/osascript (run::jxa). This keeps the engine free
//! of linked frameworks: every call here is Apple's own, signed binary asking
//! the system, with the permissions the user granted Xenon. Each script's
//! `run(argv)` returns one line of JSON (or a word), never the user's data
//! beyond what the request asked for.

/// The displays, top-left origin in points like CoreGraphics, the main one first.
/// `index` is the order screencapture's `-D` counts in (main = 1, minus one).
pub const MONITORS: &str = r#"
ObjC.import('AppKit');
function run() {
  const all = $.NSScreen.screens;
  if (!all.count) return '[]';
  const mainH = all.objectAtIndex(0).frame.size.height;
  const out = [];
  for (let i = 0; i < all.count; i++) {
    const s = all.objectAtIndex(i);
    const f = s.frame;
    let name = '';
    try { name = ObjC.unwrap(s.localizedName) || ''; } catch (e) { name = ''; }
    out.push({
      index: i, name: name, primary: i === 0,
      x: Math.round(f.origin.x), y: Math.round(mainH - f.origin.y - f.size.height),
      width: Math.round(f.size.width), height: Math.round(f.size.height),
      scale: s.backingScaleFactor,
      display: ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber')) || 0,
    });
  }
  return JSON.stringify(out);
}
"#;

/// The app in front and its first normal window: `{ exe, id, x, y, width, height }`
/// (`id` 0 when it has none on screen). The window list needs no permission
/// for ids and bounds; names are not read.
pub const FRONT_WINDOW: &str = r#"
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app || app.isNil()) return JSON.stringify({ exe: '', id: 0 });
  const pid = app.processIdentifier;
  let exe = '';
  try { exe = ObjC.unwrap(app.executableURL.lastPathComponent) || ''; } catch (e) { exe = ''; }
  // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0))) || [];
  const w = list.find((x) => x.kCGWindowOwnerPID === pid && x.kCGWindowLayer === 0
    && x.kCGWindowBounds && x.kCGWindowBounds.Width > 1 && x.kCGWindowBounds.Height > 1);
  if (!w) return JSON.stringify({ exe: exe, id: 0 });
  const b = w.kCGWindowBounds;
  return JSON.stringify({ exe: exe, id: w.kCGWindowNumber, x: b.X, y: b.Y, width: b.Width, height: b.Height });
}
"#;

/// Text on a saved picture, read by Vision: `{ lines: [text, ...] }` in reading
/// order, or `{ error }`. argv[0] is the picture.
pub const OCR: &str = r#"
ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0; // accurate
  req.usesLanguageCorrection = true;
  // macOS 13 and later read the language from the picture; older ones read English.
  try { req.automaticallyDetectsLanguage = true; } catch (e) { /* older macOS */ }
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  if (!handler.performRequestsError($([req]), null)) return JSON.stringify({ error: 'ocr_failed' });
  const found = req.results;
  const rows = [];
  for (let i = 0; i < found.count; i++) {
    const o = found.objectAtIndex(i);
    const best = o.topCandidates(1);
    if (!best.count) continue;
    const b = o.boundingBox;
    rows.push({ t: ObjC.unwrap(best.objectAtIndex(0).string), top: 1 - b.origin.y - b.size.height, left: b.origin.x });
  }
  // Top to bottom, then left to right on the same row.
  rows.sort((a, b) => (Math.abs(a.top - b.top) < 0.01 ? a.left - b.left : a.top - b.top));
  return JSON.stringify({ lines: rows.map((r) => r.t) });
}
"#;

/// Saved files onto the clipboard as Finder copies them; argv = their paths.
pub const COPY_FILES: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  const urls = argv.map((p) => $.NSURL.fileURLWithPath(p));
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  return pb.writeObjects($(urls)) ? 'ok' : 'fail';
}
"#;

/// A saved picture onto the clipboard as an image; argv[0] is the picture.
pub const COPY_IMAGE: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  const img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (!img || img.isNil()) return 'fail';
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  return pb.writeObjects($([img])) ? 'ok' : 'fail';
}
"#;

/// The system's folder dialog: argv = [prompt, start folder]. Answers the
/// POSIX path, or the word `cancelled` / `failed`.
pub const PICK_FOLDER: &str = r#"
function run(argv) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.activate();
  const ask = (opts) => app.chooseFolder(opts).toString();
  const opts = { withPrompt: argv[0] || '' };
  try {
    if (argv[1]) {
      try { return ask(Object.assign({ defaultLocation: Path(argv[1]) }, opts)); } catch (e) {
        if (e.errorNumber === -128) return 'cancelled';
        // A start folder that is gone: the dialog opens where the system likes.
      }
    }
    return ask(opts);
  } catch (e) {
    return e.errorNumber === -128 ? 'cancelled' : 'failed';
  }
}
"#;

/// The words on a saved picture with their boxes, read by Vision for covers:
/// `{ lines: [[{ t, x, y, w, h }, ...], ...] }`, boxes in parts of the
/// picture from its top-left corner, or `{ error }`. argv[0] is the picture.
/// What it reads goes back to the engine only (cover.rs keeps rectangles).
pub const OCR_WORDS: &str = r#"
ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0; // accurate
  // Numbers, IBANs and addresses as written, not "corrected" into words.
  req.usesLanguageCorrection = false;
  try { req.automaticallyDetectsLanguage = true; } catch (e) { /* older macOS */ }
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  if (!handler.performRequestsError($([req]), null)) return JSON.stringify({ error: 'ocr_failed' });
  const found = req.results;
  const lines = [];
  for (let i = 0; i < found.count; i++) {
    const best = found.objectAtIndex(i).topCandidates(1);
    if (!best.count) continue;
    const cand = best.objectAtIndex(0);
    const text = ObjC.unwrap(cand.string) || '';
    const words = [];
    for (const m of text.matchAll(/\S+/g)) {
      const box = cand.boundingBoxForRangeError({ location: m.index, length: m[0].length }, null);
      if (!box || box.isNil()) continue;
      const b = box.boundingBox;
      words.push({ t: m[0], x: b.origin.x, y: 1 - b.origin.y - b.size.height, w: b.size.width, h: b.size.height });
    }
    if (words.length) lines.push(words);
  }
  // Top to bottom, then left to right on the same row.
  lines.sort((a, b) => (Math.abs(a[0].y - b[0].y) < 0.01 ? a[0].x - b[0].x : a[0].y - b[0].y));
  return JSON.stringify({ lines: lines });
}
"#;

/// The system's colour sampler (NSColorSampler, macOS 10.15): a magnifier
/// under the pointer, a click picks, Esc leaves. Answers `{ rgb: [r, g, b],
/// x, y }` (sRGB; where the pointer was, top-left origin in points), or the
/// word `cancelled` / `unsupported` / `failed`. argv[0] is how many seconds
/// it may stay open. It needs no permission: the system reads the pixel.
pub const COLOR_SAMPLER: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  if (!$.NSColorSampler) return 'unsupported';
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: no Dock icon, no menu bar
  app.finishLaunching;
  app.activateIgnoringOtherApps(true);
  let answer = null;
  const sampler = $.NSColorSampler.alloc.init;
  sampler.showSamplerWithSelectionHandler((picked) => {
    if (!picked || (picked.isNil && picked.isNil())) { answer = 'cancelled'; return; }
    const c = picked.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
    if (!c || c.isNil()) { answer = 'failed'; return; }
    const v = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
    const p = $.NSEvent.mouseLocation;
    const mainH = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
    answer = JSON.stringify({
      rgb: [v(c.redComponent), v(c.greenComponent), v(c.blueComponent)],
      x: Math.round(p.x), y: Math.round(mainH - p.y),
    });
  });
  // osascript has no event loop of its own: the sampler's clicks and keys
  // come through this one. Every event type is in the mask.
  const until = Date.now() + Number(argv[0] || 120) * 1000;
  while (answer === null && Date.now() < until) {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(Number.MAX_SAFE_INTEGER,
      $.NSDate.dateWithTimeIntervalSinceNow(0.1), $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) app.sendEvent(ev);
  }
  return answer === null ? 'cancelled' : answer;
}
"#;
