// The shape every note and timer id must have, because ids end up inside the page.

// The shape every note and timer id must have. Ids end up in the dashboard's
// attributes and CSS selectors (data-note-id, data-timer-time="<id>"), so one
// carrying a quote or a bracket could break out of them. Every id this app mints
// (_noteId, the timer id below, the dashboard's own note ids) already fits;
// anything else — a hand-edited file, a tampered backup — gets a fresh one.
const SAFE_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

module.exports = { SAFE_ITEM_ID_RE };
