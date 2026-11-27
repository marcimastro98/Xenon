'use strict';
// Airflow's engine. Once a second, while Airflow watches ('shadow'), drives ('on')
// or checks the fans, it polls every driver (sense.js), joins what they found with
// the person's choices (inventory.js), lets the fan check (loop-check.js) or the
// brain plan, has the safety layer judge every value, then hands the verdicts to
// the drivers, or only keeps score (shadow.js) while watching. Switched off and
// not checking, it does not tick at all; look() reads the fans once, moving
// nothing, for the menu. A PC with no driver (none: 'platform') never ticks.
// Stopping hands every fan back.
const { createSafety } = require('./safety.js');
const { createBrain } = require('./brain.js');
const { createHealth } = require('./health.js');
const { createShadow } = require('./shadow.js');
const { createFanCheck } = require('./calibrate.js');
const { buildInventory } = require('./inventory.js');
const { mergePolls } = require('./sense.js');
const Check = require('./loop-check.js');
const { statusOf } = require('./loop-status.js');
const { createSaves, SAVE_EVERY_MS } = require('./loop-save.js');
const { createAvailability, AVAILABLE_EVERY_MS } = require('./loop-available.js');
const { createDriverCalls } = require('./loop-drivers.js');
const { createLearning, localDay } = require('./loop-learning.js');

const TICK_MS = 1000;
const STUCK_MS = 10000;   // a tick still running after this hangs: the fans go back to the PC
// A check asked for while no driver answers yet waits this long, then says so.
const CHECK_WAIT_MS = 15000;
// The Windows sensor service reads the fans only while the engine asks: a hello wakes
// it and it answers a few seconds later. Until then it counts as reachable (the menu
// offers the fan check, not a fix) and look() reads again; silent this long, it is not.
const WAKE_MS = 15000;
const WAKE_RETRY_MS = 1500;

/**
 * @param {{ drivers: any[], none?: string|null, store: any, labels?: () => Record<string, string>,
 *   situation?: (now: number) => any, cpuName?: string, parts?: () => any, clock?: () => number,
 *   timers?: { setInterval: Function, clearInterval: Function, setTimeout?: Function, clearTimeout?: Function },
 *   warn?: (msg: string) => void, onStatus?: (status: any) => void, onDriving?: (on: boolean) => void }} opts
 */
