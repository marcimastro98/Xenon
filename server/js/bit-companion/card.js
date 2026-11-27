'use strict';
// The card of the person's own Bit, to post: their Bit big in its own pose, on its own colour or in
// its theatre (prefs.card, room-scenery.js) or in its home (the worn 'home' item), its number and name, its DNA with the true odds
// (card-dna.js) and a QR to the site, or to its own page there once shown (server/bit/publish.js).
// Drawn from the engine's picture and the server's view of the Bit, never a capture of the page, so
// nothing else on screen ends up in it; it shows only what the Bit owns, never a try-on.
(() => {
  const W = 1080;
  const H = 1350;
  const SITE = 'https://xenon-app.com/';
  const PAGE = SITE + 'bit.html#';
  // Its page when shown and the answer is one of ours, else the site.
  const pageOf = (bit) => (typeof bit?.page === 'string' && bit.page.startsWith(PAGE) && /^[1-9]\d{0,8}$/.test(bit.page.slice(PAGE.length)) ? bit.page : '');
  // The brand's ink when a Bit's colours are not known (BitDna.colors); the same from any theme.
  const PLAIN = Object.freeze({ ink: '#0e1116', text: '#f2f4f7', muted: '#9aa3b2', line: '#2a303a' });
  const FONT = '"Sofia Sans", system-ui, sans-serif';
  // Where things sit on each ground: the plain one has the Bit big under the mark; the theatre is
  // its stage across the top (cells of 8 px, as in the room), with the mark inside the curtains.
  const LAYOUT = Object.freeze({
    plain: { bit: { x: 250, y: 120, w: 580 }, big: 770, small: 826, about: 884, strip: 946 },
    stage: { stage: 720, mark: { x: 128, y: 80 }, big: 812, small: 864, about: 918, strip: 962 },
  });
  const hasHome = (bit) => !!window.Xenon?.bitWardrobe?.outfit(bit?.worn || []).some((it) => it.slot === 'home');
  const groundOf = (bit) => ({ stage: !!window.BitScenery, home: hasHome(bit) }[bit?.prefs?.card] ? bit.prefs.card : 'plain');
  const toneOf = (bit) => window.BitDna?.colors(bit) || PLAIN;

  // The card last made, kept while the Bit it shows stays the same: the sheet draws itself again
  // on every change the server tells, and the picture must not go with it.
  let made = null; // { key, canvas, title, src }
  let pending = null; // { key, run }: the card being drawn, shared by every redraw of the drawer
  const keyOf = (bit) => JSON.stringify([bit.number, bit.name, bit.worn, bit.founder, bit.born, bit.genes, bit.prefs?.pose, groundOf(bit), pageOf(bit)]);

  // Its odds: shiny or classic green when it is, then its whole look, since one gene alone repeats
  // across Bits (every pastel colour is 1 in 39). Also the sheet's line.
  function rareLine(bit, say, num) {
    const top = Array.isArray(bit?.rarity) ? bit.rarity[0] : null;
    const special = top?.gene === 'shiny' ? say('mybit_rare_shiny', { n: num(top.oneIn) })
      : top?.id === 'classic' ? say('mybit_rare_classic', { n: num(top.oneIn) }) : '';
    const look = bit?.lookOneIn > 1 ? say('mybit_look_odds', { n: num(bit.lookOneIn) }) : '';
    return [special, look].filter(Boolean).join(' ');
  }

  // Sentences side by side: Japanese and Chinese put none between them.
  const joined = (parts, code) => parts.filter(Boolean).join(/^(ja|zh)/.test(code || '') ? '' : ' ');

  // Who it is in plain sentences, under the big line: being one of the Founders and its odds.
  function aboutLine(bit, say, num, code) {
    return joined([bit.founder ? say('mybit_founder') : '', rareLine(bit, say, num)], code);
  }

  // The card's line: a Founder, and that no other Bit looks like it (known only for a hub-numbered Bit).
  function cardLine(bit, say, code) {
    return joined([bit.founder ? say('mybit_founder') : '', bit.number && !bit.local ? say('mybit_share_unique') : ''], code);
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
      about: cardLine(bit, say, code),
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

  // The Bit in its own pose (card-dna.js), drawn crisp at `size` pixels on the ground `ink`; in its doorway with `home`.
  async function bitPicture(bit, size, ink = PLAIN.ink, home = false) {
    const X = window.Xenon;
    if (!X?.bit || !X.bitLook || !X.bitWardrobe || !bit.genes) return null;
    const look = X.bitLook.lookOf(bit.genes, { worn: X.bitWardrobe.outfit(bit.worn || []), background: ink });
    const D = window.BitDna;
    const shot = D?.pose(D.poseOf(bit)) || { clip: X.bit.clip('idle'), frame: 0 };
    const svg = X.bit.frameSvg(shot.clip, shot.frame, { size, look, clipId: 'bitcard', home });
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

  // The Xenon mark and its name, the mark's top-left corner at (x, y).
  function mark(ctx, logo, x, y, tone) {
    if (logo) ctx.drawImage(logo, x, y, 52, 52);
    ctx.fillStyle = tone.text;
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText('Xenon', logo ? x + 66 : x, y + 38);
  }

  // The ground every card shares: the ink (the Bit's own, `tone`), the Xenon mark at the top,
  // and at the foot the tagline, the site and a QR to `target` (recap.js draws on it too).
  async function ground(tagline, target, tone = PLAIN) {
    const [logo, qr] = await Promise.all([brand(), qrCode(target)]);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = tone.ink;
    ctx.fillRect(0, 0, W, H);
    mark(ctx, logo, 64, 60, tone);
    ctx.fillStyle = tone.line;
    ctx.fillRect(64, 1150, W - 128, 2);
    ctx.fillStyle = tone.text;
    const tag = fitLines(ctx, tagline, qr ? 700 : W - 128, 2, 600, [34, 30, 26]);
    tag.lines.forEach((line, i) => { ctx.fillText(line, 64, 1210 + i * (tag.size + 10)); });
    ctx.fillStyle = tone.muted;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText('xenon-app.com', 64, 1300);
    if (qr) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(W - 64 - 160, 1166, 160, 160, 14);
      ctx.fill();
      window.ShareCard.drawQr(ctx, qr, W - 64 - 148, 1178, 136);
    }
    return { canvas, ctx, logo };
  }

  // Its theatre across the top of the card, the mark inside the curtains; where the Bit stands in it.
  async function stage(ctx, bit, logo, tone) {
    const L = LAYOUT.stage;
    const scene = window.BitScenery.picture(bit, W, L.stage);
    const url = URL.createObjectURL(new Blob([scene.svg], { type: 'image/svg+xml' }));
    try {
      const img = await image(url);
      if (img) ctx.drawImage(img, 0, 0, W, L.stage);
    } finally { URL.revokeObjectURL(url); }
    mark(ctx, logo, L.mark.x, L.mark.y, tone);
    return scene.bit;
  }

  async function draw(bit, say, num, date) {
    const said = words(bit, say, num, date, typeof lang === 'string' ? lang : 'en');
    const tone = toneOf(bit);
    const L = LAYOUT[groundOf(bit) === 'stage' ? 'stage' : 'plain'];
    const [{ canvas, ctx, logo }, picture] = await Promise.all([ground(said.tagline, pageOf(bit) || SITE, tone), bitPicture(bit, 580, tone.ink, groundOf(bit) === 'home')]);
    const spot = L.stage ? await stage(ctx, bit, logo, tone) : L.bit;
    if (picture) ctx.drawImage(picture, spot.x, spot.y, spot.w, picture.height * (spot.w / picture.width));
    ctx.fillStyle = tone.text;
    ctx.textAlign = 'center';
    const big = fitLines(ctx, said.big, W - 128, 1, 800, [92, 76, 64]);
    ctx.fillText(big.lines[0] || '', W / 2, L.big);
    ctx.fillStyle = tone.muted;
    if (said.small) ctx.fillText(fitLines(ctx, said.small, W - 128, 1, 500, [34, 30, 26]).lines[0] || '', W / 2, L.small);
    if (said.about) {
      ctx.fillStyle = tone.text;
      ctx.fillText(fitLines(ctx, said.about, W - 160, 1, 600, [34, 30, 26]).lines[0] || '', W / 2, L.about);
    }
    ctx.textAlign = 'start';
    window.BitDna?.strip(ctx, bit, { x: 64, y: L.strip, w: W - 128, say, num, font: FONT, tone, sizes: { swatch: 80, label: 26, odds: 30 } });
    return { canvas, title: said.big };
  }

  const blobOf = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no_image'))), 'image/png');
  });

  // Copy, share and save, where this browser can, in one word each: the same order as the setup's
  // card (presets/share-card.js), saving last and filled.
  function actions(canvas, h, name = 'my-bit.png') {
    const row = makeEl('div', 'bitc-acts');
    const add = (key, run, main = false) => {
      const b = makeEl('button', main ? 'bitc-seg-btn is-main' : 'bitc-seg-btn', h.say(key));
      b.type = 'button';
      b.addEventListener('click', run, { signal: h.signal });
      row.append(b);
    };
    const S = window.XenonSaveFile;
    if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
      // The write runs inside the tap that asked for it.
      add('mybit_act_copy', () => navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blobOf(canvas) })])
        .then(() => h.note(h.say('sharecard_copied_image')), () => h.note(h.say('sharecard_copy_image_fail'))));
    }
    if (navigator.canShare) {
      add('mybit_act_share', async () => {
        const file = new File([await blobOf(canvas)], name, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: 'Xenon' }).catch(() => {});
      });
    }
    if (S) {
      add('mybit_act_save', () => S.save({ name, types: [S.PNG_TYPE], make: () => blobOf(canvas) })
        .catch(() => h.note(h.say('save_file_failed'))), true);
    }
    return row;
  }

  const dateOf = (iso) => (Number.isNaN(Date.parse(iso)) ? '' : new Date(iso).toLocaleDateString(typeof lang === 'string' ? lang : 'en', { day: 'numeric', month: 'long', year: 'numeric' }));

  // The card for this look: the one being drawn when there is one, else a new one.
  function cardFor(bit, h, key) {
    if (pending?.key === key) return pending.run;
    const run = draw(bit, h.say, h.num, dateOf).then(({ canvas, title }) => ({ key, canvas, title, src: canvas.toDataURL('image/png') }));
    pending = { key, run };
    run.then((card) => { made = card; }, () => {}).finally(() => { if (pending?.run === run) pending = null; });
    return run;
  }

  /**
   * The drawer's part: the card, drawn as soon as it shows (a frame its size waits in its place),
   * the drawer's `tools` for it, then what to do with it; a button to try again when it failed.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, note: Function, redraw: Function, signal: AbortSignal }} h the room's hands
   * @param {Node[]} [tools]
   */
  function section(bit, h, tools = []) {
    const box = makeEl('div', 'bitc-card');
    const slot = makeEl('div', 'bitc-card-slot');
    const acts = makeEl('div', 'bitc-card-acts');
    box.append(slot, ...tools, acts);
    const key = keyOf(bit);
    const show = (card) => {
      const img = makeEl('img', 'bitc-card-img');
      img.alt = card.title;
      img.src = card.src;
      slot.replaceChildren(img);
      acts.replaceChildren(actions(card.canvas, h));
    };
    if (made?.key === key) { show(made); return box; }
    const make = () => {
      slot.replaceChildren(makeEl('div', 'bitc-card-img is-wait'));
      cardFor(bit, h, key).then((card) => { if (!h.signal.aborted && box.isConnected) show(card); }, () => {
        if (h.signal.aborted || !box.isConnected) return;
        const again = makeEl('button', 'bitc-seg-btn', h.say('mybit_share'));
        again.type = 'button';
        again.addEventListener('click', make, { signal: h.signal });
        slot.replaceChildren(again);
        h.note(h.say('mybit_share_failed'));
      });
    };
    make();
    return box;
  }

  // What recap.js and clip.js draw with: the same ground, mark, Bit, type and buttons.
  const paint = Object.freeze({ W, H, PLAIN, FONT, SITE, toneOf, pageOf, brand, ground, bitPicture, fitLines, actions });
  window.BitCard = { section, words, rareLine, aboutLine, paint, hasHome, reset: () => { made = null; pending = null; } };
})();
