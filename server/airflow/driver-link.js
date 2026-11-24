'use strict';
// Airflow's driver for the CORSAIR iCUE LINK System Hub: its fans and pump, straight
// over USB (corsair-link-session.js). The hub runs the profile iCUE saved in it
// ("hardware mode") until a program takes it into software mode; then it runs only
// what it is told, and 20-30 s after the last command it goes back to its profile by
// itself (measured on a real hub). That is the hub's own lease: if the engine dies, the
// hub takes over.
//
// Taking the hub turns its lights off (it lights itself only in hardware mode): Xenon
// paints them while it holds the hub (link-lights.js). It is taken only while the person
// wants Xenon to (wanted) and no other program talks to it (link-busy.js). Its readings need software mode too. A channel Xenon does not
// drive follows a prudent curve on the liquid's temperature, since the saved profile
// does not run in software mode; release() gives the hub back to its profile.
const P = require('./corsair-link-protocol.js');
const { createLinkSession } = require('./corsair-link-session.js');
const { linkDevice } = require('./corsair-link-devices.js');
const { fanId } = require('./inventory.js');
const { PUMP_FLOOR, COMPONENTS } = require('./limits.js');
const { within } = require('./within.js');

const CHAIN_EVERY_MS = 30000;
// The hub goes back to hardware mode by itself only after 20-30 s of silence. Found there
// sooner, another program put it there: Xenon gives the hub back and keeps off for a while.
const OWN_SILENCE_MS = 10000;
const YIELD_MS = 5 * 60 * 1000;
// One such change with no program running is let pass, once in this long: iCUE puts the hub
// in hardware mode as it quits, after the running apps were last looked at, and stepping aside
// for that kept the fans and lights from Xenon five minutes after iCUE closed (24 Nov 2026).
// A program that really takes the hub takes it again, and the second time Xenon steps aside.
const FORGIVE_MS = 2 * YIELD_MS;
// While Xenon holds the hub, how often it looks for a program that started meanwhile, and
// how long a poll waits for that look. Two programs at once send the fans to full: iCUE
// starting at sign-in a minute after the engine took the hub ran them at full until the
// next availability check, a minute later (24 Nov 2026). The look answers from the process
// table in milliseconds; a slower one is acted on at a later poll.
const HELD_CHECK_MS = 3000;
const HELD_CHECK_WAIT_MS = 250;
// The prudent curve: fans from STAND_IN.fanLow at or under coolC to full at fullC
// (where the safety layer calls the liquid too hot); the pump high, full when hot.
// The hub ramps a new duty slowly: measured 22 Nov 2026, 50 to 100 % took about 24 s
// to settle (about 45 rpm a second); from the stand-in's 40 % it needs about 30 s.
const LINK_SETTLE_MS = 40000;
const STAND_IN = Object.freeze({ coolC: 38, fullC: COMPONENTS.liquid.full, fanLow: 40, pump: 80 });

/** A channel's speed while Xenon does not drive it, from the liquid's temperature. */
function standIn(kind, liquid) {
  if (!Number.isFinite(liquid)) return 100;
  if (kind === 'pump') return liquid >= STAND_IN.fullC ? 100 : STAND_IN.pump;
  const t = (liquid - STAND_IN.coolC) / (STAND_IN.fullC - STAND_IN.coolC);
  return Math.round(Math.min(100, Math.max(STAND_IN.fanLow, STAND_IN.fanLow + t * (100 - STAND_IN.fanLow))));
}

// An AIO's radiator carries at most three fans: a hub with one pump and up to three
// fans is almost always that kit, so they follow the liquid instead of every CPU
// spike. With more, nobody can tell which ones: they stay case fans. The person can
// change it in the Fans tab either way.
const RADIATOR_MAX_FANS = 3;

function placeOf(chain) {
  const kinds = chain.map((d) => linkDevice(d.type, d.model).kind);
  const pumps = kinds.filter((k) => k === 'pump').length;
  const fans = kinds.filter((k) => k === 'fan').length;
  return pumps === 1 && fans <= RADIATOR_MAX_FANS ? 'radiator' : null;
}

