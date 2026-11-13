// Where the notes, calendar events, tasks and timers are kept in the user's data folder.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

// Legacy single-blob notes store. Kept only as a migration source: readNotes()
// promotes it to the structured notes.json on first read. The plain-text /notes
// API (iCUE widget, AI, backup) now derives from the structured store.
const NOTES_FILE = path.join(DATA_DIR, 'notes.txt');
const NOTES_JSON = path.join(DATA_DIR, 'notes.json');

const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const TIMERS_FILE = path.join(DATA_DIR, 'timers.json');

module.exports = { NOTES_FILE, NOTES_JSON, EVENTS_FILE, TASKS_FILE, TIMERS_FILE };
