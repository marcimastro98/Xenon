'use strict';

// ── The paired phone on Linux ───────────────────────────────────────────────
// The twin of the helper's `phone-serve` mode, answering the SAME ops with the
// SAME shapes, so server/phone.js keeps one code path and gains a transport
// rather than a branch.
//
// Nothing here is compiled and nothing new is installed, and that is not
// thrift: Linux has no helper binary by design (see the process invariant), and
// Node cannot open a Bluetooth socket without a native module — which would be
// a dependency, and this feature does not get to add one. It does not need to,
// because the platform already ships both halves:
//
//   obexd (part of BlueZ) speaks OBEX/PBAP for us. We ask it to pull the
//   phonebook into a file and hand that file to the SAME phone-vcard.js the
//   Windows path uses. That reuse is the entire reason parsing lives in Node.
//
//   ofono owns the HFP connection and exposes it on D-Bus — including
//   VoiceCall.Answer(). Linux is therefore the ONE platform where the Answer
//   button on the incoming-call card can be real, and the card needs no change
//   to show it: it renders from the `canAnswer` this transport reports.
//
// Both are driven through `busctl`, which is part of systemd and is already a
// hard assumption here — the backend runs as a `systemd --user` unit.
//
// WHAT IS NOT HERE YET: messages. obexd can do MAP as well, through a different
// interface with a listing that needs its own parser. `status` reports
// `map:false`, which makes the widget hide the tab rather than offer one that
// fails. That is a gap, stated, not a silent one.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildBMessage } = require('./phone-messages');

const CALL_TIMEOUT_MS = 25000;
const PULL_TIMEOUT_MS = 45000;
const PULL_POLL_MS = 400;

// ── busctl ──────────────────────────────────────────────────────────────────

// Run busctl and return its stdout. Never throws for a non-zero exit: the
// caller decides what a failure means, and D-Bus errors carry the reason on
// stderr, which is the part worth keeping.
function runBusctl(args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('busctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'busctl_missing', out: '', err: '' });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish({ ok: false, error: 'timeout', out, err });
    }, o.timeout || CALL_TIMEOUT_MS);
    timer.unref();

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c) => { if (out.length < 4 * 1024 * 1024) out += c; });
    proc.stderr.on('data', (c) => { if (err.length < 64 * 1024) err += c; });
    proc.on('error', () => { clearTimeout(timer); finish({ ok: false, error: 'busctl_missing', out, err }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, error: code === 0 ? '' : dbusErrorName(err), out, err });
    });
  });
}

// D-Bus errors come back as "org.bluez.obex.Error.Forbidden: ...". The short
// name is what a user-facing message can be built from; the rest is noise.
function dbusErrorName(stderr) {
  const m = /((?:[A-Za-z][\w-]*\.)+[A-Za-z][\w-]*)\s*:/.exec(String(stderr || ''));
  if (!m) return 'dbus_failed';
  const parts = m[1].split('.');
  return parts[parts.length - 1].toLowerCase() || 'dbus_failed';
}

// Pull the payload out of `busctl --json=short` output.
//
// Deliberately tolerant. busctl has rendered its results in more than one shape
// across systemd versions, and a transport that only understands one of them
// breaks on a distro nobody tested. Anything unrecognised falls back to reading
// the first quoted token out of the plain (non-JSON) rendering, which is the
// form busctl prints without --json at all.
function dbusValue(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if ('data' in parsed) {
        const d = parsed.data;
        return Array.isArray(d) && d.length === 1 ? d[0] : d;
      }
      return parsed;
    }
    return parsed;
  } catch { /* not JSON — fall through to the plain rendering */ }
  const quoted = /"([^"]*)"/.exec(text);
  if (quoted) return quoted[1];
  const bare = text.split(/\s+/);
  return bare.length > 1 ? bare.slice(1).join(' ') : text;
}

// ── BlueZ: which phone ──────────────────────────────────────────────────────

// The connected device that carries a phonebook. Addresses come back from the
// object tree, so the MAC we hand to obexd is one BlueZ gave us rather than one
// assembled here.
function parseManagedObjects(json) {
  const devices = [];
  let tree;
  try { tree = typeof json === 'string' ? JSON.parse(json) : json; } catch { return devices; }
  const root = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || {};
  for (const [objPath, ifaces] of Object.entries(root)) {
    const dev = ifaces && ifaces['org.bluez.Device1'];
    if (!dev) continue;
    const val = (k) => (dev[k] && 'data' in dev[k] ? dev[k].data : undefined);
    const uuids = val('UUIDs');
    devices.push({
      path: objPath,
      address: String(val('Address') || ''),
      name: String(val('Alias') || val('Name') || ''),
      connected: val('Connected') === true,
      uuids: Array.isArray(uuids) ? uuids.map(String) : [],
    });
  }
  return devices;
}

