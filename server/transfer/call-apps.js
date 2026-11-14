'use strict';
// The apps whose notifications can be a call, with how each is named and what it can be asked
// to do.

// ── The apps we ship a default entry for ────────────────────────────────────
// `match` is checked against BOTH the AUMID and the display name of the toast,
// folded and substring-matched, because a Win32 app's AUMID is often its exe
// path while a packaged app's is a PFN — and the display name is localised.
//
// `answer`/`decline` name a KEY COMBO plus the fact that the app window has to
// be focused first. That last part is not a detail: Zoom's own documentation
// lists which shortcuts may be promoted to global ones and the call shortcuts
// are NOT among them, and Teams' are plain in-app shortcuts. So "answer" is
// always focus-then-send, never send-and-hope.
//
// `mac` overrides the combo on macOS where the app differs there: Teams moves
// to Command, Zoom stays on Control. Getting that backwards sends a working
// shortcut to the wrong app, so both are written out rather than derived.
const DEFAULT_APPS = Object.freeze([
  Object.freeze({
    id: 'teams',
    name: 'Microsoft Teams',
    match: Object.freeze(['msteams', 'ms-teams', 'microsoft teams', 'teams.exe', 'microsoftteams']),
    answer: Object.freeze({ keys: 'ctrl+shift+s', mac: 'cmd+shift+s' }),
    answerVideo: Object.freeze({ keys: 'ctrl+shift+a', mac: 'cmd+shift+a' }),
    decline: Object.freeze({ keys: 'ctrl+shift+d', mac: 'cmd+shift+d' }),
  }),
  Object.freeze({
    id: 'zoom',
    name: 'Zoom',
    match: Object.freeze(['zoom.us', 'zoom.exe', 'zoom meetings', 'zoom workplace']),
    answer: Object.freeze({ keys: 'ctrl+shift+a', mac: 'ctrl+shift+a' }),
    decline: Object.freeze({ keys: 'ctrl+shift+d', mac: 'ctrl+shift+d' }),
  }),
  Object.freeze({
    id: 'discord',
    name: 'Discord',
    match: Object.freeze(['discord']),
    // Answering is the RPC join, not a shortcut — see calls.js. Kept in the
    // table so a Discord toast on a machine with RPC unlinked still raises a
    // card the user can act on by opening the app.
  }),
  Object.freeze({
    id: 'phonelink',
    name: 'Phone Link',
    match: Object.freeze(['phonelink', 'phone link', 'collegamento al telefono', 'yourphone']),
    // No API and no shortcut. The card can only ring and open the app.
    //
    // `phoneMirror` says this app is a WINDOW onto the phone rather than a
    // place a call lives. It matters since the phone feature landed: the OS now
    // tells us structurally that the phone is ringing, and that fact arrives
    // without a caller's name while this toast arrives with one. So a toast
    // from a mirror app does not raise a second card for the same call — it
    // fills in the name on the one already ringing. See calls.onNotification.
    phoneMirror: true,
  }),
  Object.freeze({
    id: 'whatsapp',
    name: 'WhatsApp',
    match: Object.freeze(['whatsapp']),
  }),
  Object.freeze({
    id: 'signal',
    name: 'Signal',
    match: Object.freeze(['signal']),
  }),
  Object.freeze({
    id: 'slack',
    name: 'Slack',
    match: Object.freeze(['slack']),
  }),
  Object.freeze({
    id: 'meet',
    name: 'Google Meet',
    match: Object.freeze(['meet.google.com', 'google meet']),
  }),
]);

module.exports = { DEFAULT_APPS };
