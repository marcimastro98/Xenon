'use strict';

// What the Disk widget's capacity bar is split into. By extension, except that
// anything inside a game library folder is a game whatever its extension: a
// 90 GB game is .pak/.bin/.dat files that would otherwise all read as "other".
//
// The Windows helper (helper/IndexHost.cs, BuildExtKinds/GameLibraryNames) and
// the macOS one (helper-mac IndexHost.swift) carry the same two lists; a change
// here belongs there too, or one platform splits the bar differently.

const KINDS = ['other', 'video', 'image', 'audio', 'document', 'archive', 'app', 'game'];

const EXT_LISTS = {
  video: 'mp4 mkv mov avi wmv flv webm m4v mpg mpeg ts m2ts mts 3gp vob',
  image: 'jpg jpeg png gif bmp tif tiff webp heic heif raw cr2 cr3 nef arw dng orf rw2 psd ico avif jxl',
  audio: 'mp3 wav flac aac ogg m4a wma opus aiff aif alac mid midi',
  document: 'pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt md csv epub pages numbers key',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst iso img dmg cab lz4 wim vhd vhdx',
  app: 'exe dll msi sys appx msix msixbundle so dylib pkg deb rpm drv ocx mui cat nls efi jar',
};

const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(EXT_LISTS)) {
  for (const ext of list.split(' ')) EXT_KIND.set(ext, kind);
}

const GAME_LIBRARY_NAMES = ['steamapps', 'epic games', 'xboxgames', 'gog games', 'riot games', 'ea games', 'rockstar games'];
const GAME_SET = new Set(GAME_LIBRARY_NAMES);

// The extension as the helpers read it: after the last dot, 1-8 ASCII letters
// or digits, and never a leading dot (".gitignore" has none).
function extOf(name) {
  const n = String(name || '');
  const dot = n.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = n.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

// `dirPath`: the file's directory (either separator); any component that is a
// game library name makes the file a game.
function kindOf(name, dirPath) {
  const parts = String(dirPath || '').split(/[\\/]+/);
  for (const part of parts) if (part && GAME_SET.has(part.toLowerCase())) return 'game';
  return EXT_KIND.get(extOf(name)) || 'other';
}

function emptyKinds() {
  const out = {};
  for (const k of KINDS) out[k] = 0;
  return out;
}

module.exports = { KINDS, EXT_LISTS, GAME_LIBRARY_NAMES, extOf, kindOf, emptyKinds };
