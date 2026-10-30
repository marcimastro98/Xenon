'use strict';
// The steps recorder: while it runs, every click on the PC becomes a step (a
// picture of that screen with a ring where the click landed, what was clicked,
// in which app), taken by the capture engine (apps/capture, `steps`). At the
// end the steps become a document (steps-doc.js) in
// <Documents>/Xenon/Steps/<date time>/: steps.html with the pictures inside,
// steps.md beside them. One recording at a time. The folder's path stays here:
// callers get the folder's name, and "open" / "show" act on the last document
// this server wrote.
//
// It ends on stop, from the pill at the top of the screen ("closed"), at 100
// steps ("full"), after 20 minutes without a click ("idle"), or when the
// engine fails; the engine says so with a `steps_ended` event line, or the host
// reports `engine_exited`. What was recorded is written either way. No step,
// no document: the empty folder is removed.

const path = require('path');
const StepsDoc = require('./steps-doc');

const START_TIMEOUT_MS = 10000;
const PASS_THROUGH = new Set(['unavailable', 'unsupported', 'engine_failing', 'hook_failed', 'write_failed']);

const pad = n => String(n).padStart(2, '0');
function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// A remembered document is the steps.html of a folder named after itself.
function knownDoc(v) {
  if (!v || typeof v.dir !== 'string' || typeof v.html !== 'string' || typeof v.name !== 'string') return false;
  return path.isAbsolute(v.html) && path.basename(v.html) === 'steps.html'
    && path.dirname(v.html) === v.dir && path.basename(v.dir) === v.name && v.name !== '';
}