// The fans and pumps of the chain, as Airflow channels. A device Xenon does not know is left out.
function channelsOf(chain, rpm, held, duty) {
  const out = [];
  const fanPlace = placeOf(chain);
  for (const d of chain) {
    const info = linkDevice(d.type, d.model);
    if (info.kind === 'other') continue;
    const id = fanId('link', 'hub', `ch-${d.channel}`);
    const tach = fanId('link', 'hub', `rpm-${d.channel}`);
    if (!id || !tach) continue;
    out.push({
      id, k: d.channel, name: info.name, labelKey: `link|ch-${d.channel}`, kind: info.kind,
      source: 'hub', controllable: true, zeroByDefault: false,
      // Each channel reads its own speed: the check confirms it like any other.
      rpm: rpm.get(d.channel) ?? null, tach, settleMs: LINK_SETTLE_MS,
      duty: duty.get(d.channel) ?? null, held: held.get(d.channel) ?? null, restorable: true,
      min: 0, max: 100,
      ...(info.kind === 'fan' && fanPlace ? { place: fanPlace } : {}),
    });
  }
  return out;
}

// The pump's temperature is the liquid's; the hub's own (entry 0) is the air inside it.
function liquidOf(chain, temps) {
  for (const d of chain) if (linkDevice(d.type, d.model).kind === 'pump' && temps.has(d.channel)) return temps.get(d.channel);
  return null;
}

/**
 * @param {{ hid: { list: (f: any) => Promise<any[]> }, openReports: (ifaces: any[]) => Promise<any>,
 *   leadingZero: boolean, busy: () => Promise<string[]>, wanted?: () => boolean, now?: () => number,
 *   session?: typeof createLinkSession, lights?: { attach: (s: any, chain: any[]) => void, detach: () => void } }} opts
 *   lights: the hub's lights while Xenon holds it (link-lights.js)
 */
