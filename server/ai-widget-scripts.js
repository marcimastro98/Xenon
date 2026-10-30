'use strict';

// The widget sandbox's CSP is `script-src 'self'`: an inline <script> never
// runs, so a widget whose code sits inside index.html installs fine and then
// shows an empty tile. Models write it that way often, so before a package the
// assistant made is installed or encoded, each inline script becomes a file of
// its own beside the page and the tag points at it. Only text files ({path,
// content}) are read; anything else passes through untouched.

const MAX_FILES = 40;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HAS_SRC = /\bsrc\s*=/i;
const TYPE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const RUNNABLE_TYPES = new Set(['text/javascript', 'application/javascript', 'module']);

const isHtml = (p) => /\.html?$/i.test(p);

function runs(attrs) {
  const m = TYPE.exec(attrs);
  return !m || RUNNABLE_TYPES.has(m[1].toLowerCase());
}

function splitPath(p) {
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  return { dir, stem: p.slice(dir.length).replace(/\.html?$/i, '') };
}

// files: [{path, content?, data?}] → {files, moved}: moved counts the scripts
// that became files. Over the package's file cap nothing is moved, and the
// page is left as written.
function externalizeInlineScripts(files) {
  const list = Array.isArray(files) ? files : [];
  const taken = new Set(list.map((f) => String(f && f.path || '')));
  const added = [];
  let moved = 0;
  const out = list.map((f) => {
    if (!f || typeof f.content !== 'string' || !isHtml(String(f.path || ''))) return f;
    const { dir, stem } = splitPath(String(f.path));
    let n = 0;
    const content = f.content.replace(SCRIPT, (whole, attrs, body) => {
      if (HAS_SRC.test(attrs) || !runs(attrs) || !body.trim()) return whole;
      if (list.length + added.length >= MAX_FILES) return whole;
      let name;
      do { n += 1; name = stem + '-script' + (n > 1 ? '-' + n : '') + '.js'; } while (taken.has(dir + name));
      taken.add(dir + name);
      added.push({ path: dir + name, content: body.trim() + '\n' });
      moved += 1;
      return '<script' + attrs + ' src="' + name + '"></script>';
    });
    return content === f.content ? f : { ...f, content };
  });
  return { files: out.concat(added), moved };
}

module.exports = { externalizeInlineScripts };
