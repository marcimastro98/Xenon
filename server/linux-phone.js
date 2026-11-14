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

const fs = require('fs');

const { buildBMessage } = require('./phone-messages');
// SMS/phonebook exchange files go in a per-process 0700 directory with random
// names (see private-tmp.js): the old predictable /tmp names let another local
// user pre-create the file and read a phonebook or swap an outgoing SMS.
const { privateTmpFile } = require('./private-tmp');

const {
  runBusctl, dbusErrorName, dbusValue, parseManagedObjects, dbusRows, firstObjectPath,
} = require('./transfer/linux-phone-dbus.js');
const PULL_TIMEOUT_MS = 45000;
const PULL_POLL_MS = 400;

// ── busctl ──────────────────────────────────────────────────────────────────

// ── BlueZ: which phone ──────────────────────────────────────────────────────

const {
  PBAP_UUID, MAP_UUID, pickPhone, parseModems, pickModem, parseCalls, callState,
} = require('./transfer/linux-phone-parse.js');

// The message folders this reads, by name. An allowlist rather than passing a
// caller's string through: a folder name becomes a SetFolder on the user's
// phone, and there is no reason for it ever to be arbitrary.
const FOLDERS = Object.freeze({
  inbox: 'telecom/msg/inbox',
  sent: 'telecom/msg/sent',
  outbox: 'telecom/msg/outbox',
});

// ── ofono: the call side ────────────────────────────────────────────────────


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

    const target = privateTmpFile('xenon-pb-', '.vcf');
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
        const target = privateTmpFile('xenon-msg-', '.bmsg');
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
        const source = privateTmpFile('xenon-send-', '.bmsg');
        try {
          // 'wx' + 0600: created fresh and owner-only, so nothing can have
          // been waiting at this path and nobody else can read the message.
          await fs.promises.writeFile(source, buildBMessage(String(a.number || ''), String(a.text || '')), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
