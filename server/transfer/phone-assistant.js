// What the assistant may do with the phone: look a contact up, start a call, write a message.

const callDetect = require('../call-detect.js');
const aiPcApps = require('../ai-pc-apps.js');
const { phoneSettings } = require('./phone-settings.js');
const { phone } = require('./engine-phone.js');

// Whether a Deck key that dials or texts can actually do anything on this
// machine. Read from the last status the helper gave rather than probed here:
// the catalog is fetched while the editor is open, and a Bluetooth round trip
// on that path would stall the whole key list. Off, unsupported or no dialable
// line all answer false, which is what hides the key instead of offering one
// that fails when pressed.
// The AI's three phone tools, in one place because they share one rule: the
// recipient comes from the user's own phonebook, never from the model.
//
// The two write tools are NOT equally guarded, and the difference is what each
// mistake costs. A wrong call is hung up in two seconds, so a dictated number
// is allowed there. A wrong TEXT reaches a stranger permanently and cannot be
// recalled, so `phone_message` refuses anything but a resolved contact — the
// blast radius of a misheard name becomes "texted the wrong person in your
// contacts" instead of "texted a number nobody has ever seen".
async function aiPhoneTool(fnName, args, latestUserText = '') {
  const a = args && typeof args === 'object' ? args : {};
  if (phoneSettings().enabled !== true) return { error: 'phone_disabled' };

  // Resolve a spoken name against the phonebook. Substring, case- and
  // accent-insensitive, so "papa" finds "Papà" — the fold the call classifier
  // already uses for the same job.
  const findByName = async (name) => {
    const needle = callDetect.foldText(name || '');
    if (!needle) return [];
    const book = await phone.contacts();
    return (book.list || []).filter(c => callDetect.foldText(c.name).includes(needle));
  };

  if (fnName === 'phone_lookup') {
    if (!a.name) {
      const log = await phone.calls();
      if (!log.ok && !log.list.length) return { error: log.reason || 'phone_unavailable' };
      return { calls: log.list.slice(0, 15).map(c => ({ name: c.name, number: c.number, direction: c.direction, at: c.at })) };
    }
    const hits = await findByName(a.name);
    if (!hits.length) return { matches: [], note: 'nobody in the phonebook matches that name' };
    return { matches: hits.slice(0, 8).map(c => ({ name: c.name, numbers: c.numbers.map(n => n.value) })) };
  }

  if (fnName === 'phone_call') {
    let number = String(a.number || '').trim();
    let who = '';
    if (a.name) {
      const hits = await findByName(a.name);
      // Ambiguity is handed back rather than resolved by picking the first:
      // "chiama Marco" with two Marcos is a question, not a call.
      if (hits.length > 1) return { error: 'ambiguous', matches: hits.slice(0, 8).map(c => c.name) };
      if (!hits.length && !number) return { error: 'no_such_contact' };
      if (hits.length === 1 && hits[0].numbers.length) {
        number = hits[0].numbers[0].value;
        who = hits[0].name;
      }
    }
    if (!number) return { error: 'no_number' };
    // A number that is not a contact's must be one the user typed or said in
    // this request. The tool has no confirmation card, and a number the
    // assistant read somewhere (a web page, a message) could be a premium-rate
    // line that costs the user money.
    if (!who && !aiPcApps.numberSaidByUser(number, latestUserText)) {
      return { error: 'number_not_from_user', note: 'only a contact, or a number the user gave in this request, can be called' };
    }
    const r = await phone.dial(number);
    return r.ok ? { ok: true, calling: who || number } : { error: r.error || 'dial_failed' };
  }

  // phone_message
  const text = String(a.text || '').trim();
  if (!text) return { error: 'empty_message' };
  const hits = await findByName(a.name);
  if (!hits.length) return { error: 'no_such_contact', note: 'a text can only be sent to somebody already in the phonebook' };
  if (hits.length > 1) return { error: 'ambiguous', matches: hits.slice(0, 8).map(c => c.name) };
  const to = hits[0].numbers[0];
  if (!to) return { error: 'contact_has_no_number' };
  const r = await phone.sendMessage(to.value, text);
  return r.ok ? { ok: true, sentTo: hits[0].name, text } : { error: r.error || 'send_failed' };
}

module.exports = { aiPhoneTool };
