'use strict';
// Which drivers Airflow's engine (loop.js) can use now, asked of each driver. Every driver
// is asked once a minute. A driver waiting on something the person fixes with one
// confirmation (the Windows sensor service installed or updated) is asked alone every few
// seconds, so its fans come back as soon as it answers: on a real PC the board's fans
// stayed with a loud BIOS for up to a minute after the update (23 Nov 2026). Asking it is
// one small file read; the others (a USB scan, the running apps) wait for the minute.
// A tick waits for answers at most WAIT_MS and takes them up at a later tick (only a look
// waits for them to the end): on a PC busy on every core the service's heartbeat read and the look at the
// running apps took seconds (23 Nov 2026), and a fan given no command for five seconds
// goes back to the PC.
const { within } = require('./within.js');

const AVAILABLE_EVERY_MS = 60000;
const SOON_EVERY_MS = 5000;
const SOON_WHYS = Object.freeze(['outdated', 'no-service']);
const WAIT_MS = 250;

/** @typedef {{ ok: boolean, why: string|null }} Answer */

/**
 * `letGo` hands a dropped driver's fans back; the tick never waits for it (loop-drivers.js
 * runs it after the call the driver is busy with).
 * @param {{ drivers: any[], waitMs?: number, letGo?: (d: any) => Promise<void> }} deps
 */
function createAvailability({ drivers, waitMs = WAIT_MS, letGo = (d) => d.release() }) {
  let soonAt = -Infinity;
  /** @type {Promise<void> | null} the waiting drivers asked, not answered yet */
  let soonAsking = null;
  let soonYes = false;
  /** @type {Promise<void> | null} every driver asked, not answered yet */
  let asking = null;
  /** @type {Answer[] | null} their answers, not taken up yet */
  let landed = null;
  /** @param {any[]} list @returns {Promise<Answer[]>} */
  const ask = (list) => Promise.all(list.map((d) => d.available().catch(() => ({ ok: false, why: 'error' }))));
  /** @param {Promise<void>} p @param {boolean} all */
  const wait = (p, all) => (all ? p : within(p, waitMs));

  return {
    /**
     * Whether a driver that waited on the person answers now; an answer that lands late is
     * told at a later call, once. `all` waits for it to the end.
     * @param {any} st @param {number} now @param {boolean} [all]
     */
    async soon(st, now, all = true) {
      if (!soonAsking && now - soonAt >= SOON_EVERY_MS) {
        const waiting = drivers.filter((d) => SOON_WHYS.includes(st.unavailable[d.id]));
        if (waiting.length) {
          soonAt = now;
          soonAsking = ask(waiting).then((a) => { if (a.some((x) => x.ok)) soonYes = true; }).finally(() => { soonAsking = null; });
        }
      }
      if (soonAsking) await wait(soonAsking, all);
      const yes = soonYes;
      soonYes = false;
      return yes;
    },
    /** Every driver asked, unless a check is still out. @param {any} st @param {number} now */
    start(st, now) {
      if (asking) return;
      st.availAt = now;
      asking = ask(drivers).then((a) => { landed = a; }).finally(() => { asking = null; });
    },
    /**
     * The answers taken up once they land: the usable kept, the others with their reason;
     * one dropped lets its fans go. `all` waits for them to the end.
     * @param {any} st @param {boolean} all
     */
    async settle(st, all) {
      if (asking) await wait(asking, all);
      if (!landed) return;
      const answers = landed;
      landed = null;
      const before = st.usable;
      st.usable = drivers.filter((_, i) => answers[i].ok);
      for (const d of before) if (!st.usable.includes(d)) letGo(d).catch(() => {});
      st.unavailable = Object.fromEntries(drivers.map((d, i) => [d.id, answers[i].why]).filter(([, why]) => why));
    },
  };
}

module.exports = { createAvailability, AVAILABLE_EVERY_MS, SOON_EVERY_MS, SOON_WHYS, WAIT_MS };
