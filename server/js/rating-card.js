'use strict';
// A vote on a Store entry: five stars, a short "what went wrong" on a low one, and
// ten seconds to take it back. A vote is final on the hub, so the wait happens here,
// before anything is sent. The same control sits in Bit's card (card) and on the
// Store page (voter); what to show and when is js/bit-messages.js and
// js/community-gallery.js. Names come from a catalog, so all text is textContent.
(function () {
  const HOLD_S = 10;
  const LEAVE_MS = 45000;   // an untouched card goes, and may come back once in a week
  const THANKS_MS = 4000;
  const LOW_STARS = 3;
  const DAY = 24 * 3600 * 1000;
  const WHY = ['breaks', 'slow', 'dislike', 'useless'];
  const STAR = 'M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z';
  const SVG = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick) {
    const node = el('button', cls, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function icon(d, box) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', box);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  // Filled up to `stars`, for a vote that is already in.
  function given(stars) {
    const row = el('span', 'rc-given');
    for (let n = 1; n <= 5; n++) {
      const star = el('span', n <= stars ? 'rc-star on' : 'rc-star');
      star.append(icon(STAR, '0 0 24 24'));
      row.append(star);
    }
    return row;
  }

  // o: { tr, vote(stars, why) -> Promise<{ok}>, picked(), undone(), voted(stars), failed(out) }
  function voter(host, o) {
    const root = el('div', 'rc-voter');
    const row = el('div', 'rc-stars');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', o.tr('rate_stars_label'));
    const extra = el('div', 'rc-extra');
    root.append(row, extra);
    host.append(root);

    let stars = 0;
    let why = '';
    let left = HOLD_S;
    let timer = 0;

    const stopCount = () => { clearInterval(timer); timer = 0; };

    function light(upTo) {
      [...row.children].forEach((star, i) => star.classList.toggle('on', i < upTo));
    }

    function drawWhy() {
      const box = el('div', 'rc-why');
      const ask = el('div', 'rc-why-ask', `${o.tr('rate_what')} `);
      ask.append(el('span', null, o.tr('rate_optional')));
      const grid = el('div', 'rc-why-grid');
      for (const key of WHY) {
        const b = button('rc-why-key', o.tr(`rate_why_${key}`), () => {
          why = why === key ? '' : key;
          draw();
          count();
        });
        b.setAttribute('aria-pressed', String(why === key));
        grid.append(b);
      }
      box.append(ask, grid);
      return box;
    }

    function draw() {
      light(stars);
      extra.replaceChildren();
      if (!stars) return;
      if (stars <= LOW_STARS) extra.append(drawWhy());
      const foot = el('div', 'rc-foot');
      foot.append(el('p', 'rc-left', o.tr('rate_hold').replace('{n}', left)), button('rc-undo', o.tr('rate_undo'), undo));
      extra.append(foot);
    }

    function paintLeft() {
      const line = extra.querySelector('.rc-left');
      if (line) line.textContent = o.tr('rate_hold').replace('{n}', left);
    }

    async function send() {
      stopCount();
      root.classList.add('is-sending');
      const out = await o.vote(stars, stars <= LOW_STARS ? why : '');
      root.classList.remove('is-sending');
      if (out && out.ok) o.voted(stars);
      else o.failed(out);
    }

    function count() {
      stopCount();
      left = HOLD_S;
      paintLeft();
      timer = setInterval(() => {
        left -= 1;
        paintLeft();
        if (left <= 0) send();
      }, 1000);
    }

    function undo() {
      stopCount();
      stars = 0;
      why = '';
      left = HOLD_S;
      draw();
      if (o.undone) o.undone();
    }

    for (let n = 1; n <= 5; n++) {
      const star = button('rc-star', undefined, () => {
        stars = n;
        if (n > LOW_STARS) why = '';
        left = HOLD_S;
        draw();
        count();
        if (o.picked) o.picked();
      });
      star.setAttribute('aria-label', `${n}/5`);
      star.append(icon(STAR, '0 0 24 24'));
      star.addEventListener('pointerenter', () => light(n));
      star.addEventListener('pointerleave', () => light(stars));
      row.append(star);
    }

    return { destroy() { stopCount(); root.remove(); } };
  }

  // h: { tr, vote(stars, why), pin(), close(), done() }
  function card(msg, h) {
    const root = el('div', 'bm-card rc-card');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', msg.title);
    let leave = 0;
    let control = null;

    function remove() {
      clearTimeout(leave);
      if (control) control.destroy();
      control = null;
      root.remove();
    }

    function leaveLater() {
      clearTimeout(leave);
      leave = setTimeout(() => { remove(); h.done(); }, LEAVE_MS);
    }

    function thanks(title, line) {
      clearTimeout(leave);
      if (control) control.destroy();
      control = null;
      root.replaceChildren();
      root.setAttribute('role', 'status');
      const words = el('div', 'rc-done', title);
      if (line) words.append(el('small', null, line));
      root.append(words);
      leave = setTimeout(() => { remove(); h.done(); }, THANKS_MS);
    }

    const top = el('div', 'rc-top');
    if (msg.media && msg.media.url) {
      const shot = el('img');
      shot.alt = '';
      shot.decoding = 'async';
      shot.addEventListener('error', () => {
        if (shot.src.endsWith('.webp')) shot.src = shot.src.replace(/\.webp$/, '.png');
        else shot.remove();
      });
      shot.src = msg.media.url;
      top.append(shot);
    } else {
      top.classList.add('is-bare');
    }
    const words = el('div', 'rc-words');
    const days = Math.max(1, Math.floor((Date.now() - (msg.since || msg.at)) / DAY));
    words.append(el('div', 'rc-name', msg.title), el('div', 'rc-line', h.tr('rate_ask').replace('{n}', days)));
    const close = button('rc-x', undefined, () => { remove(); h.close(); });
    close.setAttribute('aria-label', h.tr('rate_close'));
    close.append(icon('M3 3l12 12M15 3L3 15', '0 0 18 18'));
    top.append(words, close);
    root.append(top);

    control = voter(root, {
      tr: h.tr,
      vote: h.vote,
      picked: () => { clearTimeout(leave); h.pin(); },
      undone: leaveLater,
      voted: (stars) => {
        const line = h.tr(stars === 1 ? 'rate_done_one' : 'rate_done_many')
          .replace('{n}', stars).replace('{name}', msg.title);
        thanks(h.tr('rate_done'), line);
      },
      failed: () => thanks(h.tr('gallery_rating_error')),
    });

    // Someone reading it is not someone ignoring it.
    root.addEventListener('pointerenter', () => clearTimeout(leave));
    root.addEventListener('pointerleave', () => { if (!root.querySelector('.rc-foot, .rc-done')) leaveLater(); });

    document.body.append(root);
    leaveLater();
    return remove;
  }

  window.XenonRatingCard = Object.freeze({ card, voter, given });
})();
