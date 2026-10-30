'use strict';
// A video's words in the gallery's viewer (js/capture-gallery-viewer.js loads
// this on the first "Transcript" tap). On the PC a video with no transcript is
// written down at once (POST /captures/transcribe, whisper on this PC) and the
// progress arrives over SSE `transcript`; a paired phone only reads one that
// exists. Then: the summary and chapters Bit wrote, every line with its time
// (a tap jumps the video there, the line being said is marked), "Chapters with
// Bit" (asks Bit in the chat to write them) and the subtitles as a .srt file.
(function () {
  const el = (tag, cls, text) => makeEl(tag, cls, text);
  const ERRORS = {
    whisper_missing: ['capg_tx_err_whisper', 'This needs the local speech recognition: Settings, Xenon AI, Whisper'],
    no_audio: ['capg_tx_err_no_audio', 'This video was recorded without sound'],
    busy: ['capg_tx_err_busy', 'Another video is being written down, try again in a moment'],
    too_long: ['capg_tx_err_too_long', 'Videos over 2 hours cannot be written down'],
  };

  // The index of the line being said at `t` seconds, or -1.
  function lineAt(lines, t) {
    let lo = 0;
    let hi = lines.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return hit >= 0 && t <= lines[hit].end + 1 ? hit : -1;
  }

  // "1:05" for the list; the same clock as the server's.
  function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // opts: before (the element the panel goes in front of), entry, url(path),
  // tr(key, fallback), remote, video() → the <video>, errorText(code),
  // askBit(text) or null where Bit's chat is not on this screen.
  function open(opts) {
    const o = opts;
    const e = o.entry;
    const panel = el('section', 'capg-tx');
    panel.setAttribute('aria-label', o.tr('capg_tx_button', 'Transcript'));
    const status = el('div', 'capg-tx-status');
    status.setAttribute('role', 'status');
    const body = el('div', 'capg-tx-body');
    const foot = el('div', 'capg-tx-foot');
    panel.append(status, body, foot);
    o.before.parentNode.insertBefore(panel, o.before);
    let rows = [];
    let lines = [];
    let now = -1;
    let working = false;
    let closed = false;

    const say = (text, bad) => { status.textContent = text || ''; status.classList.toggle('is-bad', !!bad); };
    function sayError(code) {
      const [k, fb] = ERRORS[code] || o.errorText(code);
      say(o.tr(k, fb), true);
    }

    function seek(at) {
      const v = o.video();
      if (!v) return;
      v.currentTime = at;
      v.play().catch(() => { /* the user presses play */ });
    }

    function timed(cls, at, text) {
      const b = el('button', cls);
      b.type = 'button';
      b.append(el('span', 'capg-tx-at', clock(at)), el('span', 'capg-tx-text', text));
      b.addEventListener('click', () => seek(at));
      return b;
    }

    function paint(t) {
      lines = t.lines;
      say('');
      body.replaceChildren();
      if (t.summary) body.appendChild(el('p', 'capg-tx-summary', t.summary));
      if (t.chapters.length) {
        const ch = el('div', 'capg-tx-chapters');
        ch.appendChild(el('div', 'capg-tx-label', o.tr('capg_tx_chapters', 'Chapters')));
        for (const c of t.chapters) ch.appendChild(timed('capg-tx-chapter', c.at, c.title));
        body.appendChild(ch);
      }
      if (!lines.length) say(o.tr('capg_tx_empty', 'No words were heard in this video'));
      const list = el('div', 'capg-tx-lines');
      rows = lines.map(l => timed('capg-tx-line', l.start, l.text));
      list.append(...rows);
      body.appendChild(list);
      now = -1;
      follow();
      foot.replaceChildren();
      if (lines.length && o.askBit) {
        const ask = el('button', 'ui-btn ui-btn--secondary', o.tr('capg_tx_ask_bit', 'Chapters with Bit'));
        ask.type = 'button';
        ask.addEventListener('click', () => o.askBit(o.tr('capg_tx_bit_prompt', 'Read the transcript of the video "{name}", write a short summary and split it into chapters, then save them.').replace('{name}', e.name || '')));
        foot.appendChild(ask);
      }
      if (lines.length) {
        const srt = el('a', 'ui-btn ui-btn--secondary', o.tr('capg_tx_srt', 'Subtitles (.srt)'));
        srt.href = o.url('/captures/transcript?id=' + encodeURIComponent(e.id) + '&format=srt');
        srt.setAttribute('download', '');
        foot.appendChild(srt);
      }
    }

    // Marks the line being said and keeps it in view.
    function follow() {
      const v = o.video();
      if (!v || !rows.length) return;
      const at = lineAt(lines, v.currentTime);
      if (at === now) return;
      if (rows[now]) rows[now].classList.remove('is-now');
      now = at;
      if (rows[now]) {
        rows[now].classList.add('is-now');
        if (!v.paused) rows[now].scrollIntoView({ block: 'nearest' });
      }
    }
    const video = o.video();
    if (video) video.addEventListener('timeupdate', follow);

    const progress = (pct) => say(o.tr('capg_tx_working', 'Writing down what is said: {pct}%').replace('{pct}', String(pct || 0)));

    async function load() {
      const t = await apiJson(o.url('/captures/transcript?id=' + encodeURIComponent(e.id)));
      if (closed) return;
      if (t && t.ok === true) { working = false; paint(t); return; }
      if (!t || t.error !== 'no_transcript') { sayError(t && t.error); return; }
      working = true;
      progress(0);
      const r = await apiJson(o.url('/captures/transcribe'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: e.id }),
      });
      if (closed) return;
      if (!r || r.ok !== true) { working = false; sayError(r && r.error); }
    }

    // SSE `transcript`: { id, state: working|done|failed|chapters, progress, error }.
    function onState(ev) {
      if (closed || !ev || ev.id !== e.id) return;
      if (ev.state === 'working') { working = true; progress(ev.progress); return; }
      if (ev.state === 'failed') { working = false; sayError(ev.error); return; }
      if (ev.state === 'done' || ev.state === 'chapters') load();
    }

    function close() {
      closed = true;
      if (video) video.removeEventListener('timeupdate', follow);
      panel.remove();
    }

    load();
    return { close, onState, working: () => working };
  }

  const exported = { open, lineAt, clock };
  if (typeof window !== 'undefined') window.CaptureTranscript = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
