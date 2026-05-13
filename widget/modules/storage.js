'use strict';

/**
 * modules/storage.js — localStorage persistence helpers.
 *
 * All keys are prefixed with "xenonhub." to avoid collisions.
 */
(function () {
  const Hub = window.XenonEdgeHub;

  const KEY_NOTES  = 'xenonhub.notes';
  const KEY_EVENTS = 'xenonhub.events';
  const KEY_LAYOUT = 'xenonhub.layout.v1';

  function scopedKey (key) {
    try {
      if (typeof uniqueId !== 'undefined' && uniqueId) return `${uniqueId}.${key}`;
    } catch (_) { /* browser development mode */ }
    return key;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  Hub.loadNotes = function () {
    try {
      Hub.state.notes = localStorage.getItem(KEY_NOTES) || '';
    } catch (_) {
      Hub.state.notes = '';
    }
    const area = document.getElementById('notes-area');
    if (area) area.value = Hub.state.notes;
  };

  Hub.saveNotes = function (text) {
    Hub.state.notes = text;
    try {
      localStorage.setItem(KEY_NOTES, text);
    } catch (_) { /* storage full — ignore */ }
  };

  // ── Calendar events ───────────────────────────────────────────────────────

  Hub.loadEvents = function () {
    try {
      const raw = localStorage.getItem(KEY_EVENTS);
      Hub.state.events = raw ? JSON.parse(raw) : [];
    } catch (_) {
      Hub.state.events = [];
    }
    Hub.state.calendarLoaded = true;
  };

  Hub.saveEvents = function () {
    try {
      localStorage.setItem(KEY_EVENTS, JSON.stringify(Hub.state.events));
    } catch (_) { /* ignore */ }
  };

  /**
   * If the server is online, tries to sync events from it.
   * Server is the source of truth; overwrites localStorage on success.
   */
  Hub.syncEventsFromServer = async function () {
    if (!Hub.state.serverOnline) return;
    try {
      const data = await Hub.fetchJson('/events');
      if (data && Array.isArray(data.events)) {
        Hub.state.events = data.events;
        Hub.saveEvents();
      }
    } catch (_) { /* server unavailable — keep localStorage version */ }
  };

  /**
   * Persists events to localStorage and, when server is online, to the server.
   */
  Hub.persistEvents = async function () {
    Hub.saveEvents();
    if (!Hub.state.serverOnline) return;
    try {
      const raw = JSON.stringify(Hub.state.events);
      // Only sync via GET if the payload fits in a safe URL length.
      if (raw.length <= 6000) {
        await Hub.fetchJson('/events?save=1&data=' + encodeURIComponent(raw));
      }
    } catch (_) { /* ignore — already saved locally */ }
  };

  // ── Dashboard layout ─────────────────────────────────────────────────────

  /**
   * Reads persisted dashboard layout preferences.
   * @returns {object|null} Saved layout object, or null when not available.
   */
  Hub.readLayoutPreferences = function () {
    try {
      const raw = localStorage.getItem(scopedKey(KEY_LAYOUT)) || localStorage.getItem(KEY_LAYOUT);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  };

  /**
   * Persists dashboard layout preferences for this widget instance.
   * @param {object} layout Preferences to save.
   * @returns {void}
   */
  Hub.writeLayoutPreferences = function (layout) {
    try {
      localStorage.setItem(scopedKey(KEY_LAYOUT), JSON.stringify(layout));
    } catch (_) { /* storage full — keep runtime layout only */ }
  };
}());
