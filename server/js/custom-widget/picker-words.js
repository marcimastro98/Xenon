// The words of the list a widget is picked from: its categories, why a folder was skipped, the
// search as typed, and text compared without accents.
'use strict';

(() => {
  // Categories are derived from what a manifest DECLARES (its data streams),
  // never from a free-text field a package could put anything in — so the chips
  // stay meaningful no matter who authored the widget. A chip is only rendered
  // when at least one listed widget falls in it, so tapping one can never empty
  // the list on its own.
  const PICK_CATS = [
    { id: 'system', key: 'cw_cat_system', fb: 'System', streams: ['status', 'system', 'sensors', 'perf', 'battery', 'processes', 'scriptStates'] },
    { id: 'media', key: 'cw_cat_media', fb: 'Media', streams: ['media', 'audio', 'audioLevels', 'wavelink', 'voicemeeter'] },
    { id: 'stream', key: 'cw_cat_stream', fb: 'Streaming', streams: ['obs', 'streamerbot', 'discord', 'discordChannels', 'discordSoundboard', 'discordNotifications', 'twitchWatch', 'twitchChat', 'youtubeLive'] },
    { id: 'info', key: 'cw_cat_info', fb: 'Info', streams: ['weather', 'stocks', 'football', 'news'] },
    { id: 'work', key: 'cw_cat_work', fb: 'Productivity', streams: ['tasks', 'notes', 'agenda', 'claude', 'codex'] },
    { id: 'home', key: 'cw_cat_home', fb: 'Smart home', streams: ['homeassistant', 'lighting', 'homeEvents'] },
  ];
  // Below this many entries the list is already scannable and the filter bar
  // would cost more tile height than it saves.
  const PICK_FILTER_MIN = 6;
  // Why the rescan skipped a folder, in words. GET /sdk/widgets has always
  // returned these alongside the packages and nothing ever displayed them, so a
  // package whose manifest fails validation was installed, listed as "Installed"
  // in the Store, and absent from this picker with nothing said anywhere —
  // indistinguishable from a search that simply found nothing.
  // Only the reasons a user can act on get a sentence. Anything else falls
  // through as its raw code on purpose: an unexplained code is still the thing
  // that gets pasted into a bug report, and swallowing it is how this became
  // invisible in the first place.
  const PICK_BROKEN_REASONS = {
    missing_manifest: { key: 'cw_pick_broken_no_manifest', fb: 'its manifest.json is missing' },
    bad_manifest: { key: 'cw_pick_broken_bad_manifest', fb: 'its manifest.json could not be read' },
    missing_entry: { key: 'cw_pick_broken_no_entry', fb: 'the file it names as its entry point is missing' },
    unsupported_api: { key: 'cw_pick_broken_api', fb: 'it was built for a different SDK version' },
  };
  // A folder full of junk must not push the widgets off the panel.
  const PICK_BROKEN_MAX = 6;
  // Search text and active chip, per tile instance. Kept outside the DOM so a
  // repaint (a rescan, a package install) doesn't drop what the user typed.
  const pickFilter = new Map();

  // Accent- and case-insensitive, so "meteo" finds "Météo" and vice versa.
  function pickNorm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  // Category ids an entry belongs to. Anything matching none — a clock, a
  // decorative tile — lands in 'other' so no widget is unreachable by chip.
  function pickCatsOf(streams) {
    const have = new Set(Array.isArray(streams) ? streams : []);
    const hits = PICK_CATS.filter(c => c.streams.some(s => have.has(s))).map(c => c.id);
    return hits.length ? hits : ['other'];
  }

  window.CustomWidgetPickerWords = {
    PICK_CATS, PICK_FILTER_MIN, PICK_BROKEN_REASONS, PICK_BROKEN_MAX, pickFilter, pickNorm,
    pickCatsOf,
  };
})();
