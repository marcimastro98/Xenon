// Which kind of file each extension is, the icon drawn for each kind, the pictures that get a
// preview, and the typed words shown bold in a result's name.
'use strict';

(() => {
  const KIND_OF_EXT = {};

  const ICON_PATHS = {
    folder: 'M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
    image: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 12 4.5-5 3.5 4 2.5-3L20 16v2H5v-2Zm3.5-9A1.75 1.75 0 1 1 8.5 10.5 1.75 1.75 0 0 1 8.5 7Z',
    video: 'M4 5h11a1 1 0 0 1 1 1v3.5l5-3v11l-5-3V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
    audio: 'M9 4h2v12.6a3.4 3.4 0 1 1-2-3.1V4Zm5 2 6-2v10.6a3.4 3.4 0 1 1-2-3.1V7.5l-4 1.3V6Z',
    doc: 'M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm7 1.5V8h4.5L13 3.5ZM8 12h8v1.6H8V12Zm0 4h8v1.6H8V16Z',
    zip: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm6 1v2h2V4h-2Zm0 3v2h2V7h-2Zm0 3v2h2v-2h-2Zm-1 3.5h4l1 4a3 3 0 1 1-6 0l1-4Z',
    exe: 'M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4Zm0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
    file: 'M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm7 1.5V8h4.5L13 3.5Z',
    app: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  };

  // Highlight query terms inside an UNTRUSTED file name without innerHTML:
  // split on the matches and append text nodes + <b> spans.
  function highlightName(name, terms) {
    const frag = document.createDocumentFragment();
    const lower = name.toLowerCase();
    const ranges = [];
    for (const term of terms || []) {
      const tl = String(term).toLowerCase();
      if (tl.length < 2) continue;
      let idx = lower.indexOf(tl);
      while (idx !== -1) { ranges.push([idx, idx + tl.length]); idx = lower.indexOf(tl, idx + 1); }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [s, e] of ranges) {
      if (s < pos) continue;
      if (s > pos) frag.appendChild(document.createTextNode(name.slice(pos, s)));
      const b = document.createElement('b');
      b.textContent = name.slice(s, e);
      frag.appendChild(b);
      pos = e;
    }
    if (pos < name.length) frag.appendChild(document.createTextNode(name.slice(pos)));
    return frag;
  }

  const PREVIEW_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

  window.SpotlightFileKinds = { KIND_OF_EXT, ICON_PATHS, highlightName, PREVIEW_EXTS };
})();
