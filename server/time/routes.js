// What the engine answers for the timers, the notes and their lists, the calendar events and
// the tasks.

const { readBody } = require('../http/read-body.js');
const { notesToText, NOTE_BODY_MAX, textToNotesState } = require('./notes-state.js');
const listOps = require('../list-ops.js');
const { EVENT_EDIT_FIELDS } = require('./events-normalize.js');
const { TASK_EDIT_FIELDS } = require('./tasks-normalize.js');
const { timerState } = require('./timer-list.js');
const { TIMERS_MAX } = require('./timer-values.js');
const { _normalizeTimer } = require('./timer-normalize.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { agendaState } = require('./agenda-state.js');
const { readEvents, readTasks } = require('./store-read.js');
const { EXTERNAL_FEEDS_INTERVAL_MS } = require('../ticker/feeds-interval.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /notes/list': async (_req, _res, { json, err500 }, { readNotes }) => {
    // Structured multi-note store — used by the web dashboard notes widget.
    readNotes()
      .then(state => json(state))
      .catch(e => err500(e.message));
  },

  'POST /notes/list': async (req, _res, { json, err500 }, { saveNotesGuarded }) => {
    try {
      const body = JSON.parse(await readBody(req));
      // Stale-write guard (serialized in saveNotesGuarded): a save carries the
      // rev it was based on. A surface that missed newer saves would clobber
      // fresher content — refuse it and hand back the authoritative state (the
      // client rebases or adopts it). Absent baseRev (legacy/SDK callers)
      // keeps last-writer-wins as before. normalizeNotesState (inside
      // writeNotes) rebuilds from known keys and caps sizes, so a tampered
      // payload can't smuggle bad shapes or exhaust disk.
      json(await saveNotesGuarded(body));
    } catch (e) { err500(e.message); }
  },

  'GET /notes': async (_req, _res, { json, err500 }, { readNotes }) => {
    // Read only. A GET that saved (?save=&data=) let any link or <img> replace
    // every note with one; saving is POST now.
    // Legacy flat-text read. Flatten the structured store.
    readNotes()
      .then(state => json({ notes: notesToText(state) }))
      .catch(e => err500(e.message));
  },

  'POST /notes': async (req, _res, { json, err500 }, { writeNotes }) => {
    try {
      const body = JSON.parse(await readBody(req));
      const notes = typeof body.notes === 'string' ? body.notes : (typeof body.text === 'string' ? body.text : '');
      // Legacy flat-text save (iCUE widget). Replaces the store with a single note.
      const safe = String(notes).slice(0, NOTE_BODY_MAX);
      writeNotes(textToNotesState(safe))
        .then(() => json({ ok: true, savedAt: Date.now() }))
        .catch(e => err500(e.message));
    } catch (e) { err500(e.message); }
  },

  'POST /events': async (req, res, { json, err500 }, { updateEvents, writeEvents }) => {
    try {
      const body = JSON.parse(await readBody(req));
      // The dashboard sends one edit (list-ops.js), applied to the list on disk.
      // A whole list is still taken from a page that loaded before this build.
      if (listOps.isListOp(body)) {
        let bad = '';
        const r = await updateEvents((events) => {
          const o = listOps.applyListOp(events, body, EVENT_EDIT_FIELDS);
          if (o.error) { bad = o.error; return null; }
          return o.changed ? { next: o.list } : null;
        });
        if (bad) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: bad }));
        } else json({ ok: true, events: r.events, seq: r.seq, savedAt: Date.now() });
      } else if (Array.isArray(body) || (body && Array.isArray(body.events))) {
        const events = await writeEvents(body.events || body);
        json({ ok: true, events, savedAt: Date.now() });
      } else {
        // Neither an edit this build knows nor a list: never read it as an
        // empty list, which would delete every event.
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'bad_op' }));
      }
    } catch (e) { err500(e.message); }
  },

  'POST /tasks': async (req, res, { json, err500 }, { updateTasks, writeTasks }) => {
    try {
      const body = JSON.parse(await readBody(req));
      // One edit at a time, as for the events above.
      if (listOps.isListOp(body)) {
        let bad = '';
        const r = await updateTasks((tasks) => {
          const o = listOps.applyListOp(tasks, body, TASK_EDIT_FIELDS);
          if (o.error) { bad = o.error; return null; }
          return o.changed ? { next: o.list } : null;
        });
        if (bad) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: bad }));
        } else json({ ok: true, tasks: r.tasks, seq: r.seq, savedAt: Date.now() });
      } else if (Array.isArray(body) || (body && Array.isArray(body.tasks))) {
        const tasks = await writeTasks(body.tasks || body);
        json({ ok: true, tasks, savedAt: Date.now() });
      } else {
        // Neither an edit this build knows nor a list: never read it as an
        // empty list, which would delete every task.
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'bad_op' }));
      }
    } catch (e) { err500(e.message); }

  // ── Timers API ────────────────────────────────────────────────────────────
  },

  'GET /api/timers': async (_req, _res, { json }) => {
    json({ timers: timerState.list });
  },

  'POST /api/timers': async (req, res, { json, err500 }, { _saveTimers }) => {
    try {
      const body = JSON.parse(await readBody(req));
      if (timerState.list.length >= TIMERS_MAX) { res.writeHead(400); res.end(JSON.stringify({ error: 'max timers reached' })); return; }
      // No duration means a stopwatch — which is also how the tile creates one,
      // by leaving the field empty rather than growing a second button.
      const kind = body.kind === 'stopwatch' || (body.kind == null && !Number(body.duration_secs))
        ? 'stopwatch' : 'countdown';
      const timer = _normalizeTimer({
        label: String(body.label || (kind === 'stopwatch' ? 'Stopwatch' : 'Timer')).trim(),
        kind,
        durationSecs: Math.max(1, Math.round(Number(body.duration_secs) || 60)),
        intervalSecs: Math.max(0, Math.round(Number(body.interval_secs) || 0)),
        status: 'running',
        startedAt: Date.now(),
        pausedElapsed: 0,
      });
      timerState.list.push(timer);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: timerState.list });
      json({ timer });
    } catch (e) { err500(e.message); }
  },

  'GET /events': async (_req, _res, { json, err500 }) => {
    // Read only. Saving used to be possible as a GET (?save=&data=), which any
    // link or <img> could fire to replace the whole calendar; it is POST now.
    try { const seq = agendaState.eventsSeq; json({ events: await readEvents(), seq }); }
    catch (e) { err500(e.message); }
  },

  'GET /external-events': async (_req, _res, { json, err500, urlObj }, { refreshExternalFeeds }) => {
    try {
      // The periodic refresh is gated on connected clients, so after boot or an
      // idle stretch the cache can be cold: never-filled → fetch now (there is
      // nothing to serve anyway); merely stale → serve it, refresh in background.
      if (urlObj.searchParams.has('refresh') || agendaState.externalFeeds.refreshedAt === 0) await refreshExternalFeeds();
      else if (Date.now() - agendaState.externalFeeds.refreshedAt > EXTERNAL_FEEDS_INTERVAL_MS) {
        refreshExternalFeeds().catch(() => {});
      }
      json({ feeds: agendaState.externalFeeds.feeds, events: agendaState.externalFeeds.events, refreshedAt: agendaState.externalFeeds.refreshedAt });
    } catch (e) { err500(e.message); }
  },

  'POST /external-events/refresh': async (_req, _res, { json, err500 }, { refreshExternalFeeds }) => {
    try { await refreshExternalFeeds(); json({ ok: true, feeds: agendaState.externalFeeds.feeds, refreshedAt: agendaState.externalFeeds.refreshedAt }); }
    catch (e) { err500(e.message); }
  },

  'GET /tasks': async (_req, _res, { json, err500 }) => {
    try { const seq = agendaState.tasksSeq; json({ tasks: await readTasks(), seq }); }
    catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
