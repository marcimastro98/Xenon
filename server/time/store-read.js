// Reads the saved calendar events and the saved tasks; a file that is not there yet is an empty
// list.

const fs = require('node:fs');
const { normalizeTasks } = require('./tasks-normalize.js');
const { normalizeEvents } = require('./events-normalize.js');
const { EVENTS_FILE, TASKS_FILE } = require('./store-files.js');

async function readEvents() {
  try {
    const raw = await fs.promises.readFile(EVENTS_FILE, 'utf8');
    return normalizeEvents(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function readTasks() {
  try {
    const raw = await fs.promises.readFile(TASKS_FILE, 'utf8');
    return normalizeTasks(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

module.exports = { readEvents, readTasks };
