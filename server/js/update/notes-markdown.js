// The release notes as page elements: a small markdown reader that builds text, links, lists,
// headings and the GitHub pictures and clips the entry allows, never markup taken from the notes.
'use strict';

window.UpdateNotesMarkdown = (wrapper) => {
  const { isAllowedMediaUrl, openLightbox, tr } = wrapper;

  function buildImage(url, alt) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = url;
    if (alt) img.alt = alt;
    return img;
  }

  // ── Safe markdown → DOM ─────────────────────────────────────────────────────
  // The notes come from GitHub: treat them as untrusted. We build DOM nodes with
  // textContent only (never innerHTML), accept only http(s) links, and only
  // GitHub-hosted media (see isAllowedMediaUrl).
  function appendInline(parent, text) {
    // Group 1 = optional "!" (image marker), 2 = link/alt text, 3 = url; then bold, code.
    const re = /(!?)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[3] !== undefined) {
        if (m[1] === '!') {
          // Inline image (e.g. a small screenshot mid-sentence). Non-GitHub images
          // (shields.io badges, etc.) are dropped rather than loaded from arbitrary hosts.
          if (isAllowedMediaUrl(m[3])) {
            const img = buildImage(m[3], m[2]);
            img.className = 'upd-inline-img';
            parent.appendChild(img);
          }
        } else {
          const a = document.createElement('a');
          a.href = m[3]; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = m[2];
          parent.appendChild(a);
        }
      } else if (m[4] !== undefined) {
        const s = document.createElement('strong');
        s.textContent = m[4];
        parent.appendChild(s);
      } else if (m[5] !== undefined) {
        const c = document.createElement('code');
        c.textContent = m[5];
        parent.appendChild(c);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // A block-level image/video embedded in the notes. Images open a fullscreen
  // lightbox on tap (the Xeneon Edge is a small touchscreen — a thumbnail alone
  // is unreadable). Videos play inline with native controls. Either degrades to a
  // "open on GitHub" link if the media fails to load.
  function appendMedia(container, url, type, alt) {
    const fig = document.createElement('figure');
    fig.className = 'upd-media';
    if (type === 'video') {
      const v = document.createElement('video');
      v.className = 'upd-media-el';
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      const s = document.createElement('source');
      s.src = url;
      v.appendChild(s);
      v.addEventListener('error', () => replaceWithFallback(fig, url));
      fig.appendChild(v);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'upd-media-btn';
      btn.setAttribute('aria-label', tr('update_media_zoom', 'Ingrandisci immagine'));
      const img = buildImage(url, alt);
      img.className = 'upd-media-el';
      img.addEventListener('error', () => replaceWithFallback(fig, url));
      btn.appendChild(img);
      btn.addEventListener('click', () => openLightbox(url, alt));
      fig.appendChild(btn);
    }
    if (alt) {
      const cap = document.createElement('figcaption');
      cap.className = 'upd-media-cap';
      cap.textContent = alt;
      fig.appendChild(cap);
    }
    container.appendChild(fig);
  }

  function replaceWithFallback(fig, url) {
    fig.textContent = '';
    const a = document.createElement('a');
    a.className = 'upd-media-fallback';
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = tr('update_media_open', 'Apri media su GitHub');
    fig.appendChild(a);
  }

  function renderMarkdown(container, md, mediaTypes) {
    const media = mediaTypes || {};
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    let list = null;
    const closeList = () => { list = null; };
    // Matches a line that is ONLY a markdown image: ![alt](url)
    const loneImg = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const t = line.trim();
      // Block media: a lone markdown image, or a bare GitHub media URL the server
      // classified (this is how videos arrive). Rendered in place, not in a gallery.
      const im = t.match(loneImg);
      if (im && isAllowedMediaUrl(im[2])) {
        closeList();
        appendMedia(container, im[2], 'image', im[1]);
        continue;
      }
      if (/^https?:\/\/\S+$/.test(t) && isAllowedMediaUrl(t) && (media[t] === 'image' || media[t] === 'video')) {
        closeList();
        appendMedia(container, t, media[t], '');
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        if (!list) { list = document.createElement('ul'); list.className = 'upd-list'; container.appendChild(list); }
        const li = document.createElement('li');
        appendInline(li, line.replace(/^\s*[-*]\s+/, ''));
        list.appendChild(li);
      } else if (/^#{1,6}\s+/.test(line)) {
        closeList();
        const level = line.match(/^#+/)[0].length;
        const h = document.createElement(level <= 2 ? 'h3' : 'h4');
        h.className = 'upd-h';
        appendInline(h, line.replace(/^#+\s+/, ''));
        container.appendChild(h);
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        const p = document.createElement('p');
        p.className = 'upd-p';
        appendInline(p, line);
        // Skip a paragraph left empty because its only content was dropped (e.g. a
        // non-GitHub image badge on its own line) — no stray blank gap.
        if (p.childNodes.length) container.appendChild(p);
      }
    }
  }

  return { renderMarkdown };
};
