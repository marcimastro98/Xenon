'use strict';
// Bluetooth devices on Linux, from BlueZ. Headphones and others that report a level have a
// Battery1 interface, which costs nobody anything to read. AirPods and Beats do not: like on
// Windows, their level is in what they broadcast (apple-adverts.js), and BlueZ only hears
// that during a scan. So a scan runs only with asking on and only while a pair is connected.

const { connectSystemBus, stringDictionary } = require('./dbus-client');
const { devicesFrom } = require('./apple-adverts');

const BLUEZ = 'org.bluez';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const ADAPTER = 'org.bluez.Adapter1';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';
const APPLE_COMPANY = 76;
const PAIR_NAME = /airpods|beats/i;
const APPLE_MODALIAS = /^(bluetooth:v004C|usb:v05AC)/i;
const AUDIO_ICON = /^audio-/;
const LISTEN_STEP_MS = 1000;
const LISTEN_STEPS = 6;
const GUARD_KEY = 'bluez-scan';

const nameOf = (device) => device.Alias || device.Name || '';

// A renamed pair still says who made it, but so does an iPhone, hence the audio icon.
const isPair = (device) => PAIR_NAME.test(nameOf(device))
  || (APPLE_MODALIAS.test(device.Modalias || '') && AUDIO_ICON.test(device.Icon || ''));

// RSSI exists only during a scan, so an advert left over from an earlier one has none.
function advertOf(device) {
  const bytes = device.ManufacturerData?.[APPLE_COMPANY];
  return Array.isArray(bytes) && Number.isInteger(device.RSSI) ? [{ rssi: device.RSSI, hex: Buffer.from(bytes).toString('hex') }] : [];
}

function parseObjects(managed) {
  const objects = Object.values(managed).filter((object) => object[DEVICE]);
  const connected = objects.filter((object) => object[DEVICE].Connected === true);
  const pairs = connected.map((object) => object[DEVICE]).filter(isPair);
  return {
    batteries: connected.filter((object) => Number.isInteger(object[BATTERY]?.Percentage)).map((object) => (
      { name: nameOf(object[DEVICE]), percent: object[BATTERY].Percentage, charging: null, source: 'bluetooth', ...(object[DEVICE].Address ? { unit: String(object[DEVICE].Address) } : {}) }
    )),
    connected: pairs.map(nameOf),
    adapter: pairs[0]?.Adapter ?? null,
    adverts: objects.flatMap((object) => advertOf(object[DEVICE])),
  };
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const listObjects = (bus) => bus.call({ destination: BLUEZ, path: '/', iface: OBJECT_MANAGER, member: 'GetManagedObjects' });

const callAdapter = (bus, path, member, extra = {}) => bus.call({ destination: BLUEZ, path, iface: ADAPTER, member, ...extra });

// LE only: a classic inquiry would share the radio with the music playing. BlueZ restarts a
// scan every few seconds and forgets each RSSI when it does, so one look at the end can see
// nothing: it looks every second and keeps what it saw.
async function listen(bus, adapter) {
  await callAdapter(bus, adapter, 'SetDiscoveryFilter', { signature: 'a{sv}', body: stringDictionary({ Transport: 'le' }) });
  await callAdapter(bus, adapter, 'StartDiscovery');
  try {
    const views = [];
    for (let step = 0; step < LISTEN_STEPS; step += 1) {
      await wait(LISTEN_STEP_MS);
      views.push(parseObjects(await listObjects(bus)));
    }
    return views;
  } finally {
    await callAdapter(bus, adapter, 'StopDiscovery').catch(() => {});
  }
}

async function readPair(bus, adapter, guard) {
  guard.enter(GUARD_KEY);
  try {
    const views = await listen(bus, adapter);
    return devicesFrom({ connected: views.flatMap((view) => view.connected), adverts: views.flatMap((view) => view.adverts) });
  } catch {
    return [];
  } finally {
    guard.leave();
  }
}

// No BlueZ, or a bus that refuses this user, means no reading: the rest of the list stands.
async function readBluez({ ask, guard, connect = connectSystemBus }) {
  const bus = await connect().catch(() => null);
  if (!bus) return [];
  try {
    const seen = parseObjects(await listObjects(bus));
    const buds = ask && seen.adapter ? await readPair(bus, seen.adapter, guard) : [];
    const named = new Set(buds.map((device) => device.name));
    return [...buds, ...seen.batteries.filter((device) => !named.has(device.name))];
  } catch {
    return [];
  } finally {
    bus.close();
  }
}

module.exports = { readBluez, parseObjects };