const PBAP_UUID = '0000112f-0000-1000-8000-00805f9b34fb';
const MAP_UUID = '00001132-0000-1000-8000-00805f9b34fb';

// The message folders this reads, by name. An allowlist rather than passing a
// caller's string through: a folder name becomes a SetFolder on the user's
// phone, and there is no reason for it ever to be arbitrary.
const FOLDERS = Object.freeze({
  inbox: 'telecom/msg/inbox',
  sent: 'telecom/msg/sent',
  outbox: 'telecom/msg/outbox',
});

// The `a(oa{sv})` rows busctl returns for ListMessages and GetModems alike.
function dbusRows(stdout) {
  let tree;
  try { tree = JSON.parse(String(stdout || '')); } catch { return []; }
  const rows = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || [];
  return Array.isArray(rows) ? rows : [];
}

function hasUuid(device, uuid) {
  return (device.uuids || []).some(u => String(u).toLowerCase() === uuid);
}

// Connected first: a phone that is paired but out of range publishes the same
// UUIDs and would be picked while being unreachable.
function pickPhone(devices, uuid) {
  const able = (devices || []).filter(d => d.address && hasUuid(d, uuid));
  return able.find(d => d.connected) || able[0] || null;
}

// ── ofono: the call side ────────────────────────────────────────────────────

// The modem ofono creates for a Bluetooth handsfree connection. `Online` and
// `Powered` both matter: a modem object outlives the phone walking away, and
// dialling through a dead one fails in a way that reads as a Xenon fault.
function parseModems(json) {
  const out = [];
  let tree;
  try { tree = typeof json === 'string' ? JSON.parse(json) : json; } catch { return out; }
  const rows = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const objPath = Array.isArray(row) ? row[0] : (row && row.path);
    const props = (Array.isArray(row) ? row[1] : (row && row.properties)) || {};
    if (typeof objPath !== 'string') continue;
    const val = (k) => (props[k] && 'data' in props[k] ? props[k].data : props[k]);
    out.push({
      path: objPath,
      name: String(val('Name') || ''),
      type: String(val('Type') || ''),
      online: val('Online') === true,
      powered: val('Powered') === true,
      interfaces: Array.isArray(val('Interfaces')) ? val('Interfaces').map(String) : [],
    });
  }
  return out;
}

function pickModem(modems) {
  const usable = (modems || []).filter(m => m.powered && m.interfaces.includes('org.ofono.VoiceCallManager'));
  // A handsfree modem IS the paired phone; anything else would be a real cellular
  // modem in the machine, which is not what this feature is about.
  return usable.find(m => m.type === 'hfp') || usable.find(m => m.online) || usable[0] || null;
}

// ofono's call states, reduced to the two booleans every surface here speaks.
// `incoming` and `waiting` both ring; `dialing`/`alerting` are ours going out
// and are ACTIVE rather than incoming, or the card would ring at the user for a
// call they just placed themselves.
const RINGING_STATES = new Set(['incoming', 'waiting']);
const ACTIVE_STATES = new Set(['active', 'held', 'dialing', 'alerting']);

function parseCalls(json) {
  const out = [];
  let tree;
  try { tree = typeof json === 'string' ? JSON.parse(json) : json; } catch { return out; }
  const rows = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const objPath = Array.isArray(row) ? row[0] : (row && row.path);
    const props = (Array.isArray(row) ? row[1] : (row && row.properties)) || {};
    if (typeof objPath !== 'string') continue;
    const val = (k) => (props[k] && 'data' in props[k] ? props[k].data : props[k]);
    out.push({
      path: objPath,
      state: String(val('State') || '').toLowerCase(),
      number: String(val('LineIdentification') || ''),
      name: String(val('Name') || ''),
    });
  }
  return out;
}

function callState(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const ringing = list.find(c => RINGING_STATES.has(c.state)) || null;
  return {
    incoming: !!ringing,
    active: list.some(c => ACTIVE_STATES.has(c.state)),
    ringingPath: ringing ? ringing.path : '',
    // ofono knows WHO is calling, which the Windows path does not — the caller
    // there has to come from a mirrored toast. Passing it up costs nothing and
    // makes the card correct on its own here.
    caller: ringing ? (ringing.name || ringing.number || '') : '',
  };
}

