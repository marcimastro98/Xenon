'use strict';
// Lights held by another part of Xenon that already talks to their controller (today Airflow
// with an iCUE LINK hub: server/airflow/link-lights.js). They join the native devices
// (index.js), so the Lighting page, the Deck, the tile and widgets paint them as any other,
// and they come and go with what holds them: a source lists its devices only while it holds
// the controller. Registered at start, never found by scanning.

/**
 * @typedef {{ devices: () => any[], owns: (id: string) => boolean,
 *   write: (dev: any, colors: any[]) => boolean, off: () => Promise<void> }} HeldSource
 *   write: true when the device was this source's. off: every light dark, when the lights let go
 *   or the PC goes down. A held controller has no effect of its own to go back to: its holder
 *   keeps it.
 */

/** @type {Set<HeldSource>} */
const sources = new Set();
/** @type {(() => void) | null} */
let onChange = null;

/** @param {HeldSource} source @returns {() => void} removes it */
function addSource(source) {
  sources.add(source);
  return () => { if (sources.delete(source)) changed(); };
}

// What the lights listen to: a held device came or went, so the list and the paint change.
function setChangeHook(fn) { onChange = typeof fn === 'function' ? fn : null; }
function changed() { if (onChange) onChange(); }

const devices = () => [...sources].flatMap((s) => s.devices());
const owns = (/** @type {string} */ id) => [...sources].some((s) => s.owns(id));
/** @returns {boolean} whether a source took the device */
const write = (dev, colors) => [...sources].some((s) => s.write(dev, colors));
const off = () => Promise.all([...sources].map((s) => s.off().catch(() => {}))).then(() => {});

module.exports = { addSource, setChangeHook, changed, devices, owns, write, off };
