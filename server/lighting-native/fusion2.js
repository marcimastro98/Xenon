'use strict';
// One GIGABYTE RGB Fusion 2 USB controller, driven directly: open, take over the
// ARGB headers, paint per-LED frames, hand the headers back to the board's own
// effects on release. Writes are serialised (one feature report at a time) and
// skipped when a header's frame did not change.
// Each feature report takes about 25 ms, so a full frame (strips, the board's
// own lights, apply) is slower than an effect changes colour. paint() never
// makes the caller wait and keeps only the newest frame; the board's lights,
// the costliest part, give way to newer frames for a while during fast effects.

const hid = require('../hid');
const P = require('./fusion2-protocol');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GEN2_SCAN_WAIT_MS = 700;   // the controller needs this long to walk the chain
const ZONE_MAX_DEFER_MS = 500;   // board lights keep up at least this often during fast effects

class Fusion2Controller {
  constructor(hidInfo) {
    this.hidInfo = hidInfo;
    this.dev = null;
    this.info = null;
    this.orders = [];
    this.counts = [];        // LEDs each header currently drives
    this.lastFrames = [];    // per header, the last frame key sent
    this.lastZones = [];     // per onboard zone, the last colour key sent
    this.taken = false;      // built-in effects switched off (we own the headers)
    this.queue = Promise.resolve();
    this.pending = null;     // newest frame not yet sent ({ frames, zoneColors, onError })
    this.drained = Promise.resolve();
    this.zonesDeferredAt = 0;
    this.frameMs = 0;        // how long the last frame took on the wire (status)
  }

  get headers() { return P.headerCount(this.hidInfo.productId); }
  get zones() { return P.onboardZones(this.hidInfo.productId); }