// ── The transport ───────────────────────────────────────────────────────────

function createLinuxPhone(opts) {
  const o = opts || {};
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  const busctl = typeof o.busctl === 'function' ? o.busctl : runBusctl;   // test seam
  const readFile = typeof o.readFile === 'function' ? o.readFile : ((p) => fs.promises.readFile(p, 'utf8'));

  let stopped = false;
  let poll = null;
  let last = { incoming: false, active: false };

  const userBus = (args, t) => busctl(['--user', '--json=short', ...args], { timeout: t });
  const systemBus = (args, t) => busctl(['--system', '--json=short', ...args], { timeout: t });

  // ── BlueZ / obexd ─────────────────────────────────────────────────────────

  async function devices() {
    const r = await systemBus(['call', 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects']);
    if (!r.ok) return [];
    return parseManagedObjects(r.out);
  }

  // Pull one phonebook object into a temp file and return its text. obexd does
  // the OBEX; the vCard it writes is parsed by the shared module upstream.
  async function pullPhonebook(address, location, book) {
    const session = await userBus(['call', 'org.bluez.obex', '/org/bluez/obex',
      'org.bluez.obex.Client1', 'CreateSession', 'sa{sv}', address, '1', 'Target', 's', 'pbap']);
    if (!session.ok) throw new Error('phonebook_' + (session.error || 'session_failed'));
    const sessionPath = String(dbusValue(session.out) || '');
    if (!sessionPath.startsWith('/')) throw new Error('phonebook_session_failed');

    const target = path.join(os.tmpdir(), `xenon-pb-${process.pid}-${Date.now()}.vcf`);
    try {
      const select = await userBus(['call', 'org.bluez.obex', sessionPath,
        'org.bluez.obex.PhonebookAccess1', 'Select', 'ss', location, book]);
      if (!select.ok) throw new Error('phonebook_' + (select.error || 'select_failed'));

      const pull = await userBus(['call', 'org.bluez.obex', sessionPath,
        'org.bluez.obex.PhonebookAccess1', 'PullAll', 'sa{sv}', target, '0']);
      if (!pull.ok) throw new Error('phonebook_' + (pull.error || 'pull_failed'));

      const transfer = firstObjectPath(pull.out);
      if (transfer) await waitForTransfer(transfer);
      return await readFile(target);
    } finally {
      try { await userBus(['call', 'org.bluez.obex', '/org/bluez/obex', 'org.bluez.obex.Client1', 'RemoveSession', 'o', sessionPath]); } catch { /* best effort */ }
      try { await fs.promises.unlink(target); } catch { /* the pull may never have created it */ }
    }
  }

  // The transfer is asynchronous: obexd answers the PullAll immediately and
  // fills the file afterwards. Reading it before `complete` gets a partial
  // phonebook, which is the kind of bug that looks like "some contacts are
  // missing" rather than like a race.
  async function waitForTransfer(transferPath) {
    const deadline = Date.now() + PULL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = await userBus(['get-property', 'org.bluez.obex', transferPath, 'org.bluez.obex.Transfer1', 'Status']);
      // A transfer object DISAPPEARS the moment it completes on some BlueZ
      // versions, so a failed read here means done rather than broken.
      if (!r.ok) return;
      const status = String(dbusValue(r.out) || '').toLowerCase();
      if (status === 'complete') return;
      if (status === 'error') throw new Error('phonebook_transfer_failed');
      await new Promise(res => setTimeout(res, PULL_POLL_MS));
    }
    throw new Error('phonebook_timeout');
  }

  // ── obexd: messages ───────────────────────────────────────────────────────

  // A MAP session, opened per request and closed straight after, exactly like
  // the phonebook one: the channel is contended and holding it would take
  // something from other software for the time we are not reading.
  async function withMapSession(address, fn) {
    const session = await userBus(['call', 'org.bluez.obex', '/org/bluez/obex',
      'org.bluez.obex.Client1', 'CreateSession', 'sa{sv}', address, '1', 'Target', 's', 'map']);
    if (!session.ok) throw new Error('messages_' + (session.error || 'session_failed'));
    const sessionPath = String(dbusValue(session.out) || '');
    if (!sessionPath.startsWith('/')) throw new Error('messages_session_failed');
    try {
      return await fn(sessionPath);
    } finally {
      try { await userBus(['call', 'org.bluez.obex', '/org/bluez/obex', 'org.bluez.obex.Client1', 'RemoveSession', 'o', sessionPath]); } catch { /* best effort */ }
    }
  }

  // Walk down from the root, one level per SetFolder — the same rule the raw
  // protocol has, because obexd passes it straight through.
  async function selectFolder(session, folder) {
    const root = await userBus(['call', 'org.bluez.obex', session, 'org.bluez.obex.MessageAccess1', 'SetFolder', 's', '/']);
    if (!root.ok) throw new Error('messages_' + (root.error || 'setfolder_failed'));
    for (const part of String(folder).split('/').filter(Boolean)) {
      const r = await userBus(['call', 'org.bluez.obex', session, 'org.bluez.obex.MessageAccess1', 'SetFolder', 's', part]);
      if (!r.ok) throw new Error('messages_' + (r.error || 'setfolder_failed'));
    }
  }

  // ── ofono ─────────────────────────────────────────────────────────────────

  async function modem() {
    const r = await systemBus(['call', 'org.ofono', '/', 'org.ofono.Manager', 'GetModems']);
    if (!r.ok) return null;
    return pickModem(parseModems(r.out));
  }

  async function liveCalls(modemPath) {
    const r = await systemBus(['call', 'org.ofono', modemPath, 'org.ofono.VoiceCallManager', 'GetCalls']);
    if (!r.ok) return [];
    return parseCalls(r.out);
  }

  // Call state is polled rather than watched, and that is a deliberate trade
  // for now: `busctl monitor` would need a long-lived child and its own line
  // parser, and a ring lasts tens of seconds. One cheap D-Bus round trip a
  // second is well inside that, and there is no polling at all while the
  // feature is off because the poll only exists between start() and stop().
  function startWatch() {
    if (poll || stopped) return;
    poll = setInterval(async () => {
      try {
        const m = await modem();
        const state = m ? callState(await liveCalls(m.path)) : { incoming: false, active: false, caller: '' };
        if (state.incoming === last.incoming && state.active === last.active) return;
        last = { incoming: state.incoming, active: state.active };
        onEvent({ event: 'callstate', incoming: state.incoming, active: state.active, caller: state.caller });
      } catch { /* a transient D-Bus failure is not a state change */ }
    }, 1000);
    if (poll.unref) poll.unref();
  }

  // ── The op table phone.js calls ───────────────────────────────────────────

  async function request(op, extra) {
    const a = extra || {};
    switch (op) {
      case 'status': {
        const list = await devices();
        const phone = pickPhone(list, PBAP_UUID);
        const m = await modem();
        const calls = m ? await liveCalls(m.path) : [];
        const state = callState(calls);
        startWatch();
        return {
          pbap: !!phone,
          map: !!pickPhone(list, MAP_UUID),
          device: phone ? phone.name : '',
          telephony: !!m,
          canDial: !!m,
          // The whole reason this platform was worth doing first.
          canAnswer: !!m,
          canHangUp: !!m,
          line: m ? m.name : '',
          transport: 'Bluetooth',
          incoming: state.incoming,
          active: state.active,
        };
      }

      case 'contacts': {
        const phone = pickPhone(await devices(), PBAP_UUID);
        if (!phone) throw new Error('no_paired_phonebook');
        return { vcf: await pullPhonebook(phone.address, 'int', 'pb'), total: -1 };
      }

      case 'calls': {
        const phone = pickPhone(await devices(), PBAP_UUID);
        if (!phone) throw new Error('no_paired_phonebook');
        // Same five objects the Windows path reads, under obexd's own names.
        const book = { cch: 'cch', ich: 'ich', och: 'och', mch: 'mch' }[String(a.book || 'cch')] || 'cch';
        return { vcf: await pullPhonebook(phone.address, 'int', book), total: -1, book };
      }

      case 'dial': {
        const m = await modem();
        if (!m) throw new Error('no_phone_line');
        const r = await systemBus(['call', 'org.ofono', m.path, 'org.ofono.VoiceCallManager', 'Dial', 'ss', String(a.number || ''), 'default']);
        if (!r.ok) throw new Error(r.error || 'dial_failed');
        return { ok: true };
      }

      case 'answer': {
        const m = await modem();
        if (!m) throw new Error('no_phone_line');
        const state = callState(await liveCalls(m.path));
        if (!state.ringingPath) throw new Error('nothing_ringing');
        const r = await systemBus(['call', 'org.ofono', state.ringingPath, 'org.ofono.VoiceCall', 'Answer']);
        if (!r.ok) throw new Error(r.error || 'answer_failed');
        return { ok: true };
      }

      case 'hangup': {
        const m = await modem();
        if (!m) throw new Error('no_phone_line');
        const r = await systemBus(['call', 'org.ofono', m.path, 'org.ofono.VoiceCallManager', 'HangupAll']);
        if (!r.ok) throw new Error(r.error || 'hangup_failed');
        return { ok: true };
      }

      case 'messages': {
        const phone = pickPhone(await devices(), MAP_UUID);
        if (!phone) throw new Error('no_paired_messages');
        const folder = FOLDERS[String(a.folder || 'inbox')] ? String(a.folder) : 'inbox';
        const rows = await withMapSession(phone.address, async (session) => {
          await selectFolder(session, FOLDERS[folder]);
          const r = await userBus(['call', 'org.bluez.obex', session,
            'org.bluez.obex.MessageAccess1', 'ListMessages', 'sa{sv}', '', '0']);
          if (!r.ok) throw new Error('messages_' + (r.error || 'list_failed'));
          return dbusRows(r.out);
        });
        // Already parsed by obexd, so it gets a mapper rather than the XML
        // parser the Windows path needs. Same shape out either way.
        return { rows, folder, obex: true };
      }

      case 'message': {
        const phone = pickPhone(await devices(), MAP_UUID);
        if (!phone) throw new Error('no_paired_messages');
        const folder = FOLDERS[String(a.folder || 'inbox')] ? String(a.folder) : 'inbox';
        const wanted = String(a.handle || '');
        const target = path.join(os.tmpdir(), `xenon-msg-${process.pid}-${Date.now()}.bmsg`);
        try {
          return await withMapSession(phone.address, async (session) => {
            await selectFolder(session, FOLDERS[folder]);
            // Re-resolved against a FRESH listing rather than trusted: the
            // handle arrived over HTTP, and an object path is a thing D-Bus
            // will happily call a method on. Only a path this listing just
            // produced is ever used.
            const listed = await userBus(['call', 'org.bluez.obex', session,
              'org.bluez.obex.MessageAccess1', 'ListMessages', 'sa{sv}', '', '0']);
            if (!listed.ok) throw new Error('messages_' + (listed.error || 'list_failed'));
            const known = dbusRows(listed.out).some(r => (Array.isArray(r) ? r[0] : r && r.path) === wanted);
            if (!known) throw new Error('bad_handle');

            const get = await userBus(['call', 'org.bluez.obex', wanted,
              'org.bluez.obex.Message1', 'Get', 'sb', target, 'false']);
            if (!get.ok) throw new Error('messages_' + (get.error || 'get_failed'));
            const transfer = firstObjectPath(get.out);
            if (transfer) await waitForTransfer(transfer);
            return { bmsg: await readFile(target) };
          });
        } finally {
          try { await fs.promises.unlink(target); } catch { /* the get may never have created it */ }
        }
      }

      case 'send': {
        const phone = pickPhone(await devices(), MAP_UUID);
        if (!phone) throw new Error('no_paired_messages');
        const source = path.join(os.tmpdir(), `xenon-send-${process.pid}-${Date.now()}.bmsg`);
        try {
          await fs.promises.writeFile(source, buildBMessage(String(a.number || ''), String(a.text || '')), 'utf8');
          return await withMapSession(phone.address, async (session) => {
            const r = await userBus(['call', 'org.bluez.obex', session,
              'org.bluez.obex.MessageAccess1', 'PushMessage', 'ssa{sv}', source, FOLDERS.outbox, '0']);
            if (!r.ok) throw new Error('messages_' + (r.error || 'send_failed'));
            const transfer = firstObjectPath(r.out);
            if (transfer) await waitForTransfer(transfer);
            return { ok: true };
          });
        } finally {
          try { await fs.promises.unlink(source); } catch { /* best effort */ }
        }
      }

      default:
        throw new Error('unknown_op');
    }
  }

  function stop() {
    stopped = true;
    if (poll) { clearInterval(poll); poll = null; }
  }

  return { request, stop };
}

// The first object path in a busctl result, wherever in the shape it sits.
function firstObjectPath(stdout) {
  const value = dbusValue(stdout);
  if (typeof value === 'string' && value.startsWith('/')) return value;
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string' && v.startsWith('/')) return v;
  }
  const m = /"(\/[^"]*)"/.exec(String(stdout || ''));
  return m ? m[1] : '';
}

module.exports = {
  createLinuxPhone,
  // pure, exported for the tests: these are the only parts testable off Linux
  dbusValue,
  dbusErrorName,
  parseManagedObjects,
  parseModems,
  parseCalls,
  pickPhone,
  pickModem,
  callState,
  firstObjectPath,
  dbusRows,
  PBAP_UUID,
  MAP_UUID,
  FOLDERS,
};
