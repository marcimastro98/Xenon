'use strict';
// What is pulled from the paired phone and kept: the phonebook, the call log, a folder of
// messages and one message's text, each cached and never pulled on a timer, and a message sent.

const vcard = require('../phone-vcard.js');
const numbers = require('../phone-numbers.js');
const messages = require('../phone-messages.js');
const {
  CONTACTS_TTL_MS, CALLS_TTL_MS, REFRESH_MIN_MS, MAX_CONTACTS, MAX_CALLS, MESSAGES_TTL_MS,
  MAX_MESSAGES, MAX_MESSAGE_CHARS,
} = require('./paired-phone-limits.js');

function makeLists({ cache, enabled, request, FOLDERS }) {
  async function contacts(force) {
    if (!enabled()) return { ok: false, reason: 'disabled', list: [] };
    const now = Date.now();
    if (force && cache.contacts.at && now - cache.contacts.at < REFRESH_MIN_MS) force = false;
    if (!force && cache.contacts.at && now - cache.contacts.at < CONTACTS_TTL_MS) {
      return { ok: true, list: cache.contacts.list, total: cache.contacts.total, at: cache.contacts.at, cached: true };
    }
    try {
      const out = await request('contacts', { max: MAX_CONTACTS });
      const list = vcard.parseContacts(out && out.vcf).sort(byName);
      cache.contacts = {
        at: Date.now(),
        list,
        index: numbers.buildIndex(list),
        total: Number.isFinite(out && out.total) ? out.total : list.length,
        error: '',
      };
      // The call log is pulled first and the phonebook is lazy, so rows the
      // phone sent without a name were resolved against an index that did not
      // exist yet. Re-resolve the cached log now rather than leaving bare
      // numbers on screen until its own TTL runs out.
      if (cache.calls.list.length) cache.calls.list = cache.calls.list.map(withName);
      return { ok: true, list, total: cache.contacts.total, at: cache.contacts.at, cached: false };
    } catch (e) {
      const reason = String((e && e.message) || 'phone_error');
      cache.contacts.error = reason;
      // Last good copy, plainly labelled. An empty list would read as "you have
      // no contacts", which is a different and much worse statement.
      return { ok: false, reason, list: cache.contacts.list, total: cache.contacts.total, at: cache.contacts.at, cached: true };
    }
  }

  async function calls(force) {
    if (!enabled()) return { ok: false, reason: 'disabled', list: [] };
    const now = Date.now();
    if (force && cache.calls.at && now - cache.calls.at < REFRESH_MIN_MS) force = false;
    if (!force && cache.calls.at && now - cache.calls.at < CALLS_TTL_MS) {
      return { ok: true, list: cache.calls.list, at: cache.calls.at, cached: true };
    }
    try {
      // The COMBINED book, once. Direction rides on each entry's timestamp
      // parameter, so pulling ich/och/mch separately would be three extra
      // Bluetooth round trips for information already in this one.
      const out = await request('calls', { book: 'cch', max: MAX_CALLS });
      const list = vcard.parseCallLog(out && out.vcf, 'cch').map(withName);
      cache.calls = { at: Date.now(), list, error: '' };
      return { ok: true, list, at: cache.calls.at, cached: false };
    } catch (e) {
      const reason = String((e && e.message) || 'phone_error');
      cache.calls.error = reason;
      return { ok: false, reason, list: cache.calls.list, at: cache.calls.at, cached: true };
    }
  }

  function msgCache(folder) {
    if (!cache.messages.has(folder)) cache.messages.set(folder, { at: 0, list: [], error: '' });
    return cache.messages.get(folder);
  }

  async function messageList(folder, force) {
    if (!enabled()) return { ok: false, reason: 'disabled', list: [] };
    const key = FOLDERS.includes(String(folder)) ? String(folder) : 'inbox';
    const slot = msgCache(key);
    const now = Date.now();
    if (force && slot.at && now - slot.at < REFRESH_MIN_MS) force = false;
    if (!force && slot.at && now - slot.at < MESSAGES_TTL_MS) {
      return { ok: true, folder: key, list: slot.list, at: slot.at, cached: true };
    }
    try {
      const out = await request('messages', { folder: key, max: MAX_MESSAGES });
      // Two containers, one shape. Windows returns the MAP listing XML; on
      // Linux obexd has already parsed it and returns D-Bus rows. Which one
      // arrived is the transport's business, so it says so rather than being
      // guessed at from the payload.
      const parsed = (out && out.obex)
        ? messages.parseObexMessages(out.rows)
        : messages.parseListing(out && out.xml);
      // The phone often knows the sender's name already; when it does not, the
      // phonebook fills it in exactly as it does for the call log.
      const list = parsed.map(withName);
      slot.at = Date.now();
      slot.list = list;
      slot.error = '';
      return { ok: true, folder: key, list, at: slot.at, cached: false };
    } catch (e) {
      const reason = String((e && e.message) || 'phone_error');
      slot.error = reason;
      // The last good list, plainly labelled. On Windows this path is REACHED
      // ROUTINELY and is not a fault: Phone Link holds the same channel while
      // it runs, so "busy" is a state to report, never something to fight over.
      return { ok: false, reason, folder: key, list: slot.list, at: slot.at, cached: true };
    }
  }

  // One message, fetched on open. Deliberately not cached: a body is the part
  // of this feature most worth not keeping around, and it is one round trip.
  async function messageBody(folder, handle) {
    if (!enabled()) return { ok: false, reason: 'disabled' };
    const key = FOLDERS.includes(String(folder)) ? String(folder) : 'inbox';
    // A bounded, generic check here; the SHAPE is the transport's business.
    // Windows handles are MAP hex ids and the helper re-asserts that; on Linux
    // they are obexd object paths, which that transport re-resolves against a
    // fresh listing before using. Hard-coding one shape at this level would
    // refuse the other, and loosening the transport's own check to compensate
    // is exactly the wrong direction.
    const id = String(handle == null ? '' : handle).trim();
    if (!id || id.length > 256 || /[\s"'`\\]|\.\./.test(id)) return { ok: false, reason: 'bad_handle' };
    try {
      const out = await request('message', { folder: key, handle: id });
      const parsed = messages.parseMessage(out && out.bmsg);
      if (!parsed) return { ok: false, reason: 'phone_error' };
      if (!parsed.name) {
        const hit = numbers.lookup(cache.contacts.index, parsed.number);
        if (hit) parsed.name = hit.name;
      }
      return { ok: true, folder: key, handle: id, message: parsed };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || 'phone_error') };
    }
  }

  async function sendMessage(rawNumber, rawText) {
    if (!enabled()) return { ok: false, error: 'disabled' };
    const number = numbers.dialable(rawNumber);
    if (!number) return { ok: false, error: 'bad_number' };
    const text = String(rawText == null ? '' : rawText).trim();
    if (!text) return { ok: false, error: 'empty_message' };
    if (text.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'message_too_long' };
    try {
      await request('send', { number, text }, 20000);
      // The phone writes the message into its own sent folder a moment later,
      // so the cached copy is dropped rather than left looking stale.
      msgCache('sent').at = 0;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || 'phone_error') };
    }
  }

  // The call log names most callers itself, but not all of them: an entry whose
  // contact was added after the call carries only a number. Resolving against
  // the phonebook fills those in without inventing anything — an unmatched
  // number stays a number.
  function withName(row) {
    if (row.name) return row;
    const hit = numbers.lookup(cache.contacts.index, row.number);
    return hit ? { ...row, name: hit.name } : row;
  }

  function byName(a, b) {
    const an = (a.name || '').toLowerCase();
    const bn = (b.name || '').toLowerCase();
    if (an && bn) return an.localeCompare(bn);
    if (an) return -1;
    if (bn) return 1;
    return 0;
  }

  return { contacts, calls, messageList, messageBody, sendMessage };
}

module.exports = { makeLists };