  // Serialise every exchange with the device; a failure never jams the queue.
  run(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async send(buf) { await this.dev.setFeature(buf); }

  async open() {
    this.dev = await hid.open(this.hidInfo);
    await this.send(P.packet([P.CMD.INFO]));
    this.info = P.parseInfo(await this.dev.getFeature(P.REPORT_ID), this.hidInfo.productId);
    if (!this.info) throw new Error('the RGB controller did not answer');
    const cals = [...this.info.calStrips];
    if (this.hidInfo.productId === 0x5711) {
      await this.send(P.packet([P.CMD.INFO_EXTRA]));
      cals.push(...P.parseInfoExtra(await this.dev.getFeature(P.REPORT_ID)));
    }
    const first = P.byteOrder(cals[0]);
    this.orders = Array.from({ length: this.headers }, (_, i) => P.byteOrder(cals[i] || 0, first));
    for (const pkt of P.initPackets(this.info)) await this.send(pkt);
    return this.info;
  }

  // LED counts of Gen2 devices chained on each header ([] = plain ARGB / nothing).
  scanGen2() {
    return this.run(async () => {
      const out = [];
      if (!P.gen2Supported(this.info)) return Array.from({ length: this.headers }, () => []);
      for (let s = 0; s < this.headers; s++) {
        const { scan, info } = P.gen2ScanPackets(s);
        await this.send(scan);
        await sleep(GEN2_SCAN_WAIT_MS);
        await this.send(info);
        out.push(P.parseGen2(await this.dev.getFeature(P.REPORT_ID)));
      }
      this.counts = [];        // the scan resets the controller's LED counts
      this.lastFrames = [];
      return out;
    });
  }

  // Hand a frame over and return at once. A frame still waiting when a newer one
  // arrives is dropped: the lights always catch up with the newest colours.
  paint(frames, zoneColors, onError) {
    this.pending = { frames, zoneColors, onError };
    if (!this.painting) this.drained = this.drain();
  }

  async drain() {
    this.painting = true;
    try {
      while (this.pending) {
        const { frames, zoneColors, onError } = this.pending;
        this.pending = null;
        const started = Date.now();
        try {
          await this.write(frames, zoneColors, () => !!this.pending);
          this.frameMs = Date.now() - started;
        } catch (e) {
          if (onError) onError(e);
        }
      }
    } finally {
      this.painting = false;
    }
  }

  // Board lights wait while a newer frame is already queued, up to ZONE_MAX_DEFER_MS.
  zonesMustWait(newerWaiting) {
    if (!newerWaiting || !newerWaiting()) { this.zonesDeferredAt = 0; return false; }
    const now = Date.now();
    if (!this.zonesDeferredAt) this.zonesDeferredAt = now;
    if (now - this.zonesDeferredAt < ZONE_MAX_DEFER_MS) return true;
    this.zonesDeferredAt = 0;
    return false;
  }

  // frames: per header, an array of {r,g,b} (null = leave that header alone).
  // zoneColors: per onboard zone (this.zones order), one {r,g,b} or null.
  // newerWaiting: () => true while a newer frame waits (lets the zones give way).
  write(frames, zoneColors = [], newerWaiting = null) {
    return this.run(async () => {
      const counts = Array.from({ length: this.headers }, (_, s) => Math.max(this.counts[s] || 0, frames[s] ? frames[s].length : 0));
      if (counts.some((c, s) => P.ledCountCode(c) !== P.ledCountCode(this.counts[s] || 0)) || !this.counts.length) {
        await this.send(P.ledCountPacket(counts));
        this.counts = counts;
      }
      if (!this.taken) {
        await this.send(P.effectsOffPacket(Array.from({ length: this.headers }, (_, s) => s)));
        await sleep(50);
        this.taken = true;
      }
      let changed = false;
      for (let s = 0; s < this.headers; s++) {
        const f = frames[s];
        if (!f) continue;
        const key = f.map(c => `${c.r},${c.g},${c.b}`).join('|');
        if (this.lastFrames[s] === key) continue;
        for (const pkt of P.stripPackets(s, f, this.orders[s])) await this.send(pkt);
        this.lastFrames[s] = key;
        changed = true;
      }
      const zonesWait = this.zones.length && zoneColors.some(Boolean) && this.zonesMustWait(newerWaiting);
      for (let k = 0; k < this.zones.length && !zonesWait; k++) {
        const c = zoneColors[k];
        if (!c) continue;
        const key = `${c.r},${c.g},${c.b}`;
        if (this.lastZones[k] === key) continue;
        await this.send(P.zoneColorPacket(this.zones[k], c));
        this.lastZones[k] = key;
        changed = true;
      }
      if (changed) await this.send(P.applyPacket(this.hidInfo.productId));
    });
  }

  // Give the headers back to the board's own effects (what it showed before).
  // The onboard zones have no such switch: they keep the last colour until the
  // board reloads its own effects at the next boot (Xenon never writes flash).
  release() {
    this.pending = null;
    if (!this.dev) return Promise.resolve();
    // Queued behind a frame still on the wire, which may be the one taking the headers.
    return this.run(async () => {
      if (!this.taken) return;
      await this.send(P.effectsOffPacket([]));
      await this.send(P.applyPacket(this.hidInfo.productId));
      this.taken = false;
      this.lastFrames = [];
      this.lastZones = [];
    });
  }

  // Forget what the controller was told (LED counts, frames, who owns the
  // headers): the next write sets it all up again.
  forget() {
    this.counts = [];
    this.lastFrames = [];
    this.lastZones = [];
    this.taken = false;
  }

  async close() {
    try { await this.release(); } catch { /* the device may be gone */ }
    if (this.dev) await this.dev.close();
    this.dev = null;
  }
}

// Every Fusion 2 controller on this PC (normally one, on the motherboard).
async function discover() {
  const found = await hid.list({ vendorId: P.VENDOR_ID, productIds: P.PRODUCT_IDS, usagePage: P.USAGE_PAGE });
  return found.filter(d => d.usage === P.USAGE).map(d => new Fusion2Controller(d));
}

module.exports = { discover, Fusion2Controller };