function createAirflowLoop({
  drivers, none = null, store, labels = () => ({}), situation = (now) => ({ hour: new Date(now).getHours() }),
  cpuName = '', parts, clock = Date.now, timers = globalThis, warn = (_msg) => {}, onStatus = (_s) => {}, onDriving = (_on) => {},
}) {
  const safety = createSafety({ cpuName, clock });
  const saves = createSaves({ store, warn });
  // Every call to a driver goes through `calls`: one at a time, and a slow one never holds the tick.
  const calls = createDriverCalls({ clock });
  const release = (d) => calls.run(d, (x) => x.release());
  const availability = createAvailability({ drivers, letGo: release });
  const learning = createLearning({ store, parts, warn });
  const st = {
    learned: null, last: null, brain: null, brainKey: '', health: null, shadow: null,
    check: null, wantedAt: null, ended: null, channels: [],
    timer: null, ticking: null, stopping: false, driving: false, restDue: false,
    availAt: -Infinity, usable: [], unavailable: {}, failing: new Set(),
    untrusted: [], status: null, wake: null, again: null,
  };

  async function load() {
    if (st.learned) return;
    st.learned = await store.readLearned();
    st.last = await store.readLast();
    st.health = createHealth({ saved: st.learned.health });
    st.shadow = createShadow({ saved: st.learned.shadow });
    await Promise.all(drivers.map((d) => calls.run(d, (x) => x.clear()).catch(() => {})));
  }

  // One brain per set of driven fans: the learning moves to the new one.
  function brainFor(driven) {
    const key = driven.map((c) => `${c.id}|${c.kind}|${c.place}|${c.maxRpm}|${c.minDuty}`).join(',');
    if (st.brain && key === st.brainKey) return st.brain;
    if (st.brain) Object.assign(st.learned, { brain: st.brain.save(), games: st.brain.memory() });
    const last = st.brain ? st.brain.last() : st.last;
    st.brain = createBrain({ channels: driven, cpuName, memory: st.learned.games, saved: st.learned.brain, last });
    st.brainKey = key;
    return st.brain;
  }

  function brainStep(snap, channels, model, now) {
    const driven = channels.filter((c) => c.controllable);
    const watching = model.drive !== 'on' || model.mode === 'pc';
    const rpm = Object.fromEntries(channels.map((c) => [c.id, c.rpm]));
    const ctx = { ...situation(now), mode: model.mode, slider: model.slider, allowZero: model.options.allowZero, options: model.options, untrusted: st.untrusted, stalled: safety.stalled(), driving: !watching };
    const out = driven.length ? brainFor(driven).tick({ at: now, temps: snap.temps, power: snap.power, rpm, duty: snap.duty }, ctx) : null;
    // Watching, nothing was asked of the fans: a fan the PC stopped is no stall of ours.
    const judged = watching ? driven.map((c) => ({ ...c, hasTach: false })) : driven;
    const verdict = safety.check({
      temps: snap.temps, power: snap.power, channels: judged,
      plan: { at: now, targets: out?.duties || {}, allowZero: model.options.allowZero },
    });
    st.untrusted = verdict.untrusted;
    if (out && model.drive === 'shadow') st.shadow.observe({ at: now, channels, rpm, duties: out.duties, predicted: out.predicted, targets: out.targets });
    learning.observe(st, out && !watching ? driven : [], verdict, now);
    return { verdict, out };
  }

  // Letting go reaches a busy driver too, after its call; a command skips it for the next one.
  async function act(drive, verdict) {
    const letGo = !drive && st.driving;
    await calls.act(st.usable, async (d) => {
      try {
        if (drive) await d.apply(verdict.channels);
        else {
          if (letGo) await d.release();
          await d.hello();
        }
        st.failing.delete(d.id);
      } catch (e) {
        if (!st.failing.has(d.id)) warn(`airflow: the ${d.id} fan driver did not answer (${e.code || e.message})`);
        st.failing.add(d.id);
      }
    }, letGo);
    holding(drive);
  }

  // Whether Xenon holds the fans; the engine's place in the CPU queue follows it (priority.js).
  function holding(on) {
    if (st.driving !== on) onDriving(on);
    st.driving = on;
  }

  // A check asked for starts on the first tick that shows fans to move.
  function beginCheck(snap, channels, model, now) {
    const list = Check.checkChannels(snap.found, model, channels);
    if (!list.length && now - st.wantedAt < CHECK_WAIT_MS) return;
    st.wantedAt = null;
    if (!list.length) { st.ended = { at: now, ok: false, why: 'no-fans' }; return; }
    st.check = createFanCheck({ channels: list, clock });
    st.ended = null;
  }

  async function endCheck(view, channels, now) {
    st.check = null;
    st.ended = { at: now, ok: view.result != null, why: view.why ?? null };
    if (!view.result) return;
    for (const id of Object.keys(view.result.calibs)) st.health.forgetFan(id);
    try { await Check.keepResult(store, view.result, channels, now); }
    catch (e) { warn(`airflow: the fan check could not be saved (${e.code || e.message})`); st.ended = { at: now, ok: false, why: 'save' }; }
  }

  // Reachable: a driver answered, or one that can run was asked only a moment ago.
  function reaching(snap, now) {
    if (snap.answering.length) { st.wake = null; return true; }
    if (!st.usable.length) return false;
    if (!st.wake || now - st.wake.last > WAKE_MS) st.wake = { from: now, last: now };
    st.wake.last = now;
    return now - st.wake.from < WAKE_MS;
  }

  // One reading of every usable driver, joined with the person's choices.
  async function sense(now, model, recheck = false) {
    await load();
    // Only a look (starting, the menu opening) waits for the answers; a tick takes them up
    // when they land (loop-available.js), so a slow check never holds the fans' commands.
    if (recheck || now - st.availAt >= AVAILABLE_EVERY_MS || await availability.soon(st, now, recheck)) availability.start(st, now);
    await availability.settle(st, recheck);
    const polls = await calls.poll(st.usable, recheck);
    const snap = mergePolls(st.usable, polls, now);
    st.channels = buildInventory({ found: snap.found, model, labels: labels(), tachs: snap.tachs });
    return { snap, channels: st.channels };
  }

  async function tickOnce() {
    const now = clock();
    const model = await store.ready();
    const { snap, channels } = await sense(now, model);
    if (st.wantedAt != null) beginCheck(snap, channels, model, now);
    // During the fan check too: a new card first named then must count from before the check.
    await learning.settle(st, channels, now);
    let verdict;
    let out = null;
    let view = null;
    if (st.check) ({ verdict, view } = Check.stepCheck({ check: st.check, snap, safety, now }));
    else ({ verdict, out } = brainStep(snap, channels, model, now));
    await act(st.check != null || (model.drive === 'on' && model.mode !== 'pc'), verdict);
    if (view?.done) await endCheck(view, channels, now);
    publish({ at: now, model: store.peek() || model, channels, verdict, out, view, answering: reaching(snap, now) });
    await saves.due(st, now);
  }

  function publish(s) {
    st.status = {
      ...statusOf({ ...s, driving: st.driving, unavailable: none ? { pc: none } : st.unavailable, shadow: st.shadow, health: st.health, wanted: st.wantedAt != null }),
      checkEnded: st.ended,
    };
    onStatus(st.status);
  }

  function tick() {
    if (st.ticking && !st.stuck && clock() - st.tickAt > STUCK_MS) { st.stuck = true; warn('airflow: a tick hangs, the fans go back to the PC'); letGoAll(); }
    if (st.ticking || st.stopping) return st.ticking;
    Object.assign(st, { tickAt: clock(), stuck: false });
    st.ticking = tickOnce()
      // A tick that broke moved no fan: off Windows nothing else hands them back (no lease there).
      .catch((e) => { warn(`airflow: a tick failed (${e.message})`); return letGoAll(); })
      .finally(() => { st.ticking = null; refresh(); });
    return st.ticking;
  }

  // Every fan back to the PC, what was learned kept.
  const letGoAll = () => Promise.all(drivers.map((d) => release(d).catch(() => {}))).then(() => holding(false));
  async function rest() {
    await letGoAll();
    await saves.all(st, clock());
  }

  /** Ticks while there is something to do; call after any change to the saved choices. */
  function refresh() {
    if (st.stopping) return;
    const model = store.peek();
    const need = drivers.length > 0 && (st.check != null || st.wantedAt != null || (model != null && model.drive !== 'off'));
    if (need) st.restDue = false;
    if (need && !st.timer) {
      st.timer = timers.setInterval(tick, TICK_MS);
      st.timer?.unref?.();
      tick();
    } else if (!need && st.timer) {
      timers.clearInterval(st.timer);
      st.timer = null;
      st.restDue = true;
      if (model && st.learned) publish({ at: clock(), model, channels: st.channels, answering: st.usable.length > 0 });
    }
    // Not while a tick runs: it would hand the fans back under it. Its end calls here again.
    if (st.restDue && !st.ticking) {
      st.restDue = false;
      rest().catch(() => {});
    }
  }

  /** Reads the fans once, moving nothing (the menu opening; ticks already do it). */
  async function look() {
    if (st.timer || st.ticking || st.stopping) return st.status;
    const now = clock();
    const model = await store.ready();
    const { snap, channels } = await sense(now, model, true);
    // A hello holds no fan: it only has a sleeping service read them.
    const asleep = st.usable.filter((d) => !snap.answering.includes(d.id));
    await Promise.all(asleep.map((d) => calls.run(d, (x) => x.hello()).catch(() => {})));
    const answering = reaching(snap, now);
    publish({ at: now, model, channels, answering });
    if (!snap.answering.length && answering) lookAgain();
    return st.status;
  }

  function lookAgain() {
    if (st.again || !timers.setTimeout) return;
    st.again = timers.setTimeout(() => { st.again = null; return look().catch(() => {}); }, WAKE_RETRY_MS);
    st.again?.unref?.();
  }

  return {
    async start() { await look(); refresh(); },
    refresh,
    look,
    /** Starts the fan check (an explicit request: it moves every fan for a few minutes). */
    startCheck() {
      if (!drivers.length) return { ok: false, why: none || 'platform' };
      if (st.check || st.wantedAt != null) return { ok: false, why: 'running' };
      st.wantedAt = clock();
      st.ended = null;
      // A driver taken only while Airflow works (the LINK hub) can join the check now.
      st.availAt = -Infinity;
      refresh();
      return { ok: true, why: null };
    },
    /** The drivers are asked again on the next tick: a choice changed what one may take. */
    recheck() { st.availAt = -Infinity; },
    /** Whether a fan check is asked for or running. */
    checking: () => st.check != null || st.wantedAt != null,
    cancelCheck() { st.wantedAt = null; st.check?.cancel('cancel'); },
    status: () => st.status,
    /** Learns this PC again from scratch (a new cooler, case or fans): the choices and fan checks stay. */
    async relearn() {
      await st.ticking;
      await load();
      learning.forgetAll(st);
      await saves.learned(st, clock());
    },
    /** The person cleaned the dust filters today: what cleaning gained is measured from here. */
    cleaned() {
      if (!st.health) return false;
      st.health.cleanedOn(localDay(clock()));
      saves.learned(st, clock());
      return true;
    },
    async stop() {
      st.stopping = true;
      if (st.timer) timers.clearInterval(st.timer);
      if (st.again) timers.clearTimeout?.(st.again);
      Object.assign(st, { timer: null, again: null });
      st.check?.cancel('stop');
      await st.ticking;
      await rest();
    },
  };
}

module.exports = { createAirflowLoop, TICK_MS, SAVE_EVERY_MS, CHECK_WAIT_MS, WAKE_MS, WAKE_RETRY_MS };
