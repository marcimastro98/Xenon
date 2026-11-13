// The streaming tiles on the Liquid look (Twitch, YouTube, OBS, Discord): one sheet of
// rules loaded after the Liquid tiles, the state as a word in every language, faders
// and the seek line without a handle, and nothing changed off Liquid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { selectorsOf, topRules, declsIn } from './css-rules.mjs';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SHEET = read('../styles/liquid-streaming.css');
const TILES = read('../styles/liquid-tiles.css');
const I18N = appStringsSource().replace(/\r\n/g, '\n');
const LINK = '<link rel="stylesheet" href="styles/liquid-streaming.css">';
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

const RULES = topRules(SHEET);
const LIQUID = ':root[data-style="liquid"] ';
const declsFor = (selector) => declsIn(RULES, selector);

function langsDefining(key) {
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    if (line.trimStart().startsWith(key + ':')) found.add(current);
  }
  return found;
}

test('the dashboard and the light layer page load the sheet once, after the Liquid tiles', () => {
  for (const page of ['../index.html', '../layer-lite.html']) {
    const html = read(page);
    const tiles = html.indexOf('<link rel="stylesheet" href="styles/liquid-tiles.css">');
    const at = html.indexOf(LINK);
    assert.ok(tiles > 0 && at > tiles, `${page}: after liquid-tiles.css`);
    assert.equal(html.indexOf(LINK, at + 1), -1, `${page}: linked once`);
  }
});

test('every rule is for the Liquid look only', () => {
  const selectors = selectorsOf(SHEET);
  assert.ok(selectors.length > 120);
  for (const s of selectors) assert.match(s, /^:root\[data-style="liquid"\] /, s);
});

test('the rules moved here are no longer in the Liquid tiles sheet', () => {
  const moved = ['dc-tab', 'dc-pill', 'obs-pill', 'dc-chip', 'dc-member', 'twitch-status-pill', 'ytl-pill',
    'tww-ib', 'yt-ib', 'ytl-ib', 'ytl-mini', 'ytl-btn', 'twitch-act-btn', 'twitch-act-len',
    'sbw-tab', 'sbw-pill', 'sbw-evt-amt'];
  // The shared "chosen" rule there still names a chip that is on (`.dc-chip.is-on`).
  for (const cls of moved) assert.doesNotMatch(TILES, new RegExp(`\\.${cls}(?![\\w.-])`), cls);
});

