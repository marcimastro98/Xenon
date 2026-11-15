'use strict';
// The two things a paired phone gives over OBEX on Linux: the phone book pulled to a private
// file and read, and a message session opened on a folder and closed again.

const fs = require('node:fs');
const { privateTmpFile } = require('../files/private-tmp.js');
const { dbusValue, firstObjectPath } = require('./linux-phone-dbus.js');
const { PULL_TIMEOUT_MS, PULL_POLL_MS } = require('./linux-phone-limits.js');

function makeObex({ readFile, userBus }) {
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

  return { pullPhonebook, waitForTransfer, withMapSession, selectFolder };
}

module.exports = { makeObex };
