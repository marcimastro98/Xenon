// Checks the saved settings of file search: the extra folders, the shortcut and what the
// results show.

// Local file search (Spotlight). extraFolders are the crawler's roots — real
// absolute directories the user names in Settings; the crawl enumerates them
// server-side and search results address by opaque id, so this list is the
// only place a path exists. The global hotkey is helper-gated and OFF by
// default (it registers a system-wide key).
function normalizeSearchSettings(value, defaultRoot) {
  const v = value && typeof value === 'object' ? value : {};
  // indexRoots: the Living Index roots (drives or folders). Migration: older
  // saves carried extraFolders (the retired one-shot crawl) — adopt them.
  // Never-set → default to the whole system drive on Windows, and to the
  // user's HOME elsewhere (`defaultRoot`): the POSIX analogue of "the system
  // drive" would walk /System and /Applications, millions of entries the index
  // caps out on, none of which is a file the user is looking for. An
  // explicitly emptied list means the user turned the index off and stays empty.
  const rawRoots = Array.isArray(v.indexRoots) ? v.indexRoots
    : (Array.isArray(v.extraFolders) && v.extraFolders.length ? v.extraFolders : null);
  // A root is either a Windows drive path or a POSIX absolute one, and BOTH
  // shapes are accepted on both sides whatever the machine is. That is not
  // laxity: this same function runs in the BROWSER, which cannot know what the
  // host is, so a validator that guessed would silently drop the user's root
  // on the next settings save. The platform decides only the DEFAULT, which
  // the server passes in.
  //
  // The separator rewrite applies to the Windows shape ONLY. Off Windows a
  // backslash is a legal filename character, and rewriting "/" there turned
  // "/Users/me" into "\Users\me", which then failed the drive-letter test —
  // so indexRoots could never hold anything but the default "C:\", which does
  // not exist on a Mac. The Living Index therefore never started, and search
  // AND the disk widget (which addresses these same roots by index) were both
  // dead with nothing the user could type to fix it.
  const cleanRoot = (raw) => {
    const s = String(raw || '').trim().slice(0, 4096);
    // A single leading slash is POSIX; two is a UNC share, which is not a
    // local root and stays rejected as it always was.
    if (/^\/(?!\/)/.test(s)) return s.length > 1 ? s.replace(/\/+$/, '') : s;
    // Every Windows consumer downstream (the disk overview's root prefix test,
    // registerBrowsePath, the guard) compares backslash paths, so a root saved
    // as "C:/Projects" passed validation and then matched nothing — an empty
    // treemap with no explanation.
    const w = s.slice(0, 260).replace(/\//g, '\\');
    if (!/^[A-Za-z]:\\?$|^[A-Za-z]:\\.+/.test(w)) return '';
    return w.length === 2 ? w + '\\' : w;
  };
  // No `|| 'C:\\'` fallback. A caller that knows the machine passes
  // `defaultRoot`; one that does not must get NO root rather than a Windows
  // drive letter, because the copy of this function that runs in the browser
  // is exactly such a caller, and its guess was written to settings.json on
  // every Mac and Linux install — a root nothing could walk, with Settings
  // showing it as configured the whole time.
  const roots = rawRoots == null
    ? (defaultRoot ? [defaultRoot] : null)
    : rawRoots.map(cleanRoot).filter(Boolean).slice(0, 8);
  const combo = String(v.hotkeyCombo || 'alt+space').toLowerCase().trim().slice(0, 40);
  return {
    ...(roots ? { indexRoots: roots } : {}),
    hotkeyEnabled: v.hotkeyEnabled === true,
    hotkeyCombo: /^[a-z0-9+ ]{3,40}$/.test(combo) ? combo : 'alt+space',
    // AI full context ("the brain"): enriches a Disk Advisor request the user
    // pressed for with the hardware profile and the names of the largest items.
    // Privacy-touching → strict opt-in, anything not literally true stays off
    // (same rule as the wake word).
    aiFullContext: v.aiFullContext === true,
    // The Search TILE listing recently opened files when its box is empty. Off
    // unless literally true: the tile sits on a dashboard others can see.
    recentInTile: v.recentInTile === true,
  };
}

module.exports = { normalizeSearchSettings };
