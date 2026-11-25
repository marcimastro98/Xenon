'use strict';
// The recap cards of the person's own Bit, to post: "Your November with Pixel" when a month
// closes, and "Your 2026 with Pixel" from 20 December to the end of January. What the month
// held comes from the server's view (server/bit/months.js, `recap`), counted on this PC only;
// the card draws it on the birth card's ground (card.js `paint`) in plain sentences, the Bit in
// its outfit, and a QR to the site. Made only when asked, in the Bit sheet.
(() => {
  const BIT = 440;
  // The Bit and its sentences are one group, centred between the title and the foot of the
  // 1080x1350 card: where it may end, the step between sentences, and the room under the Bit.
  const LAST_LINE = 1064;
  const LINE_STEP = 68;
  const UNDER_BIT = 100;
  // The sentences a card may say after the days, in the order they are picked: the first four
  // with something in them. Minutes are told in hours.
  const FACTS = Object.freeze([
    ['gaming', 60], ['music', 60], ['coding', 60], ['night', 1], ['early', 1], ['items', 1], ['hot', 60],
  ]);
  const MAX_FACTS = 4;
  const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
  const YEAR_KEY = /^\d{4}$/;

  const code = () => (typeof lang === 'string' ? lang : 'en');

  // "{n} days" in the form the language uses for n: key_one, key_few… with key_other behind.
  function counted(say, num, key, n, langCode) {
    let form = 'other';
    try { form = new Intl.PluralRules(langCode).select(n); } catch { /* a language Intl lacks: other */ }
    const exact = `${key}_${form}`;
    const said = say(exact, { n: num(n) });
    return said === exact ? say(`${key}_other`, { n: num(n) }) : said;
  }

  // What one card says, pure: the title, the number under a named Bit, and up to five sentences.
  function words(rec, kind, bit, say, num, langCode) {
    const number = bit.number ? say('mybit_number', { n: num(bit.number) }) : '';
    const name = (typeof bit.name === 'string' && bit.name.trim()) || number || 'Bit';
    let when = rec.key;
    if (kind === 'month') {
      const [y, m] = rec.key.split('-').map(Number);
      when = new Date(y, m - 1, 1).toLocaleDateString(langCode, { month: 'long' });
    }
    const title = say(kind === 'month' ? 'mybit_recap_month' : 'mybit_recap_year', { [kind]: when, name });
    const lines = [counted(say, num, 'mybit_recap_days', rec.days, langCode)];
    for (const [fact, per] of FACTS) {
      if (lines.length > MAX_FACTS) break;
      const n = fact === 'items' ? rec.items.length : Math.round((rec[fact] || 0) / per);
      if (n > 0) lines.push(counted(say, num, `mybit_recap_${fact}`, n, langCode));
    }
    return {
      title: title.charAt(0).toLocaleUpperCase(langCode) + title.slice(1),
      small: bit.name && number ? number : '',
      lines,
      button: say(kind === 'month' ? 'mybit_recap_month_btn' : 'mybit_recap_year_btn', { [kind]: when }),
      file: `my-bit-${rec.key}.png`,
    };
  }

  // The recaps there are in a view of the Bit, checked: [{ kind, rec }].
  function recapsOf(bit) {
    const r = bit?.recap && typeof bit.recap === 'object' ? bit.recap : {};
    const ok = (rec, key) => rec && typeof rec === 'object' && key.test(rec.key) && Number.isFinite(rec.days) && rec.days > 0 && Array.isArray(rec.items);
    return [
      ok(r.year, YEAR_KEY) ? { kind: 'year', rec: r.year } : null,
      ok(r.month, MONTH_KEY) ? { kind: 'month', rec: r.month } : null,
    ].filter(Boolean);
  }

  async function draw(said, bit) {
    const P = window.BitCard.paint;
    const tone = P.toneOf(bit);
    const [picture, { canvas, ctx }] = await Promise.all([
      P.bitPicture(bit, BIT, tone.ink), P.ground(said.tagline, P.pageOf(bit) || P.SITE, tone),
    ]);
    ctx.fillStyle = tone.text;
    ctx.textAlign = 'center';
    const title = P.fitLines(ctx, said.title, P.W - 128, 2, 800, [72, 62, 54]);
    title.lines.forEach((line, i) => { ctx.fillText(line, P.W / 2, 220 + i * (title.size + 8)); });
    let y = 220 + (title.lines.length - 1) * (title.size + 8);
    if (said.small) {
      ctx.fillStyle = tone.muted;
      ctx.font = `500 32px ${P.FONT}`;
      ctx.fillText(said.small, P.W / 2, y + 54);
      y += 54;
    }
    const top = y + 56;
    const text = (said.lines.length - 1) * LINE_STEP;
    const box = picture ? drawn(picture) : null;
    const scale = box ? Math.min(1, (LAST_LINE - top - text - UNDER_BIT) / box.h) : 0;
    const [w, h] = box ? [box.w * scale, box.h * scale] : [0, 0];
    const start = top + (LAST_LINE - top - (h + UNDER_BIT + text)) / 2;
    if (box) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(picture, box.x, box.y, box.w, box.h, (P.W - w) / 2, start, w, h);
    }
    ctx.fillStyle = tone.text;
    said.lines.forEach((line, i) => {
      const fit = P.fitLines(ctx, line, P.W - 160, 1, i === 0 ? 700 : 500, i === 0 ? [48, 42, 36] : [40, 36, 32]);
      ctx.fillText(fit.lines[0] || '', P.W / 2, start + h + UNDER_BIT + i * LINE_STEP);
    });
    ctx.textAlign = 'start';
    return canvas;
  }

  // The part of the picture with something drawn in it: the Bit and what it wears, without the
  // empty stage its clips move on, so it sits centred on the card whatever it wears. The whole
  // picture when this browser will not let it be read back.
  function drawn(picture) {
    const whole = { x: 0, y: 0, w: picture.width, h: picture.height };
    const c = document.createElement('canvas');
    c.width = picture.width;
    c.height = picture.height;
    const g = c.getContext('2d');
    g.drawImage(picture, 0, 0);
    let data;
    try { ({ data } = g.getImageData(0, 0, c.width, c.height)); } catch { return whole; }
    let [x0, y0, x1, y1] = [c.width, c.height, -1, -1];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] < 8) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    return x1 < 0 ? whole : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // The card last made of each kind, kept while what it shows stays the same, and the one on
  // show: the sheet draws itself again on every change the server tells.
  let made = {};
  let open = null;
  const keyOf = (kind, rec, bit) => JSON.stringify([kind, rec, bit.number, bit.name, bit.worn, bit.genes, bit.prefs?.pose, bit.page]);

  /**
   * The sheet's part: a button per recap there is, and the card it makes with what to do with it.
   * Nothing when the Bit has no closed month yet.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, note: Function, redraw: Function, signal: AbortSignal }} h the sheet's hands
   */
  function section(bit, h) {
    const recaps = recapsOf(bit);
    if (!recaps.length || !window.BitCard?.paint) return null;
    const box = makeEl('div', 'bitc-part bitc-card bitc-recap');
    const row = makeEl('div', 'bitc-seg');
    const slot = makeEl('div', 'bitc-card-slot');
    const show = (card) => {
      const img = makeEl('img', 'bitc-card-img');
      img.alt = card.title;
      img.src = card.src;
      slot.replaceChildren(img, window.BitCard.paint.actions(card.canvas, h, card.file));
    };
    for (const { kind, rec } of recaps) {
      const said = { ...words(rec, kind, bit, h.say, h.num, code()), tagline: h.say('mybit_share_tagline') };
      const key = keyOf(kind, rec, bit);
      const b = makeEl('button', 'bitc-seg-btn', said.button);
      b.type = 'button';
      b.addEventListener('click', async () => {
        if (made[kind]?.key === key) { open = kind; show(made[kind]); return; }
        b.disabled = true;
        try {
          const canvas = await draw(said, bit);
          if (h.signal.aborted) return;
          made[kind] = { key, canvas, title: said.title, file: said.file, src: canvas.toDataURL('image/png') };
          open = kind;
          if (box.isConnected) show(made[kind]); else h.redraw();
        } catch {
          h.note(h.say('mybit_share_failed'));
        } finally {
          b.disabled = false;
        }
      }, { signal: h.signal });
      row.append(b);
      if (open === kind && made[kind]?.key === key) show(made[kind]);
    }
    box.append(row, slot);
    return box;
  }

  window.BitRecap = { section, words, recapsOf, counted, reset: () => { made = {}; open = null; } };
})();
