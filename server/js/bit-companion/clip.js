'use strict';
// A moment of the person's own Bit, to post on TikTok, Reels or Shorts: a short vertical video
// of their Bit saying hello, doing its own favourite move and a dance, then striking a pose, in
// its outfit, on the birth card's ground (card.js `paint`) with its name and the site. Drawn
// frame by frame from the engine (Xenon.bit.renderFrame) on a canvas and recorded by the
// browser (MediaRecorder), never a capture of the screen. Made only when asked, in the Bit
// sheet; where this browser cannot record a canvas the sheet does not offer it.
(() => {
  const W = 1080;
  const H = 1920;
  // Words and the Bit stay inside the middle of the frame that TikTok, Reels and Shorts leave
  // uncovered by their own buttons (about 900x1400 of 1080x1920).
  const SAFE = { x: 90, top: 260 };
  const CELL = 48; // pixels per Bit cell: the 18-cell stage is 864 px wide
  const BIT_X = (W - 18 * CELL) / 2;
  const BIT_Y = 590;
  const FLOOR_Y = 11; // bit.js: the Bit is cut at the floor it stands on
  const FPS = 30;
  const BITRATE = 6e6;
  const MIN_MS = 6000;
  // MP4 first: it is what every app takes; WebM where the browser records nothing else.
  const TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const FILL = ['hop', 'spin', 'dance'];

  const code = () => (typeof lang === 'string' ? lang : 'en');

  // The kind of video this browser records from a canvas, or '' when it cannot.
  function recorderType() {
    const R = window.MediaRecorder;
    if (typeof R !== 'function' || typeof R.isTypeSupported !== 'function') return '';
    if (typeof HTMLCanvasElement === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return '';
    return TYPES.find((t) => { try { return R.isTypeSupported(t); } catch { return false; } }) || '';
  }

  // What plays, frame by frame: hello, its quirk, a dance, more moves until six seconds are
  // filled, then the pose it strikes for a photo. Pure: `clipOf` is Xenon.bit.clip.
  function timeline(quirk, clipOf) {
    const lengthOf = (c) => c.frames.reduce((s, f) => s + (Number(f.ms) || 0), 0);
    const usable = (id) => {
      const c = typeof id === 'string' ? clipOf(id) : null;
      return c?.frames?.length && lengthOf(c) > 0 ? c : null;
    };
    const clips = [...new Set(['wave', quirk, 'dance'])].map(usable).filter(Boolean);
    const end = usable('pose');
    const sum = () => clips.reduce((s, c) => s + lengthOf(c), 0) + (end ? lengthOf(end) : 0);
    for (const id of FILL) {
      if (sum() >= MIN_MS) break;
      const c = usable(id);
      if (c) clips.push(c);
    }
    if (end) clips.push(end);
    const steps = [];
    let at = 0;
    for (const c of clips) {
      c.frames.forEach((f, i) => {
        const ms = Number(f.ms) || 0;
        if (ms > 0) { steps.push({ c, i, at, ms }); at += ms; }
      });
    }
    return { steps, total: at };
  }

  const stepAt = (steps, t) => steps.findLast((s) => s.at <= t) || steps[0];

  // One frame of the Bit, as the engine lays it out, in crisp cells at (ox, oy).
  function paintBit(ctx, X, c, i, look, ox, oy) {
    const { STAGE } = X.bit;
    const px = (v, origin) => Math.round((v - origin) * CELL);
    for (const layer of X.bit.renderFrame(c, i, { look }).layers) {
      const t = layer.transform;
      const [sx, sy] = t ? [t.sx, t.sy] : [1, 1];
      const tx = t ? t.dx + t.px - t.px * t.sx : 0;
      const ty = t ? t.dy + t.py - t.py * t.sy : 0;
      ctx.save();
      if (layer.clipFloor) {
        ctx.beginPath();
        ctx.rect(ox, oy, STAGE.w * CELL, (FLOOR_Y - STAGE.y) * CELL);
        ctx.clip();
      }
      for (const r of layer.rects) {
        const [xa, xb] = [px(tx + sx * r.x, STAGE.x), px(tx + sx * (r.x + r.w), STAGE.x)];
        const [ya, yb] = [px(ty + sy * r.y, STAGE.y), px(ty + sy * (r.y + r.h), STAGE.y)];
        ctx.globalAlpha = typeof r.o === 'number' ? r.o : 1;
        ctx.fillStyle = r.fill;
        ctx.fillRect(ox + Math.min(xa, xb), oy + Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya));
      }
      ctx.restore();
    }
  }

  // What stays still under the Bit: the ink, the mark, its name and number, and at the foot
  // the tagline and the site.
  async function groundFor(said, P) {
    const logo = await P.brand();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = P.INK;
    ctx.fillRect(0, 0, W, H);
    if (logo) ctx.drawImage(logo, SAFE.x, SAFE.top, 56, 56);
    ctx.fillStyle = P.TEXT;
    ctx.font = `700 36px ${P.FONT}`;
    ctx.fillText('Xenon', logo ? SAFE.x + 70 : SAFE.x, SAFE.top + 41);
    ctx.textAlign = 'center';
    const big = P.fitLines(ctx, said.big, W - 2 * SAFE.x, 1, 800, [104, 88, 72]);
    ctx.fillText(big.lines[0] || '', W / 2, 470);
    if (said.small) {
      ctx.fillStyle = P.MUTED;
      ctx.fillText(P.fitLines(ctx, said.small, W - 2 * SAFE.x, 1, 500, [38, 34, 30]).lines[0] || '', W / 2, 536);
    }
    ctx.fillStyle = P.TEXT;
    const tag = P.fitLines(ctx, said.tagline, W - 2 * SAFE.x, 2, 600, [42, 38, 34]);
    tag.lines.forEach((line, i) => { ctx.fillText(line, W / 2, 1460 + i * (tag.size + 12)); });
    ctx.fillStyle = P.MUTED;
    ctx.font = `600 40px ${P.FONT}`;
    ctx.fillText('xenon-app.com', W / 2, 1600);
    return canvas;
  }

  // Plays the timeline on a canvas while the browser records it; `live` gets the canvas as it
  // plays. Stops early, with nothing kept, when the sheet closes.
  async function record(bit, said, type, signal, live) {
    const X = window.Xenon;
    const P = window.BitCard.paint;
    const look = X.bitLook.lookOf(bit.genes, { worn: X.bitWardrobe.outfit(bit.worn || []), background: P.INK });
    const { steps, total } = timeline(bit.genes?.quirk, X.bit.clip);
    if (!total) throw new Error('no_clip');
    const base = await groundFor(said, P);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const paintAt = (t) => {
      ctx.drawImage(base, 0, 0);
      const s = stepAt(steps, t);
      paintBit(ctx, X, s.c, s.i, look, BIT_X, BIT_Y);
    };
    paintAt(0);
    live(canvas);
    const stream = canvas.captureStream(FPS);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: BITRATE });
    const stopped = new Promise((resolve, reject) => {
      rec.addEventListener('dataavailable', (e) => { if (e.data?.size) chunks.push(e.data); });
      rec.addEventListener('stop', resolve, { once: true });
      rec.addEventListener('error', (e) => reject(e.error || new Error('record_failed')), { once: true });
    });
    rec.start();
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const t = performance.now() - t0;
        if (t >= total || signal.aborted) { resolve(); return; }
        paintAt(t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    try { await stopped; } finally { for (const track of stream.getTracks()) track.stop(); }
    if (signal.aborted) throw new Error('aborted');
    if (!chunks.length) throw new Error('record_failed');
    return new Blob(chunks, { type: type.split(';')[0] });
  }

  // Save and share, where this browser can (no copy: a clipboard takes no video).
  function saveRow(clip, h) {
    const row = makeEl('div', 'bitc-seg');
    const add = (key, run) => {
      const b = makeEl('button', 'bitc-seg-btn', h.say(key));
      b.type = 'button';
      b.addEventListener('click', run, { signal: h.signal });
      row.append(b);
    };
    const S = window.XenonSaveFile;
    const ext = clip.file.slice(clip.file.lastIndexOf('.'));
    if (S) {
      add('mybit_clip_save', () => S.save({ name: clip.file, types: [{ description: 'Video', accept: { [clip.blob.type]: [ext] } }], make: async () => clip.blob })
        .catch(() => h.note(h.say('save_file_failed'))));
    }
    const file = typeof File === 'function' ? new File([clip.blob], clip.file, { type: clip.blob.type }) : null;
    if (file && navigator.canShare?.({ files: [file] })) {
      add('sharecard_share', () => navigator.share({ files: [file], title: 'Xenon' }).catch(() => {}));
    }
    return row;
  }

  // The video last made, kept while the Bit it shows stays the same, and the one being made:
  // the sheet draws itself again on every change the server tells.
  let made = null; // { key, blob, url, file }
  let busy = null; // { canvas }
  const keyOf = (bit) => JSON.stringify([bit.number, bit.name, bit.worn, bit.genes]);

  /**
   * The sheet's part: a button that makes the video, then the video and what to do with it.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, note: Function, redraw: Function, signal: AbortSignal }} h the sheet's hands
   */
  function section(bit, h) {
    const X = window.Xenon;
    const type = recorderType();
    if (!type || !window.BitCard?.paint || !X?.bit || !X.bitLook || !X.bitWardrobe || !bit.genes) return null;
    const box = makeEl('div', 'bitc-part bitc-card bitc-clip');
    const slot = makeEl('div', 'bitc-card-slot');
    box.append(slot);
    const key = keyOf(bit);
    const live = (canvas) => {
      canvas.className = 'bitc-clip-video';
      canvas.setAttribute('aria-label', h.say('mybit_clip_alt'));
      const wait = makeEl('button', 'bitc-seg-btn', h.say('mybit_clip_making'));
      wait.type = 'button';
      wait.disabled = true;
      slot.replaceChildren(canvas, wait);
    };
    if (busy) { live(busy.canvas); return box; }
    if (made?.key === key) {
      const video = makeEl('video', 'bitc-clip-video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      // With less motion asked for, it waits for a tap on play.
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      video.autoplay = !still;
      video.controls = still;
      video.setAttribute('aria-label', h.say('mybit_clip_alt'));
      video.src = made.url;
      slot.replaceChildren(video, saveRow(made, h));
      return box;
    }
    const go = makeEl('button', 'bitc-seg-btn', h.say('mybit_clip_make'));
    go.type = 'button';
    go.addEventListener('click', async () => {
      go.disabled = true;
      const said = window.BitCard.words(bit, h.say, h.num, () => '', code());
      let failed = false;
      try {
        const blob = await record(bit, said, type, h.signal, (canvas) => { busy = { canvas }; live(canvas); });
        reset();
        made = { key, blob, url: URL.createObjectURL(blob), file: `my-bit.${blob.type === 'video/mp4' ? 'mp4' : 'webm'}` };
      } catch {
        failed = true;
      }
      busy = null;
      if (h.signal.aborted) return;
      h.redraw();
      // After the redraw, which lays a new, empty note.
      if (failed) h.note(h.say('mybit_clip_failed'));
    }, { signal: h.signal });
    slot.append(go);
    return box;
  }

  function reset() {
    if (made?.url) URL.revokeObjectURL(made.url);
    made = null;
  }

  window.BitClip = { section, timeline, recorderType, reset };
})();
