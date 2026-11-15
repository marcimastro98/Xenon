// Reads the calendar feeds the user added and keeps their events and the state of each feed.

const icsFeeds = require('./ics-feeds.js');
const { readHubSettings } = require('../settings/read.js');
const { agendaState } = require('./agenda-state.js');
const { feedsRefresh } = require('./feeds-refresh-state.js');

async function refreshExternalFeeds() {
  if (feedsRefresh.refreshing) return agendaState.externalFeeds;
  feedsRefresh.refreshing = true;
  try {
    const settings = await readHubSettings().catch(() => null);
    const feeds = (settings && Array.isArray(settings.calendarFeeds)) ? settings.calendarFeeds : [];
    const results = await Promise.all(feeds.map(f => icsFeeds.loadFeed(f)));
    const events = [];
    const status = [];
    for (let i = 0; i < feeds.length; i++) {
      const r = results[i];
      status.push({ id: feeds[i].id, name: feeds[i].name, status: r.status, error: r.error, count: r.count, reminders: feeds[i].reminders });
      if (r.events && r.events.length) events.push(...r.events);
    }
    agendaState.externalFeeds = { feeds: status, events, refreshedAt: Date.now() };
  } catch (e) {
    // Keep last good cache; record nothing sensitive.
  } finally {
    feedsRefresh.refreshing = false;
  }
  return agendaState.externalFeeds;
}

module.exports = { refreshExternalFeeds };
