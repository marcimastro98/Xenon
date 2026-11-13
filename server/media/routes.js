// What the engine answers about what is playing: the media state, the lyrics, their offset and
// their translation with its usage.

const { readBody } = require('../http/read-body.js');
const { lyricsTexts } = require('./lyrics-reply.js');
const { hub } = require('../settings/current.js');
const aiLocal = require('../ai-local.js');
const lyricsPrices = require('../lyrics-translate-price.js');
const aiXenon = require('../ai-xenon-credits.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /media': async (req, _res, { json, err500, urlObj }, { getMediaInfo, setMediaPreferredSource }) => {
    try {
      // ?source= changes the preferred player. Only from our own pages.
      const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      const foreignPage = fetchSite === 'cross-site' || fetchSite === 'same-site';
      if (urlObj.searchParams.has('source') && !foreignPage) setMediaPreferredSource(urlObj.searchParams.get('source'));
      json(await getMediaInfo());
    }
    catch (e) { err500(e.message); }
  },

  'GET /api/lyrics': async (_req, _res, { json }, { getCurrentLyrics }) => {
    // Lyrics for the song playing now. No parameters: the server reads its own
    // media session, so nothing from the page reaches the LRCLIB query.
    try { json(await getCurrentLyrics()); }
    catch (e) { json({ ok: false, state: 'error', error: String((e && e.message) || e) }); }
  },

  'POST /api/lyrics/offset': async (req, _res, { json, err500 }, { featureUnlock, lyricsForPlayingKey, lyricsOffsets }) => {
    // Supporter widget: this song's own timing, { key, ms } (0 = back to the
    // global one). Only for the song playing now. In CSRF_MUTATION_PATHS.
    try {
      if (!(await featureUnlock.isUnlocked('lyrics'))) { json({ ok: false, error: 'locked' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      const playing = await lyricsForPlayingKey(body.key);
      if (playing.status !== 200) { json({ ok: false, error: 'stale' }); return; }
      const ms = await lyricsOffsets.set(body.key, body.ms);
      json(ms === null ? { ok: false, error: 'bad_value' } : { ok: true, offsetMs: ms });
    } catch (e) { err500(e.message); }
  },

  'POST /api/lyrics/translate': async (req, _res, { json, err500 }, { featureUnlock, lyricsForPlayingKey, lyricsTranslateBlocker, lyricsTranslator }) => {
    // Supporter widget: translation and reading of the song playing now,
    // { key, lang, cachedOnly }. The lines come from the server's own lyrics
    // cache, never from the request. A request to the user's AI provider is made
    // only when they turned translation on, under the monthly cap, once per
    // song (lyrics-translator.js). In CSRF_MUTATION_PATHS.
    try {
      if (!(await featureUnlock.isUnlocked('lyrics'))) { json({ ok: false, error: 'locked' }); return; }
      const blocker = await lyricsTranslateBlocker();
      if (blocker) { json({ ok: false, error: blocker }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      const playing = await lyricsForPlayingKey(body.key);
      if (playing.status !== 200) { json({ ok: false, error: 'stale' }); return; }
      const texts = lyricsTexts(playing.entry);
      if (!texts) { json({ ok: false, error: 'no_lyrics' }); return; }
      json(await lyricsTranslator.translate({
        songKey: body.key, texts, lang: String(body.lang || '').slice(0, 5),
        reading: hub.settings.lyricsReading !== false,
        cap: hub.settings.lyricsTranslateCap, cachedOnly: body.cachedOnly === true,
      }));
    } catch (e) { err500(e.message); }
  },

  'GET /api/lyrics/translate/usage': async (_req, _res, { json, err500 }, { lyricsTranslator, readHubSettings, smallTaskModel }) => {
    // This month's translated songs and tokens, for the counter in the widget,
    // with what 100 songs cost on the model translation runs on. The model id
    // only, never a key.
    try {
      const settings = await readHubSettings().catch(() => null) || {};
      const provider = aiLocal.sanitizeProvider(settings.aiProvider);
      const model = await smallTaskModel(provider, settings);
      await lyricsPrices.refresh(); // the published price table, at most every 12 h
      const usage = await lyricsTranslator.usage(hub.settings.lyricsTranslateCap, model);
      // Bit on Sparks: the same estimate in Sparks, the unit the user pays in.
      if (provider === 'xenon' && usage.estimate) usage.estimate.sparks = Math.max(1, Math.round(usage.estimate.usd * aiXenon.SPARKS_PER_USD));
      json({ ok: true, ...usage });
    } catch (e) { err500(e.message); }
  },

  'POST|GET /media/source': async (req, _res, { json, err500, urlObj }, { setMediaPreferredSource }) => {
    try {
      let body = {};
      if (req.method === 'POST') body = JSON.parse(await readBody(req) || '{}');
      const source = body.source ?? urlObj.searchParams.get('source') ?? '';
      json({ ok: true, preferredSource: setMediaPreferredSource(source) });
    } catch (e) { err500(e.message); }
  },

  'POST|GET /media/playpause': async (_req, _res, { json, err500 }, { mediaAction }) => {
    try   { json(await mediaAction('playpause')); }
    catch (e) { err500(e.message); }
  },

  'POST|GET /media/next': async (_req, _res, { json, err500 }, { mediaAction }) => {
    try   { json(await mediaAction('next')); }
    catch (e) { err500(e.message); }
  },

  'POST|GET /media/previous': async (_req, _res, { json, err500 }, { mediaAction }) => {
    try   { json(await mediaAction('previous')); }
    catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