test('the faders and the seek line have no handle to draw', () => {
  const thumbs = [...SHEET.matchAll(/::-(?:webkit-slider|moz-range)-thumb \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(thumbs.length >= 4, 'webkit and moz, for the faders and the seek line');
  for (const body of thumbs) {
    assert.match(body, /background: transparent;/);
    assert.doesNotMatch(body, /box-shadow: (?!none)/);
  }
  // The level is the fill: each widget writes it as the value moves.
  assert.match(read('../js/obs-widget.js'), /\.obs-audio-slider'\); if \(s\) s\.style\.setProperty\('--fill', pct\)/);
  assert.match(read('../js/discord-widget.js'), /range\.style\.setProperty\('--fill', /);
  assert.match(read('../js/youtube-widget.js'), /seek\.style\.setProperty\('--fill', /);
});

test('the state words are translated in every language the app ships', () => {
  for (const key of ['stream_live', 'obs_recording', 'dc_vol_mic', 'dc_vol_out']) {
    const have = langsDefining(key);
    assert.deepEqual(LANGS.filter((l) => !have.has(l)), [], key);
  }
  const obs = read('../js/obs-widget.js');
  assert.match(obs, /t\('stream_live', 'Live'\)/);
  assert.match(obs, /t\('obs_recording', 'Recording'\)/);
  for (const file of ['../js/obs-widget.js', '../js/streaming-page.js', '../js/youtubelive-widget.js']) {
    assert.doesNotMatch(read(file), /'(?:LIVE|REC)'/, `${file}: no word in capitals by hand`);
  }
});

test('a line of facts is one span each: a dot sets them apart off Liquid, space on it', () => {
  const dot = (css, sel) => assert.match(css, new RegExp(`:root:not\\(\\[data-style="liquid"\\]\\) ${sel} > span \\+ span::before \\{ content: '\\\\00a0· '; \\}`));
  dot(read('../components/YouTubeWidget/YouTubeWidget.css'), '\\.yt-now-sub');
  dot(read('../components/TwitchWatchWidget/TwitchWatchWidget.css'), ':is\\(\\.tww-now-sub, \\.tww-row-sub\\)');
  dot(read('../components/YouTubeLiveWidget/YouTubeLiveWidget.css'), '\\.ytl-stats');
  assert.match(SHEET, /:is\(\.yt-now-sub, \.tww-now-sub, \.ytl-stats\) \{ display: flex; column-gap: 12px;/);
});

test('setWordParts writes one span per word and leaves an unchanged line alone', () => {
  const src = read('../js/utils.js');
  const fn = (name) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src.replace(/\r\n/g, '\n'))[0];
  const made = [];
  const node = () => ({
    dataset: {}, children: [], className: '', textContent: '',
    get childElementCount() { return this.children.length; },
    replaceChildren(...kids) { this.children = kids; },
  });
  const box = { document: { createElement: (tag) => { const n = node(); n.tag = tag; made.push(n); return n; } } };
  vm.runInNewContext(`${fn('makeEl')}\n${fn('setWordParts')}\nthis.setWordParts = setWordParts;`, box);
  const line = node();
  box.setWordParts(line, ['Slow City', '', null, 3]);
  assert.deepEqual(line.children.map((c) => [c.tag, c.textContent]), [['span', 'Slow City'], ['span', '3']]);
  const before = made.length;
  box.setWordParts(line, ['Slow City', 3]);
  assert.equal(made.length, before, 'the same words build nothing');
  box.setWordParts(line, []);
  assert.equal(line.children.length, 0);
});

test('a narrow library keeps the other tabs as icons at the component\'s own width', () => {
  const yt = read('../components/YouTubeWidget/YouTubeWidget.css');
  const tw = read('../components/TwitchWatchWidget/TwitchWatchWidget.css');
  assert.match(yt, /@container ytlib \(max-width: 380px\) \{\s*\.yt-logo \{ display: none; \}\s*\.yt-tab:not\(\.is-on\) \.yt-tab-lbl \{ display: none; \}/);
  assert.match(tw, /@container twwlib \(max-width: 330px\) \{\s*\.tww-logo \{ display: none; \}\s*\.tww-tab:not\(\.is-on\) \.tww-tab-lbl \{ display: none; \}/);
  // Hiding the icons below those widths would leave the other tabs with nothing on them.
  assert.match(SHEET, /@container ytlib not \(max-width: 380px\) \{ :root\[data-style="liquid"\] \.yt-tab-ico \{ display: none; \} \}/);
  assert.match(SHEET, /@container twwlib not \(max-width: 330px\) \{ :root\[data-style="liquid"\] \.tww-tab-ico \{ display: none; \} \}/);
  assert.doesNotMatch(SHEET, /:is\(\.yt-tab-ico, \.tww-tab-ico\) \{ display: none; \}/);
});

test('Discord: big faces need height and width, the wide short strip starts below that height', () => {
  const big = /@container dcw \(min-height: (\d+)px\) and \(min-width: (\d+)px\) \{/.exec(SHEET);
  const strip = /@container dcw \(min-width: (\d+)px\) and \(max-height: (\d+)px\) \{/.exec(SHEET);
  assert.ok(big && strip);
  assert.equal(Number(strip[2]), Number(big[1]) - 1, 'one height decides between them');
  assert.ok(Number(big[2]) > 390, 'a phone column keeps the small faces');
  assert.match(SHEET, /\.dc-wrap \{ container: dcw \/ size; \}/);
  assert.match(read('../components/DiscordWidget/DiscordWidget.css'), /\.dc-wrap \{[^}]*width: 100%[^}]*height: 100%/);
});

test('the library\'s open tab names the tile: no service name before it on Liquid', () => {
  assert.match(SHEET, /:root\[data-style="liquid"\] :is\(\.yt-logo, \.tww-logo\) \{ display: none; \}/);
  // Only the headers still style the service's name as a title.
  assert.doesNotMatch(SHEET, /\.dc-logo, \.yt-logo/);
});

test('OBS on a wide, short tile: the preview on the left, the other cards beside it in the user\'s order', () => {
  assert.match(SHEET, /\.obs-wrap \{ container: obsw \/ size; \}/);
  assert.match(read('../components/ObsWidget/ObsWidget.css'), /\.obs-wrap \{[^}]*width: 100%; height: 100%;/);
  const wide = /@container obsw \(min-aspect-ratio: 12 \/ 5\) and \(min-width: 640px\) \{([\s\S]*?)\n\}/.exec(SHEET);
  assert.ok(wide, 'the wide layout');
  assert.match(wide[1], /\.obs-card--preview \{ grid-column: 1; grid-row: 1 \/ -1;/);
  // Placed by column only, so the order the user saved still sorts the right column.
  assert.match(wide[1], /\.obs-cards > :not\(\.obs-card--preview\) \{ grid-column: 2; min-height: 0; \}/);
  assert.doesNotMatch(wide[1], /order:/);
});

test('YouTube Live chat roles take darker shades on a light surface', () => {
  const css = read('../components/YouTubeLiveWidget/YouTubeLiveWidget.css');
  for (const role of ['owner', 'mod', 'sponsor']) {
    const dark = new RegExp(`^\\.ytl-msg-who\\.is-${role} \\{ color: (#[0-9a-f]{6}); \\}`, 'm').exec(css);
    const light = new RegExp(`^:root\\[data-appearance="light"\\] \\.ytl-msg-who\\.is-${role} \\{ color: (#[0-9a-f]{6}); \\}`, 'm').exec(css);
    assert.ok(dark && light, role);
    const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    // At least 4.5:1 against white, the AA line for small text.
    assert.ok(1.05 / (lum(light[1]) + 0.05) >= 4.5, `${role} ${light[1]}`);
  }
});

test('a viewer\'s name colour reaches the CSS as a variable, made readable on light surfaces', () => {
  for (const [js, css, cls] of [
    ['../js/streaming-page.js', '../components/TwitchPanel/TwitchPanel.css', 'twitch-chat-user'],
    ['../js/twitchwatch-widget.js', '../components/TwitchWatchWidget/TwitchWatchWidget.css', 'tww-chat-user'],
  ]) {
    const src = read(js);
    assert.match(src, /if \(entry\.color\) u\.style\.setProperty\('--name', entry\.color\);/);
    assert.doesNotMatch(src, /u\.style\.color = /);
    const sheet = read(css);
    assert.match(sheet, new RegExp(`\\.${cls} \\{ font-weight: 800; color: var\\(--name, #a970ff\\); \\}`));
    // Guarded: a browser without relative colours would otherwise drop the colour altogether.
    assert.match(sheet, new RegExp(`@supports \\(color: oklch\\(from red l c h\\)\\) \\{\\s*:root\\[data-appearance="light"\\] \\.${cls} \\{ color: oklch\\(from var\\(--name, #a970ff\\) min\\(l, 0\\.5\\) c h\\); \\}`));
  }
});

test('Streamer.bot: the state is a word, the tabs are words, no event or value sits on a plate', () => {
  const on = (sel) => declsFor(LIQUID + sel);
  // The state: a word, green while Streamer.bot answers, with no dot or badge beside it.
  assert.equal(on('.sbw-pill').background, 'none');
  assert.equal(on('.sbw-pill').padding, '0');
  assert.equal(on('.sbw-pill')['text-transform'], 'none');
  assert.equal(on('.sbw-pill.is-live').color, 'var(--color-success)');
  for (const sel of ['.sbw-pill-dot', '.sbw-logo']) assert.equal(on(sel).display, 'none', sel);
  // The tabs: words as Discord's, the open one bright, not a well of plates.
  for (const sel of ['.sbw-tabs', '.sbw-tab', '.sbw-tab.is-active']) assert.equal(on(sel).background, 'none', sel);
  assert.equal(on('.sbw-tab.is-active').color, 'var(--text)');
  // The feed and the globals are lines, not cards; an amount is words, not a tag.
  for (const sel of ['.sbw-evt', '.sbw-evt-ico', '.sbw-evt-amt', '.sbw-global']) assert.equal(on(sel).background, 'none', sel);
  assert.equal(on('.sbw-evt-amt').padding, '0');
  assert.equal(on('.sbw-global')['border-bottom'], '1px solid var(--lg-sep)');
  assert.equal(on('.sbw-global:last-child')['border-bottom'], '0');
  // The glyph is as tall as the name's line, so the two sit on one line whatever follows.
  assert.equal(on('.sbw-evt-ico').height, on('.sbw-evt-line')['line-height']);
  // The classes the widget really sets.
  const js = read('../js/streamerbot-widget.js');
  assert.match(js, /pill\.classList\.toggle\('is-live', connected\)/);
  assert.match(js, /tb\.classList\.toggle\('is-active', /);
});

test('a tile waiting for an account offers one key in its middle, and only while it waits', () => {
  for (const [tile, file] of [['yt', 'youtube-widget'], ['tww', 'twitchwatch-widget'], ['ytl', 'youtubelive-widget']]) {
    const key = declsFor(`${LIQUID}.${tile}-setup`);
    assert.equal(key.margin, 'auto', tile);
    assert.equal(key.width, 'auto', tile);
    assert.equal(key['justify-content'], 'center', tile);
    assert.ok(parseInt(key['min-height'], 10) >= 44, `${tile}: a touch target`);
    // The cards give up their room only while the key shows: a linked tile keeps its layout.
    const cards = RULES.flatMap((r) => r.selectors).find((s) => s.endsWith(` > .${tile}-cards`));
    assert.match(cards, /:has\(> :is\([^)]*\):not\(\[hidden\]\)\)/, tile);
    assert.equal(declsFor(cards).flex, '0 1 auto', tile);
    // That needs the widget to hide its key with the attribute once linked.
    const src = read(`../js/${file}.js`);
    assert.match(src, new RegExp(`const setup = mount\\.querySelector\\('\\.${tile}-setup'\\);`), file);
    assert.match(src, /setup\.hidden = connected !== false;/, file);
  }
});

test('the account menu and the emote picker are opaque panels, in a widget window too', () => {
  for (const sel of ['.tww-acct-pop', '.tww-emopick.is-open']) {
    const d = declsFor(LIQUID + sel);
    // No blur inside a tile, so only a solid panel keeps the chat behind from reading through.
    assert.equal(d.background, 'rgb(var(--panel-rgb))', sel);
    assert.equal(d['backdrop-filter'], undefined, sel);
    // The --lg-* tokens come from liquid-chrome.css, which a widget window does not load.
    const uses = [...`${d['border-color']} ${d['box-shadow']}`.matchAll(/var\((--lg-[\w-]+)(,?)/g)];
    assert.ok(uses.length >= 3, sel);
    for (const m of uses) assert.equal(m[2], ',', `${sel}: ${m[1]} needs a fallback`);
  }
  assert.doesNotMatch(read('../layer-lite.html'), /liquid-chrome\.css/);
  assert.match(read('../styles/global.css'), /--panel-rgb:/);
});

test('OBS neither set up nor found dims its keys instead of offering Go live', () => {
  const d = declsFor(`${LIQUID}.obs-wrap.obs-disconnected .obs-card--controls`);
  assert.ok(Number(d.opacity) <= 0.5);
  assert.equal(d['pointer-events'], 'none');
  // Only then: OBS running here with no host in Settings still counts as found.
  assert.match(read('../js/obs-widget.js'), /const off = configured === false && !reachable;[\s\S]*?classList\.toggle\('obs-disconnected', off\)/);
});
