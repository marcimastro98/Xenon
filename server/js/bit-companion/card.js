'use strict';
// The card of the person's own Bit, to post: their Bit big, its number and name, its rarest
// trait with the true odds, and a QR to the site where anyone gets one (to its own page there
// when the person chose to show it, server/bit/publish.js). Made in the sheet
// (bit-companion/sheet.js) when asked, on a canvas from the engine's own picture
// (Xenon.bit.frameSvg) and the server's view of the Bit, never a capture of the page, so
// nothing else on screen can end up in it. It shows only what the Bit owns, never a try-on.
(() => {
  const W = 1080;
  const H = 1350;
  const SITE = 'https://xenon-app.com/';
  const PAGE = SITE + 'bit.html#';
  // Its page when shown and the answer is one of ours, else the site.
  const pageOf = (bit) => (typeof bit?.page === 'string' && bit.page.startsWith(PAGE) && /^[1-9]\d{0,8}$/.test(bit.page.slice(PAGE.length)) ? bit.page : '');
  // A fixed ground, so a card reads the same from any theme: the brand's ink and its text.
  const INK = '#0e1116';
  const TEXT = '#f2f4f7';
  const MUTED = '#9aa3b2';
  const LINE = '#2a303a';
  const FONT = '"Sofia Sans", system-ui, sans-serif';
  const BIT = { x: 160, y: 96, w: 760 };

  // The card last made, kept while the Bit it shows stays the same: the sheet draws itself again
  // on every change the server tells, and the picture must not go with it.
  let made = null; // { key, canvas, title, src }
  const keyOf = (bit) => JSON.stringify([bit.number, bit.name, bit.worn, bit.founder, bit.born, bit.genes, pageOf(bit)]);

  // The rarest visible trait with its true odds, or '' (also the sheet's line).
  function rareLine(bit, say, num) {
    const top = Array.isArray(bit?.rarity) ? bit.rarity[0] : null;
    if (!top) return '';
    const key = top.gene === 'shiny' ? 'mybit_rare_shiny' : top.id === 'classic' ? 'mybit_rare_classic' : 'mybit_rare_trait';
    return say(key, { n: num(top.oneIn) });
  }

  // Sentences side by side: Japanese and Chinese put none between them.
  const joined = (parts, code) => parts.filter(Boolean).join(/^(ja|zh)/.test(code || '') ? '' : ' ');

  // Who it is in plain sentences, under the big line: being one of the Founders and the rarest trait.
  function aboutLine(bit, say, num, code) {
    return joined([bit.founder ? say('mybit_founder') : '', rareLine(bit, say, num)], code);
  }

  // What the card says, pure: the big line is the name when it has one, else its number;
  // under it when it hatched, then the line about it.
  function words(bit, say, num, date, code) {
    const number = bit.number ? say('mybit_number', { n: num(bit.number) }) : '';
    const name = typeof bit.name === 'string' ? bit.name.trim() : '';
    const day = bit.born ? date(bit.born) : '';
    let small = '';
    if (name && number) small = day ? say('mybit_share_born_of', { number, date: day }) : number;
    else if (day) small = say('mybit_share_born', { date: day });
    return {
      big: name || number || say('mybit_title'),
      small,
      about: aboutLine(bit, say, num, code),
      tagline: say('mybit_share_tagline'),
    };
  }

  function image(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // The Bit in the pose it strikes for a photo, drawn crisp at `size` pixels.
  async function bitPicture(bit, size) {
    const X = window.Xenon;
    if (!X?.bit || !X.bitLook || !X.bitWardrobe || !bit.genes) return null;
    const look = X.bitLook.lookOf(bit.genes, { worn: X.bitWardrobe.outfit(bit.worn || []), background: INK });
    const clip = X.bit.clip('pose') || X.bit.clip('idle');
    const svg = X.bit.frameSvg(clip, X.bitPlayer ? X.bitPlayer.stillIndex(clip) : 0, { size, look, clipId: 'bitcard' });
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try { return await image(url); } finally { URL.revokeObjectURL(url); }
  }

  async function qrCode(target) {
    try {
      const lib = await window.ShareCard?.loadQrLib();
      if (!lib) return null;
      const qr = lib(0, 'M');
      qr.addData(target);
      qr.make();
      return qr;
    } catch { return null; }
  }

  // Lines that fit maxW: at the spaces, and inside a word too wide for one line (Japanese and
  // Chinese write a sentence without spaces), between its characters.
  function wrap(ctx, text, maxW) {
    const lines = [];
    let line = '';
    const fits = (s) => ctx.measureText(s).width <= maxW;
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) { line = next; continue; }
      if (line) lines.push(line);
      line = '';
      for (const ch of word) {
        if (line && !fits(line + ch)) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Text in at most maxLines lines: the largest size, from the list, at which it fits.
  function fitLines(ctx, text, maxW, maxLines, weight, sizes) {
    for (const size of sizes) {
      ctx.font = `${weight} ${size}px ${FONT}`;
      const lines = wrap(ctx, text, maxW);
      if (lines.length <= maxLines || size === sizes[sizes.length - 1]) return { lines: lines.slice(0, maxLines), size };
    }
    return { lines: [], size: sizes[0] };
  }

  // The Xenon mark, and the brand's type ready to draw with (null when the mark does not load).
  async function brand() {
    const base = typeof SERVER === 'string' && SERVER ? SERVER + '/' : '';
    const [logo] = await Promise.all([
      image(base + 'public/images/logo/logo-mark.png'),
      document.fonts?.load(`800 92px ${FONT}`).catch(() => null),
    ]);
    return logo;
  }

  // The ground every card shares: the ink, the Xenon mark at the top, and at the foot the
  // tagline, the site and a QR to `target` (recap.js draws its card on it too).
  async function ground(tagline, target) {
    const [logo, qr] = await Promise.all([brand(), qrCode(target)]);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);
    if (logo) ctx.drawImage(logo, 64, 60, 52, 52);
    ctx.fillStyle = TEXT;
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText('Xenon', logo ? 130 : 64, 98);
    ctx.fillStyle = LINE;
    ctx.fillRect(64, 1140, W - 128, 2);
    ctx.fillStyle = TEXT;
    const tag = fitLines(ctx, tagline, qr ? 700 : W - 128, 2, 600, [34, 30, 26]);
    tag.lines.forEach((line, i) => { ctx.fillText(line, 64, 1210 + i * (tag.size + 10)); });
    ctx.fillStyle = MUTED;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText('xenon-app.com', 64, 1300);
    if (qr) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(W - 64 - 160, 1166, 160, 160, 14);
      ctx.fill();
      window.ShareCard.drawQr(ctx, qr, W - 64 - 148, 1178, 136);
    }
    return { canvas, ctx };
  }

  async function draw(bit, say, num, date) {
    const said = words(bit, say, num, date, typeof lang === 'string' ? lang : 'en');
    const [picture, { canvas, ctx }] = await Promise.all([bitPicture(bit, BIT.w), ground(said.tagline, pageOf(bit) || SITE)]);
    if (picture) ctx.drawImage(picture, BIT.x, BIT.y, BIT.w, picture.height * (BIT.w / picture.width));
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    const big = fitLines(ctx, said.big, W - 128, 1, 800, [92, 76, 64]);
    ctx.fillText(big.lines[0] || '', W / 2, 930);
    ctx.fillStyle = MUTED;
    if (said.small) ctx.fillText(fitLines(ctx, said.small, W - 128, 1, 500, [34, 30, 26]).lines[0] || '', W / 2, 990);
    if (said.about) {
      ctx.fillStyle = TEXT;
      const about = fitLines(ctx, said.about, W - 200, 2, 600, [32, 28]);
      about.lines.forEach((line, i) => { ctx.fillText(line, W / 2, 1050 + i * (about.size + 10)); });
    }
    ctx.textAlign = 'start';
    return { canvas, title: said.big };
  }

  const blobOf = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no_image'))), 'image/png');
  });

  // Save, copy and share, where this browser can.
  function actions(canvas, h, name = 'my-bit.png') {
    const row = makeEl('div', 'bitc-seg');
    const add = (key, run) => {
      const b = makeEl('button', 'bitc-seg-btn', h.say(key));
      b.type = 'button';
      b.addEventListener('click', run, { signal: h.signal });
      row.append(b);
    };
    const S = window.XenonSaveFile;
    if (S) {
      add('sharecard_download', () => S.save({ name, types: [S.PNG_TYPE], make: () => blobOf(canvas) })
        .catch(() => h.note(h.say('save_file_failed'))));
    }
    if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
      // The write runs inside the tap that asked for it.
      add('sharecard_copy_image', () => navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blobOf(canvas) })])
        .then(() => h.note(h.say('sharecard_copied_image')), () => h.note(h.say('sharecard_copy_image_fail'))));
    }
    if (navigator.canShare) {
      add('sharecard_share', async () => {
        const file = new File([await blobOf(canvas)], name, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: 'Xenon' }).catch(() => {});
      });
    }
    return row;
  }

  // Its page on xenon-app.com, by choice (POST /api/bit/publish): only a Bit with the hub's
  // number has one. The line says what the page shows; the link opens it once it is shown.
  function siteChoice(bit, h) {
    if (!bit.number || bit.local) return null;
    const box = makeEl('div', 'bitc-site');
    const label = makeEl('label', 'bitc-switch');
    const input = makeEl('input');
    input.type = 'checkbox';
    input.checked = bit.shown === true;
    input.addEventListener('change', async () => {
      input.disabled = true;
      const out = await h.post('/api/bit/publish', { public: input.checked });
      if (out.ok) { h.told(out); return; }
      if (out.bit) h.told({ ok: true, bit: out.bit });
      input.checked = !input.checked;
      input.disabled = false;
      h.note(h.say(out.error === 'taken_down' ? 'mybit_site_taken_down' : 'mybit_site_failed'));
    }, { signal: h.signal });
    label.append(input, makeEl('span', '', h.say('mybit_site')));
    box.append(label, makeEl('p', 'bitc-line', h.say('mybit_site_line')));
    const page = pageOf(bit);
    if (page) {
      const link = makeEl('a', 'bitc-site-link', h.say('mybit_site_open'));
      link.href = page;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.append(link);
    }
    return box;
  }

  /**
   * The sheet's part: a button that makes the card, then the card and what to do with it,
   * and the choice to show the Bit on the site.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, note: Function, post: Function, told: Function, redraw: Function, signal: AbortSignal }} h the sheet's hands
   */
  function section(bit, h) {
    const box = makeEl('div', 'bitc-part bitc-card');
    const slot = makeEl('div', 'bitc-card-slot');
    const site = siteChoice(bit, h);
    box.append(slot);
    if (site) box.append(site);
    const key = keyOf(bit);
    const show = () => {
      const img = makeEl('img', 'bitc-card-img');
      img.alt = made.title;
      img.src = made.src;
      slot.replaceChildren(img, actions(made.canvas, h));
    };
    if (made?.key === key) { show(); return box; }
    const go = makeEl('button', 'bitc-seg-btn', h.say('mybit_share'));
    go.type = 'button';
    const date = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(typeof lang === 'string' ? lang : 'en', { day: 'numeric', month: 'long', year: 'numeric' });
    };
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const { canvas, title } = await draw(bit, h.say, h.num, date);
        if (h.signal.aborted) return;
        made = { key, canvas, title, src: canvas.toDataURL('image/png') };
        if (box.isConnected) show(); else h.redraw();
      } catch {
        go.disabled = false;
        h.note(h.say('mybit_share_failed'));
      }
    }, { signal: h.signal });
    slot.append(go);
    return box;
  }

  // What recap.js and clip.js draw with: the same ground, mark, Bit, type and buttons.
  const paint = Object.freeze({ W, H, INK, TEXT, MUTED, FONT, SITE, pageOf, brand, ground, bitPicture, fitLines, actions });
  window.BitCard = { section, words, rareLine, aboutLine, paint, reset: () => { made = null; } };
})();