function createLinkDriver({ hid, openReports, leadingZero, busy, wanted = () => true, now = Date.now, session: makeSession = createLinkSession, lights }) {
  let s = null;
  let chain = [];
  let chainAt = -Infinity;
  let listInTwo = false;
  let channels = [];
  const sent = new Map();
  const held = new Map();
  let yieldUntil = -Infinity;
  // The programs the check named when the hub was taken back (iCUE): the step aside ends once
  // they quit. Unnamed, it lasts YIELD_MS.
  let yieldTo = [];
  let seenRetakes = 0;
  let lastAt = -Infinity;
  let passedAt = -Infinity;
  let checkedAt = -Infinity;
  /** @type {Promise<void>|null} */
  let checking = null;
  /** @type {string[]} */
  let others = [];

  async function find() {
    const all = await hid.list({ vendorId: P.VENDOR_ID, productIds: [P.HUB_PRODUCT_ID] });
    // The command interface only: the hub's other one sends reports of its own.
    return all.filter((d) => d.usagePage === P.USAGE_PAGE && d.usage === 1 && (d.outputLength == null || d.outputLength === P.REPORT_BYTES));
  }

  async function close() {
    const was = s;
    s = null;
    sent.clear();
    held.clear();
    lights?.detach();
    if (was) await was.close().catch(() => {});
  }

  // The hub is looked for first, so the menu offers the switch only on a PC that has one.
  async function available() {
    if (!(await find()).length) return { ok: false, why: 'no-hub' };
    if (!wanted()) return { ok: false, why: 'link-off' };
    const inTheWay = await busy();
    if (yielding(inTheWay) || inTheWay.length) return { ok: false, why: 'vendor-app' };
    return { ok: true, why: null };
  }

  // Closing iCUE gives the fans and lights back at the next check, not five minutes later.
  function yielding(inTheWay) {
    if (!(now() < yieldUntil)) return false;
    if (!yieldTo.length || inTheWay.length) return true;
    yieldUntil = -Infinity;
    yieldTo = [];
    return false;
  }

  async function take() {
    if (s) return s;
    const ifaces = await find();
    if (!ifaces.length) return null;
    s = makeSession({ link: await openReports(ifaces.slice(0, 1)), leadingZero, now });
    seenRetakes = 0;
    lastAt = -Infinity;
    const fw = await s.firmware();
    listInTwo = !!fw && (fw.major > 2 || (fw.major === 2 && fw.minor >= 5));
    await s.software();
    chainAt = -Infinity;
    return s;
  }

  async function poll() {
    // No longer allowed: back to the hub's profile at once, not after its own timeout.
    if (!wanted()) {
      if (s) await release();
      return null;
    }
    if (now() < yieldUntil) return null;
    try {
      const link = await take();
      if (!link) return null;
      const at = now();
      if (at - chainAt >= CHAIN_EVERY_MS) { chain = await link.devices(listInTwo); chainAt = at; }
      const rpm = await link.speeds();
      const temps = await link.temps();
      if (await tookBack(link, at) || await othersStarted(at)) return null;
      lights?.attach(link, chain);
      channels = channelsOf(chain, rpm, held, sent);
      const liquid = liquidOf(chain, temps);
      return {
        at, guard: null,
        temps: liquid == null ? {} : { liquid: { value: liquid, at } }, power: {},
        tachs: Object.fromEntries(channels.map((c) => [c.tach, c.rpm])),
        duty: Object.fromEntries(channels.map((c) => [c.id, c.duty])),
        held: Object.fromEntries(channels.map((c) => [c.id, c.held])),
        liquid,
      };
    } catch {
      // Unplugged or another program took it: start over on the next poll.
      await close();
      channels = [];
      return null;
    }
  }

  // Another program put the hub back in hardware mode while Xenon held it: give it back,
  // unless no program runs and none did so lately (FORGIVE_MS). A check that cannot run is a doubt.
  async function tookBack(link, at) {
    const retakes = link.retakes();
    const other = retakes > seenRetakes && at - lastAt < OWN_SILENCE_MS;
    seenRetakes = retakes;
    lastAt = at;
    if (!other) return false;
    const seen = await busy().catch(() => ['unknown']);
    if (!seen.length) {
      const pass = at - passedAt >= FORGIVE_MS;
      passedAt = at;
      if (pass) return false;
    }
    yieldUntil = at + YIELD_MS;
    yieldTo = seen.filter((app) => app !== 'unknown');
    await release();
    channels = [];
    return true;
  }

  // A program that talks to the hub started while Xenon held it: give the hub back at once and
  // keep off while it runs. Only a named program: a look that fails is no reason to let go.
  async function othersStarted(at) {
    if (!checking && at - checkedAt >= HELD_CHECK_MS) {
      checkedAt = at;
      checking = Promise.resolve().then(busy).then((seen) => { others = seen.filter((app) => app !== 'unknown'); }, () => {})
        .finally(() => { checking = null; });
    }
    if (checking) await within(checking, HELD_CHECK_WAIT_MS);
    if (!others.length) return false;
    yieldUntil = now() + YIELD_MS;
    yieldTo = others;
    others = [];
    await release();
    channels = [];
    return true;
  }

  // One write with every channel whose speed changed; the hub keeps the rest.
  async function write(want) {
    if (!s) return;
    const entries = [...want].filter(([ch, v]) => sent.get(ch) !== v.duty).map(([channel, v]) => ({ channel, percent: v.duty }));
    if (entries.length) await s.setSpeeds(entries);
    for (const [ch, v] of want) { sent.set(ch, v.duty); held.set(ch, v.held); }
  }

  function plan(verdicts, liquid) {
    const want = new Map();
    for (const c of channels) {
      const v = verdicts?.[c.id];
      const set = v?.action === 'set' && Number.isFinite(v.duty);
      // A pump never under its floor, whatever it was asked (safety.js clamps it too).
      const duty = set ? Math.round(Math.min(100, Math.max(c.kind === 'pump' ? PUMP_FLOOR : 0, v.duty))) : standIn(c.kind, liquid);
      want.set(c.k, { duty, held: set ? 'set' : 'curve' });
    }
    return want;
  }

  /** Back to the profile saved in the hub, and its lights. */
  async function release() {
    if (s) await s.hardware().catch(() => {});
    await close();
  }

  let lastLiquid = null;
  const remember = (p) => { lastLiquid = p?.liquid ?? null; return p; };

  return {
    id: 'link',
    available,
    poll: async () => remember(await poll()),
    channels: () => channels,
    /** Watching: every channel on the prudent curve (the saved profile does not run now). */
    hello: () => write(plan({}, lastLiquid)),
    /** @param {Record<string, { action: string, duty?: number }>} verdicts */
    apply: (verdicts) => write(plan(verdicts, lastLiquid)),
    release,
    // Nothing on disk to clear: a hub left in software mode by a crash went back by itself.
    clear: async () => {},
  };
}

module.exports = { createLinkDriver, standIn, STAND_IN, CHAIN_EVERY_MS, YIELD_MS, OWN_SILENCE_MS, FORGIVE_MS, HELD_CHECK_MS };