function createStepsRecorder({
  host, root, mkdir, readFile, writeFile, rename, rmdir,
  words = async () => ({}), badge = async () => '', lang = () => 'en', when = (ms) => new Date(ms).toLocaleString(),
  openFile = () => {}, reveal = () => {}, now = Date.now, onChange = () => {}, onSaved = () => {},
  remember = { load: async () => null, save: () => {} }, exists = async () => true,
}) {
  let run = null;       // { dir, name, since, steps, ending }
  let starting = null;
  let early = null;     // an end that came before the start reply
  let last = null;      // { dir, html, name } of the last document written
  // The one from before a restart (capture-last.js), checked: never a path it did not write.
  const loading = Promise.resolve()
    .then(() => remember.load())
    .then((v) => { if (!last && knownDoc(v)) last = { dir: v.dir, html: v.html, name: v.name }; })
    .catch(() => {});

  const tell = (fn, value) => { try { fn(value); } catch { /* a listener never breaks a recording */ } };

  host.onEvent((ev) => {
    if (!ev || typeof ev.event !== 'string') return;
    if (ev.event === 'steps_ended' || ev.event === 'engine_exited') {
      if (run) finish(ev);
      else if (starting) early = ev;
      return;
    }
    if (!run || run.ending) return;
    if (ev.event === 'step') {
      const step = StepsDoc.normalizeStep(ev);
      if (!step || run.steps.some(s => s.n === step.n)) return;
      run.steps.push(step);
      tell(onChange, { on: true, count: run.steps.length });
    } else if (ev.event === 'step_double') {
      const step = run.steps.find(s => s.n === Number(ev.n));
      if (step) step.double = true;
    }
  });

  async function open() {
    const since = now();
    const name = stampOf(since);
    const dir = path.join(String(await root()), 'Xenon', 'Steps', name);
    try { await mkdir(dir); } catch { return { ok: false, error: 'write_failed' }; }
    let template = '';
    try { template = String(await badge() || ''); } catch { /* the pill shows the bare count */ }
    const reply = await host.request('steps', { action: 'start', dir, badge: template }, { timeoutMs: START_TIMEOUT_MS });
    if (!reply || reply.ok !== true) {
      try { await rmdir(dir); } catch { /* not empty or gone: leave it */ }
      const code = reply && reply.error;
      if (code === 'already_running') return { ok: false, error: 'running' };
      return { ok: false, error: PASS_THROUGH.has(code) ? code : 'failed' };
    }
    run = { dir, name, since, steps: [], ending: null };
    tell(onChange, { on: true, count: 0 });
    return { ok: true, recording: true };
  }

  function start() {
    if (run) return Promise.resolve({ ok: false, error: 'running' });
    if (starting) return Promise.resolve({ ok: false, error: 'starting' });
    if (!host.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    early = null;
    starting = open().catch(() => ({ ok: false, error: 'failed' })).then((result) => {
      starting = null;
      if (run && early) finish(early);
      early = null;
      return result;
    });
    return starting;
  }

  // Writes steps.html and steps.md next to the pictures, each under a
  // temporary name first so a half-written file never carries the real one.
  async function write(r, steps, reason) {
    const w = await words();
    const pics = {};
    for (const s of steps) {
      try { pics[s.file] = (await readFile(path.join(r.dir, s.file))).toString('base64'); } catch { /* a missing picture leaves the text */ }
    }
    const doc = { steps, words: w, when: when(r.since), reason, lang: lang(), images: pics };
    const html = path.join(r.dir, 'steps.html');
    const md = path.join(r.dir, 'steps.md');
    await writeFile(html + '.part', StepsDoc.toHtml(doc));
    await rename(html + '.part', html);
    await writeFile(md + '.part', StepsDoc.toMarkdown(doc));
    await rename(md + '.part', md);
    return { html, texts: steps.map(s => ({ n: s.n, text: StepsDoc.stepText(s, w), app: s.app })) };
  }

  // Ends the recording once, whoever asks first (stop, an event, shutdown).
  function finish(ev) {
    if (!run) return Promise.resolve({ ok: false, error: 'not_recording' });
    if (run.ending) return run.ending;
    const r = run;
    r.ending = (async () => {
      const reason = ev.event === 'engine_exited' ? 'engine_exited' : String(ev.reason || 'stopped');
      const steps = StepsDoc.withTyping(r.steps.slice().sort((a, b) => a.n - b.n), ev.typed === true);
      let result;
      if (!steps.length) {
        try { await rmdir(r.dir); } catch { /* something else is in it: leave it */ }
        result = { ok: false, error: 'no_steps', reason };
      } else {
        try {
          const out = await write(r, steps, reason);
          last = { dir: r.dir, html: out.html, name: r.name };
          try { remember.save(last); } catch { /* remembered in memory either way */ }
          result = { ok: true, saved: true, count: steps.length, folder: r.name, reason, steps: out.texts };
        } catch {
          result = { ok: false, error: 'write_failed', reason, count: steps.length };
        }
      }
      run = null;
      tell(onChange, { on: false, reason, count: steps.length, ...(result.ok ? {} : { error: result.error }) });
      if (result.saved) tell(onSaved, { count: result.count, reason });
      return result;
    })();
    return r.ending;
  }

  async function stop() {
    if (starting) await starting;
    if (!run) return { ok: false, error: 'not_recording' };
    if (run.ending) return run.ending;
    const r = run;
    const reply = await host.request('steps', { action: 'stop' });
    // The engine reports the end before it answers; this is only for an engine that died.
    if (r.ending) return r.ending;
    return finish(reply && reply.ok === true ? { event: 'steps_ended', reason: 'stopped' } : { event: 'engine_exited' });
  }

  async function lastOnDisk() {
    await loading;
    if (!last) return null;
    return (await exists(last.html).catch(() => false)) ? last : null;
  }

  async function openLast() {
    if (!(await lastOnDisk())) return { ok: false, error: 'no_file' };
    openFile(last.html);
    return { ok: true, opened: true, folder: last.name };
  }

  async function revealLast() {
    if (!(await lastOnDisk())) return { ok: false, error: 'no_file' };
    reveal(last.html);
    return { ok: true, shown: true, folder: last.name };
  }

  return {
    start,
    stop,
    toggle: () => (starting ? Promise.resolve({ ok: true, starting: true }) : run ? stop() : start()),
    status: () => (run ? { on: true, count: run.steps.length, since: run.since } : { on: false }),
    open: openLast,
    reveal: revealLast,
    // Shutdown: the steps so far become a document, not lost.
    flush: () => (run || starting ? stop() : Promise.resolve(null)),
  };
}

module.exports = { createStepsRecorder, knownDoc, stampOf, START_TIMEOUT_MS };
