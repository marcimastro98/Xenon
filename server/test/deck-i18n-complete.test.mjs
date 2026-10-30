// The Deck speaks every language. Spanish, French, German, Portuguese and
// Russian start from `...i18n.en`, so a Deck string nobody translated does not
// show a key or an error: it quietly shows English. That is how about 360 Deck
// labels and hints read English in five languages for several releases. Here a
// Deck string may equal the English only when the English is a name or a word
// that is honestly the same in some language (OBS, URL, Volume, Mode...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// Everything above the first top-level function is data (see i18n-widget-keys).
function dictionaries() {
  const cut = SRC.search(/^function /m);
  assert.ok(cut > 0, 'the data/behaviour split in i18n.js moved');
  const ctx = { module: {} };
  vm.runInNewContext(SRC.slice(0, cut) + '\nthis.i18n = i18n;', ctx);
  return ctx.i18n;
}

const SAME_EVERYWHERE = new Set([
  // Names of products, services and protocols.
  'Xenon AI', 'Bit', 'Game Companion', 'Claude Code', 'Discord', 'Discord: soundboard', 'OBS', 'OBS: streaming', 'Streamer.bot',
  'Streamer.bot: code trigger', 'Code trigger', 'Spotify', 'Spotify: shuffle', 'Spotify: volume', 'Home Assistant',
  'Razer Chroma', 'Chroma Link', 'Wave Link', 'Voicemeeter', 'Twitch', 'YouTube', 'Kick', 'Trovo', 'Webhook', 'URL',
  'GET', 'POST', 'LCD', 'Steam AppID', 'Emoji', 'Push-to-talk', 'Bus (A1, B2…)', 'Arguments (JSON)',
  'Action (widget/id)', 'Macro (widget/id)',
  // The Vitals feature's name, kept as is by several languages.
  'Vitals',
  // Words that are the same in at least one of the languages.
  '1 minute',
  'Alarm', 'Area', 'Desktop', 'Downloads', 'Documents', 'GIF', 'Vertical 9:16', 'Timelapse', 'Webcam', 'Screenshots', 'Videos', 'Volume','Volume −', 'Volume +', 'Auto', 'Cycle', 'Color', 'Color 1', 'Color 2', 'Neon', 'Comic', 'Audio',
  'Communication', 'Media', 'Widgets', 'Soundboard', 'Streaming', 'Stream', 'System', 'Timers', 'Col', 'Label',
  'Action', 'Animation', 'Type', 'Direction', 'Diagonal', 'Radial', 'Vertical', 'Horizontal', 'Image', 'Standby',
  'Aurora', 'Headset', 'Keypad', 'Local', 'Mouse', 'Palette', 'Pause', 'Shuffle (on/off)', 'App', 'Body', 'Project',
  'Description', 'Effect', 'effect', 'Message', 'Minutes', 'Mix', 'Mode', 'Page', 'Platform', 'Prompt', 'Sound',
  'Notifications', 'Source', 'Style', 'Text', 'Carbon', 'Graphite', 'Flash', 'Benchmark', 'Screenshot', 'Capture', 'Dashboard',
  // NVIDIA's name for the feature, kept by its German, Dutch and Italian users.
  'Instant Replay',
  // Colour formats, written the same everywhere; French and German say Format.
  'HEX', 'RGB', 'HSL', 'Format',
]);

test('every Deck string is translated in all 11 languages', () => {
  const I = dictionaries();
  const langs = Object.keys(I);
  assert.equal(langs.length, 11);
  const untranslated = [];
  for (const [k, en] of Object.entries(I.en)) {
    if (!k.startsWith('deck_') || typeof en !== 'string') continue;
    for (const l of langs) {
      if (l === 'en') continue;
      assert.ok(k in I[l], `${l} has ${k}`);
      if (I[l][k] === en && /[a-z]{3}/i.test(en) && !SAME_EVERYWHERE.has(en)) untranslated.push(`${l}.${k}: ${en}`);
    }
  }
  assert.deepEqual(untranslated, []);
});

// The same leak happened all over the app (about 1,100 strings each in five
// languages). Short labels can honestly match English, so outside the Deck the
// guard is on phrases: three or more words left in English is a miss, unless it
// is a name, a code or a menu path of another program.
const PHRASES_KEPT = new Set([
  'disk_modal_title', 'tab_system_sub', 'preset_redeem_placeholder', 'preset_redeem_placeholder2', 'settings_wl_title',
  'settings_sb_host_desc', 'settings_obs_host_hint', 'feed_url', 'settings_bg_image_loaded', 'settings_ai_live',
  'deck_act_sbCodeTrigger', 'desktop_title',
]);
const wordCount = (s) => (s.replace(/\{\w+\}|<[^>]+>|https?:\S+/g, '').match(/[A-Za-z]{3,}/g) || []).length;

test('no phrase anywhere in the app is left in English', () => {
  const I = dictionaries();
  const untranslated = [];
  for (const [k, en] of Object.entries(I.en)) {
    if (typeof en !== 'string' || wordCount(en) < 3 || PHRASES_KEPT.has(k)) continue;
    for (const l of Object.keys(I)) {
      if (l !== 'en' && (!(k in I[l]) || I[l][k] === en)) untranslated.push(`${l}.${k}: ${en.slice(0, 60)}`);
    }
  }
  assert.deepEqual(untranslated, []);
});

test('a translation keeps every placeholder and tag of the English', () => {
  const I = dictionaries();
  const holes = (s) => (s.match(/\{\w+\}|<\/?[a-z][^<>]*>/gi) || []).sort().join();
  const broken = [];
  for (const [k, en] of Object.entries(I.en)) {
    if (typeof en !== 'string') continue;
    for (const l of Object.keys(I)) {
      const v = I[l][k];
      if (l !== 'en' && typeof v === 'string' && holes(v) !== holes(en)) broken.push(`${l}.${k}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('a Deck string sits in its own language block', () => {
  // The Spotify "Play inside" label once had all ten languages written into the
  // Italian block, so nine languages showed Italian's neighbour or nothing.
  const I = dictionaries();
  assert.equal(I.it.deck_param_context_uri, 'Riproduci dentro (URI album o playlist)');
  assert.equal(I.de.deck_param_context_uri, 'Abspielen innerhalb (Album- oder Playlist-URI)');
  assert.equal(I.en.deck_param_context_uri, 'Play inside (album or playlist URI)');
  assert.equal((SRC.match(/deck_param_context_uri:/g) || []).length + (SRC.match(/"deck_param_context_uri":/g) || []).length, 11);
});
