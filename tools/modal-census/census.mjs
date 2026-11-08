// Every dialog of the app on the built demo, one picture each, to judge them side by side.
// Needs docs/demo: run `node tools/build-demo.mjs` first when the app changed. Serves a copy, never 3030.
// usage: node tools/modal-census/census.mjs <out dir> [--size monitor|edge|laptop|tablet|phone|WxH] [--light]
//        [--style liquid|glass|retro|comic] [--only a,b] [--pre "js before the target"]
// Low power: --pre "document.body.classList.add('low-power-gpu')". A language: --pre "setLang('it')".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { GALLERY_ART, galleryAnswer } from '../store-shots/fixtures.mjs';

const DESK_PICTURE = fileURLToPath(new URL('../../server/assets/first-run/desk.webp', import.meta.url));
const SIZES = { monitor: [1920, 1080], edge: [2560, 720], laptop: [1366, 768], tablet: [1024, 768], phone: [390, 844] };

// Private openers made reachable for the picture, in the served copy only.
export const PATCHES = {
  'disk-widget.js': [['window.DiskWidget = {', 'window.__disk = (o, s) => { overview = o; status = s; openAdvisorModal(); }; window.__diskBox = (o, s, cat) => { overview = o; status = s; confirmCat = cat; selectedIds = new Set(o.categories[cat].items.map((item) => item.i)); return renderConfirm(); }; window.DiskWidget = {']],
  'layer-key.js': [["if (!e.isTrusted || node.classList.contains('is-running')) return;", "if (node.classList.contains('is-running')) return;"], ['if (host() && host().editing()) return;', '']],
  'bit-message-card.js': [['setTimeout(drawFace, FOLD_MS)', 'setTimeout(drawFace, window.__fold || FOLD_MS)']],
  'discord-invite.js': [['function maybeShowStartup() {', 'function maybeShowStartup() { window.__discordCard = showCard; return;']],
  'support-appeal.js': [['function init() {', 'function init() { window.__appealCard = showCard;']],
  'trial-pass-ui.js': [['window.TrialPass = {', 'window.__trial = { showWelcome, showEndCard, setStatus: (s) => { status = s; } }; window.TrialPass = {']],
  'preset-share.js': [['window.PresetShare = {', 'window.__ps = { openDeckImport, openBundleImport, openThemeImport, openBgImport, openTopbarImport, openIconsImport, openSoundsImport, openPageImport, openLockedShareDialog, openShareDialog }; window.PresetShare = {']],
  'custom-widget.js': [['window.CustomWidget = {', 'window.__cw = { openClipboardConfirm, openExternalConfirm, openPermDialog }; window.CustomWidget = {']],
  'mcp-dev-client.js': [['window.McpDev = Object.freeze({ listen });', 'window.__pair = showPair; window.McpDev = Object.freeze({ listen });']],
  'deck.js': [['function openDeckMixer() {', 'window.__mixer = () => openDeckMixer(); window.__deckLook = (t, i, p) => openDeckStyleModal(t, i, p); window.__deckAsw = (t, i) => openAutoSwitchDialog(t, i); function openDeckMixer() {']],
  'update.js': [['window.XenonUpdate = {', 'window.__upd = { showUpdatingOverlay, openReleaseNotes, openUpdateFailed }; window.XenonUpdate = {']],
};

const PKG_FULL = JSON.stringify({ id: 'nova', name: 'Nova Clock', author: 'Ada Rossi', version: '1.2.0', description: 'A clock that follows the sun and shows your next event.', streams: ['system', 'media', 'weather'], actions: ['media', 'url'], hosts: ['api.example.com'], hooks: ['door-bell'], storage: true, secrets: true, island: true, mini: true, clipboard: true, ai: true, accent: true });
const PKG_SMALL = JSON.stringify({ id: 'tiny', name: 'Tiny Clock', author: 'Ada Rossi', version: '1.0.0', streams: [], actions: [] });
const PKG_HOST = JSON.stringify({ id: 'nas', name: 'NAS Monitor', author: 'Ada Rossi', version: '2.0.1', description: 'Disks and shares of the NAS at home.', streams: [], actions: [], userHosts: [{ id: 'nas', label: 'Your NAS', scope: 'private' }] });
const NOTES = JSON.stringify(['## New', '- The Store opens on a full screen.', '- Settings fill the window.', '', '## Fixed', '- Bit no longer covers the System tile.', '- The calendar reads at every size.'].join(String.fromCharCode(10)));
const RN = JSON.stringify({ version: '5.0.1', news: [{ title: 'Store at full screen', text: 'Posters, the Sparks band and the packs in front.' }], fixes: [{ area: 'Calendar', text: 'Days read at every size.' }, { area: 'Bit', text: 'No longer covers the System tile.' }] });
const RN_FIXES = JSON.stringify({ version: '5.0.1', news: [], fixes: [{ area: 'Calendar', text: 'Days read at every size.' }, { area: 'Bit', text: 'No longer covers the System tile.' }] });
const MSG = {
  low: { title: 'Sparks running low', line: 'You have 40 left. Your next message may stop halfway.', action: { type: 'store', label: 'See' } },
};
export const TARGETS = {
  'msg-plain': `BitMessages.preview({ title: 'Saved', body: 'Your Deck profile is back.' })`,
  'msg-card': `BitMessages.preview(${JSON.stringify(MSG.low)})`,
  'msg-open': `(BitMessages.preview({ title: 'Haunted House', line: 'A new supporter pack', body: 'Eight windows light up one by one. Open it in the Store.', action: { type: 'store', label: 'Open' }, media: { url: 'assets/whatsnew/widgets.webp' } }), setTimeout(() => document.querySelector('.bm-card .bm-go')?.click(), 200))`,
  'msg-poll': `BitMessages.preview({ title: 'Quick question', body: 'Which screen do you use Xenon on?', poll: { id: 'p', options: [{ id: 'a', label: 'A second monitor' }, { id: 'b', label: 'The main monitor' }, { id: 'c', label: 'A phone or tablet' }] } })`,
  'msg-stage': `BitMessages.preview({ where: 'stage', title: 'Haunted House', body: 'Eight windows light up one by one, this week only for supporters.', action: { type: 'store', label: 'Open' }, media: { url: 'assets/whatsnew/widgets.webp' } })`,
  'msg-stage-text': `BitMessages.preview({ where: 'stage', title: 'Maintenance tonight', body: 'The Store rests for an hour at 23:00.' })`,
  'msg-face': `(window.__fold = 300, BitMessages.preview(${JSON.stringify(MSG.low)}))`,
  rate: `BitMessages.preview({ kind: 'rate', title: 'Lakeside', entryId: 'lakeside', line: 'How is it on your screen?', since: Date.now() - 9 * 864e5 })`,
  'perf-toast': `XenonToast.show(AlertToasts.perfNote({ key: 'perf_status_optimized', freed: '2.4 GB' }, 'ok', { t: window.t }))`,
  'perf-banner': `XenonBitCard.ask(AlertToasts.perfPrompt('gaming', { t: window.t }, () => {}), { bit: XenonReleaseNotes.bit })`,
  'perf-sheet': `(() => { const of = window.fetch; const ans = (d) => Promise.resolve(new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } })); window.fetch = (u, o) => { const url = String(u); if (url.includes('/windows')) return ans({ windows: [{ id: 11, app: 'Chrome', title: 'Twelve tabs about keyboards', active: false }, { id: 12, app: 'Discord', title: 'general', active: false }, { id: 13, app: 'Photos', title: 'Holiday 2026', active: false }, { id: 14, app: 'OneDrive', title: 'Up to date', active: false }] }); if (url.includes('/api/performance/stats')) return ans({ ok: true, apps: [{ proc: 'chrome', memMB: 2140, cpuPct: 3 }, { proc: 'discord', memMB: 610, cpuPct: 1 }, { proc: 'photos', memMB: 280, cpuPct: 0 }], totalMB: 32768, freeMB: 9000 }); return of(u, o); }; hubSettings = { ...hubSettings, performance: { ...(hubSettings.performance || {}), opts: { ...((hubSettings.performance || {}).opts || {}), closeApps: true, manageApps: true }, manageApps: true } }; return PerfMode.optimize(); })()`,
  update: `XenonUpdate.openModal({ latest: '5.0.1', current: '5.0.0', updateAvailable: true, notes: ${NOTES} })`,
  'update-auto': `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/update/self-status') ? Promise.resolve(new Response(JSON.stringify({ supported: true }))) : f(u, o); XenonUpdate.openModal({ latest: '5.0.1', current: '5.0.0', updateAvailable: true, notes: ${NOTES} }); })()`,
  'updating-fail': `(window.__upd.showUpdatingOverlay().fail('Update did not finish', 'Xenon is back on the version it had. Nothing was lost.', () => {}), 0)`,
  updating: `window.__upd.showUpdatingOverlay()`,
  'update-notes': `window.__upd.openReleaseNotes({ id: 'x', url: 'https://example.com' }, ${RN}, () => {})`,
  'update-fixes': `window.__upd.openReleaseNotes({ id: 'x', url: 'https://example.com' }, ${RN_FIXES}, () => {})`,
  'update-failed': `window.__upd.openUpdateFailed({ at: '2026-11-07T10:00:00Z', ok: false, from: '5.0.0', to: '5.0.1', reason: 'download_failed' }, () => {})`,
  'corner-notes': `XenonReleaseNotes.cornerNotes({ notes: ${RN}, text: (x) => x, tr: window.t, url: '', openUrl() {}, onClose() {} })`,
  'corner-open': `(XenonReleaseNotes.cornerNotes({ notes: ${RN}, text: (x) => x, tr: window.t, url: '', openUrl() {}, onClose() {} }), setTimeout(() => document.querySelector('.rn-corner-go')?.click(), 200))`,
  discord: `window.__discordCard()`,
  appeal: `window.__appealCard({ active: 34, target: 45 })`,
  shop: `XenonCredits.openShop()`,
  credits: `XenonCredits.openCredits()`,
  supportercode: `openSupporterCode()`,
  'trial-try': `TrialPass.openTry()`,
  'trial-support': `TrialPass.openSupport()`,
  'trial-end': `(window.__trial.setStatus({ state: 'ended', endsAt: '2026-11-01', tried: [] }), window.__trial.showEndCard())`,
  surface: `SurfacePicker.start()`,
  weather: `openWeatherDetails()`,
  'weather-rain': `(applyWeather({ ...weatherData, condition: 'Light rain', code: 296, tempC: 13, hourly: (weatherData.hourly || []).map((h, i) => ({ ...h, rain: i > 1 ? 70 : 10, code: i > 1 ? 296 : 116, condition: i > 1 ? 'Rain' : 'Cloudy' })) }), openWeatherDetails())`,
  'weather-night': `(applyWeather({ ...weatherData, sunrise: '23:58', sunset: '00:01', condition: 'Clear', code: 113 }), openWeatherDetails())`,
  'weather-stale': `(applyWeather({ ...weatherData, stale: true, updatedAt: Date.now() - 3 * 3600e3 }), openWeatherDetails())`,
  'weather-nocity': `(applyWeather({ ok: false, error: 'city_not_found' }), openWeatherDetails())`,
  'weather-noplace': `(applyWeather({ ok: false, error: 'no_location' }), openWeatherDetails())`,
  'weather-down': `(applyWeather({ ok: false, error: 'providers_down' }), openWeatherDetails())`,
  'weather-week': `(window.weatherForecastDays = () => 7, applyWeather({ ...weatherData, forecast: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.now() + i * 864e5).toISOString().slice(0, 10), code: [113, 296, 116, 113, 338, 200, 143][i], minC: 8 + (i % 3), maxC: 15 + (i % 4), condition: 'Mixed' })) }), openWeatherDetails())`,
  'weather-loading': `(weatherData = null, fetchingWeather = true, window.fetchWeather = async () => {}, openWeatherDetails())`,
  day: `openDayModal(new Date().toISOString().slice(0, 10))`,
  color: `(() => { const b = document.createElement('button'); b.style.cssText = 'position:fixed;left:50%;top:22%;width:44px;height:44px;z-index:1'; document.body.append(b); localStorage.setItem('xeneonedge.cp.recent.v1', JSON.stringify(['#ff8a3d', '#7a5cff', '#14b8a6'])); ColorPicker.open({ anchor: b, value: '#6ee787', onPick() {} }); })()`,
  picker: `(audioData = audioData || { speakers: [], mics: [] }, audioData.speakers = [{ id: 'a', name: 'Speakers', label: 'Realtek High Definition Audio' }, { id: 'b', name: 'Headset', label: 'USB Audio Device' }, { id: 'c', name: 'Monitor', label: 'NVIDIA High Definition Audio' }], audioData.speaker = { id: 'b' }, openPicker('speaker'))`,
  call: `CallModal.onCalls({ calls: [{ id: 'c', appName: 'Discord', caller: 'Sam Rivera', source: 'discord', at: Date.now(), endsAt: Date.now() + 40000, caps: { answer: true, decline: true, open: true } }] })`,
  disk: `(() => {
    const B = String.fromCharCode(92);
    window.__disk({
      root: 'C:' + B, total: 612e9, volume: { capacity: 1000e9, free: 318e9 },
      categories: {
        temp: { bytes: 6.4e9, count: 1840, items: [] }, browserCache: { bytes: 3.1e9, count: 412, items: [] },
        pkgCache: { bytes: 12.8e9, count: 9120, items: [] }, installers: { bytes: 8.6e9, count: 14, items: [] },
        recycleBin: { bytes: 2.2e9, count: 31, items: [] },
      },
      dupes: [{ wasted: 4.1e9 }],
      tree: [{ p: 'C:' + B + 'Users', s: 340e9 }, { p: 'C:' + B + 'Games', s: 180e9 }, { p: 'C:' + B + 'Windows', s: 42e9 }],
      topFiles: [{ n: 'pagefile.sys', p: 'C:' + B + 'pagefile.sys', s: 16e9 }, { n: 'world-map.pak', p: 'C:' + B + 'Games' + B + 'world-map.pak', s: 11e9 }],
    }, { roots: [{ i: 0, path: 'C:' + B }] });
  })()`,
  keysheet: `(() => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).startsWith('/deck/press')
      ? Promise.resolve({ json: async () => (o && o.method === 'POST'
        ? { ok: false, error: 'key_changed' }
        : { ok: true, state: 'confirm', fp: 'x', title: 'Stream start', does: [{ type: 'obs', label: 'Start streaming' }, { type: 'dnd', label: 'Do not disturb on', detail: 'For 2 hours' }, { type: 'scene', label: 'Switch scene', detail: 'Gameplay' }] }) })
      : real(u, o);
    const node = LayerKey.atom({ id: 'lw_1' });
    node.style.cssText = 'position:fixed;left:30%;top:18%;width:150px;height:110px;z-index:30';
    document.body.appendChild(node);
    setTimeout(() => node.querySelector('.layer-key-btn').click(), 400);
  })()`,
  keygone: `(() => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).startsWith('/deck/press')
      ? Promise.resolve({ json: async () => (o && o.method === 'POST' ? { ok: false, error: 'gone' } : { ok: true, state: 'gone' }) })
      : real(u, o);
    const node = LayerKey.atom({ id: 'lw_1' });
    node.style.cssText = 'position:fixed;left:30%;top:18%;width:150px;height:110px;z-index:30';
    document.body.appendChild(node);
    setTimeout(() => node.querySelector('.layer-key-btn').click(), 400);
  })()`,
  lyrics: `(async () => { const g = document.querySelector('.grid-stack'); if (g) g.style.visibility = 'hidden'; const p = document.createElement('section'); p.className = 'panel lyrics-panel'; p.style.cssText = 'position:fixed;left:50%;top:50%;width:min(620px,92vw);height:min(560px,88vh);transform:translate(-50%,-50%);z-index:500;display:block'; const m = document.createElement('div'); m.className = 'lyrics-widget-mount'; m.style.cssText = 'position:relative;height:100%'; p.append(m); document.body.append(p); window.LyricsWidget.renderWidgets(); await new Promise((r) => setTimeout(r, 1500)); LyricsWidgetOptions.open(m); })()`,
  callopen: `CallModal.onCalls({ calls: [{ id: 'c', appName: 'Phone Link', caller: 'Sam Rivera', source: 'notification', at: Date.now(), endsAt: Date.now() + 40000, caps: { open: true } }] })`,
  callvideo: `CallModal.onCalls({ calls: [{ id: 'c', appName: 'Teams', caller: 'Sam Rivera', video: true, silenced: true, source: 'notification', at: Date.now(), endsAt: Date.now() + 20000, caps: { answer: true, decline: true, open: true } }, { id: 'd', appName: 'Zoom', caller: 'Robin', at: Date.now(), endsAt: Date.now() + 20000, caps: {} }] })`,
  deckconfirm: `AiDeckConfirm.open({ nonce: 'n', type: 'openApp', params: [{ name: 'path', value: 'C:\\\\Program Files\\\\Spotify\\\\Spotify.exe' }, { name: 'args', value: '--minimized' }], description: 'Open Spotify before the stream starts.' }, {})`,
  deckconfirm2: `AiDeckConfirm.open({ nonce: 'n', type: 'lockWorkstation', params: [] }, {})`,
  pcconfirm: `_aiShowPcConfirm({ nonce: 'n', command: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name, CPU', description: 'See which five programs use the processor most.' })`,
  pcconfirmlong: `_aiShowPcConfirm({ nonce: 'n', command: Array.from({ length: 40 }, (_, i) => 'Write-Output "line ' + i + ' of a long script that keeps going"').join('\\n'), description: 'A long script.' })`,
  dayempty: `openDayModal('2026-12-24')`,
  daytime: `(openDayModal(new Date().toISOString().slice(0, 10)), toggleTimePicker())`,
  daylist: `(openDayModal(new Date().toISOString().slice(0, 10)), setTimeout(() => document.querySelector('.day-modal-form .cs-trigger').click(), 400), 0)`,
  daynote: `(calendarEvents = [{ id: 'a', title: 'Dentist', startsAt: new Date().toISOString().slice(0, 10) + 'T08:30:00', notes: 'Bring the X-ray. Room 12, second floor, and ask about the next visit in the spring.' }, { id: 'b', title: 'A very long meeting name that does not fit on one line of this window at all', startsAt: new Date().toISOString().slice(0, 10) + 'T11:00:00', notes: 'https://example.com/join/1234567890' }, { id: 'c', title: 'From the shared calendar', startsAt: new Date().toISOString().slice(0, 10) + 'T17:45:00', readOnly: true }], openDayModal(new Date().toISOString().slice(0, 10)))`,
  onbstep: `(Onboarding.start(), setTimeout(() => document.querySelector('.onb-next').click(), 300))`,
  onbstep2: `(Onboarding.start(), setTimeout(() => { document.querySelector('.onb-next').click(); setTimeout(() => document.querySelector('.onb-next').click(), 200); }, 300))`,
  capture: `CaptureGallery.open()`,
  share: `ShareCard.open({})`,
  'export-theme': `PresetShare.exportTheme()`,
  'import': `PresetShare.openImport()`,
  'preset-empty': `(() => { const m = PresetShare.buildModal('A dialog title'); document.body.append(m.overlay || m); return Object.keys(m); })()`,
  companion: `window.fetch = ((real) => (u, o) => { const s = String(u); const j = (x, st) => Promise.resolve(new Response(JSON.stringify(x), { status: st || 200, headers: { 'Content-Type': 'application/json' } })); if (s.includes('/network')) return j({ fps: 118 }); if (s.includes('/api/companion/cost')) return j({ ok: true, sparks: 3 }); if (s.includes('/api/companion/insight')) return j({}); return real(u, o); })(window.fetch); window.aiFeatureEnabled = () => true; window._aiHasKey = () => true; XenonCredits.active = () => true; XenonCredits.renderChips(); GameCompanion.show({ game: 'lantern-trail.exe', since: Date.now() - 3125000 });`,
  'companion-answer': `window.fetch = ((real) => (u, o) => { const s = String(u); const j = (x, st) => Promise.resolve(new Response(JSON.stringify(x), { status: st || 200, headers: { 'Content-Type': 'application/json' } })); if (s.includes('/network')) return j({ fps: 118 }); if (s.includes('/api/companion/cost')) return j({ ok: true, sparks: 3 }); if (s.includes('/api/companion/insight')) return j({ text: 'The bridge on your left is the way forward. The guard on the tower turns every few seconds, so cross when the lantern on his side goes dark. Keep the torch low until you reach the far bank.', sparks: 3, fps: 121 }); return real(u, o); })(window.fetch); window.aiFeatureEnabled = () => true; window._aiHasKey = () => true; XenonCredits.active = () => true; XenonCredits.renderChips(); GameCompanion.show({ game: 'lantern-trail.exe', since: Date.now() - 3125000 }); setTimeout(() => GameCompanion.analyze(), 400);`,
  'companion-looking': `window.fetch = ((real) => (u, o) => { const s = String(u); const j = (x, st) => Promise.resolve(new Response(JSON.stringify(x), { status: st || 200, headers: { 'Content-Type': 'application/json' } })); if (s.includes('/network')) return j({ fps: 118 }); if (s.includes('/api/companion/cost')) return j({ ok: true, sparks: 3 }); if (s.includes('/api/companion/insight')) return new Promise(() => {}); return real(u, o); })(window.fetch); window.aiFeatureEnabled = () => true; window._aiHasKey = () => true; XenonCredits.active = () => true; XenonCredits.renderChips(); GameCompanion.show({ game: 'lantern-trail.exe', since: Date.now() - 3125000 }); setTimeout(() => GameCompanion.analyze(), 400);`,
  'companion-out': `window.fetch = ((real) => (u, o) => { const s = String(u); const j = (x, st) => Promise.resolve(new Response(JSON.stringify(x), { status: st || 200, headers: { 'Content-Type': 'application/json' } })); if (s.includes('/network')) return j({ fps: 118 }); if (s.includes('/api/companion/cost')) return j({ ok: true, sparks: 3 }); if (s.includes('/api/companion/insight')) return j({ error: 'no_credits' }, 402); return real(u, o); })(window.fetch); window.aiFeatureEnabled = () => true; window._aiHasKey = () => true; XenonCredits.active = () => true; XenonCredits.renderChips(); GameCompanion.show({ game: 'lantern-trail.exe', since: Date.now() - 3125000 }); setTimeout(() => GameCompanion.analyze(), 400);`,
  'companion-pill': `window.aiFeatureEnabled = () => true; GameCompanion.onStatus(true, 'lantern-trail.exe'); GameCompanion.onStatus = () => {};`,
  onboarding: `Onboarding.start()`,
  palette: `(setDashboardLayoutEditMode(true), DashboardPalette.open(getDashboardLayout().pages[0].id), 0)`,
  'sdk-perm': `(__cw.openPermDialog(${PKG_FULL}, null), 0)`,
  'sdk-perm-small': `(__cw.openPermDialog(${PKG_SMALL}, null), 0)`,
  'sdk-perm-host': `(__cw.openPermDialog(${PKG_HOST}, null), 0)`,
  'sdk-clip': `(__cw.openClipboardConfirm({ pkgId: 'nova', label: 'Share link', text: 'https://example.com/share/8f2a', secret: false }), 0)`,
  'sdk-clip-secret': `(__cw.openClipboardConfirm({ pkgId: 'nova', label: 'Your password', text: 'correct horse battery staple', secret: true }), 0)`,
  'sdk-ext': `(__cw.openExternalConfirm({ pkgId: 'nova', url: new URL('https://status.example.com/incidents/2026/11/07/a-rather-long-path/that-goes-on?from=widget') }), 0)`,
  pair: `(__pair({ id: 'p1', name: 'Claude Code', expiresInMs: 600000 }), 0)`,
  'deck-editor': `(DeckEditor.open({ key: null, look: {}, onSave() {}, onDelete() {} }), 0)`,
  'deck-editor-simple': `(DeckEditor.open({ key: null, look: {}, simple: true, needsShortcut: true, onSave() {} }), 0)`,
  'deck-mix': `(__mixer(), 0)`,
  'deck-editor-presets': `(() => { const list = [{ id: 'p1', name: 'Stream start', key: { title: 'Go', icon: 'mic' } }, { id: 'p2', name: 'A preset with a very long name that cannot fit', key: {} }, { id: 'p3', name: 'Mute all', key: {} }]; window.Deck.listKeyPresets = () => list; DeckEditor.open({ key: { id: 'k1', title: 'Stream on', action: { type: 'hotkey', keys: 'ctrl+shift+m' } }, look: {}, onSave() {}, onDelete() {}, onApplyStyle() {} }); return window.Deck.listKeyPresets === undefined; })()`,
  'deck-editor-multi': `(() => { DeckEditor.open({ key: null, look: {}, onSave() {}, onDelete() {} }); const add = () => [...document.querySelectorAll('.deck-ed-modal .deck-ed-addstep')].filter((n) => n.offsetParent)[0]; add().click(); add().click(); const pane = [...document.querySelectorAll('.deck-ed-pane')].find((n) => n.offsetParent); pane.scrollTop = pane.scrollHeight; return document.querySelectorAll('.deck-ed-step').length; })()`,
  'deck-asw-rules': `(() => { __deckAsw(document.body, 'deck'); const add = document.querySelector('.deck-asw .deck-ed-addstep'); add.click(); document.querySelector('.deck-asw .deck-ed-addstep').click(); document.querySelector('.deck-asw .deck-ed-addstep').click(); return document.querySelectorAll('.deck-asw-rule').length; })()`,
  'deck-editor-state': `(DeckEditor.open({ key: null, tab: 'state', look: {}, onSave() {}, onDelete() {} }), 0)`,
  'deck-editor-look': `(DeckEditor.open({ key: null, tab: 'look', look: {}, onSave() {}, onDelete() {} }), 0)`,
  'deck-editor-fx': `(DeckEditor.open({ key: null, tab: 'fx', look: {}, onSave() {}, onDelete() {} }), 0)`,
  'deck-editor-full': `(DeckEditor.open({ key: { id: 'k1', title: 'Stream on', icon: 'mic', color: '#3b82f6', action: { type: 'hotkey', keys: 'ctrl+shift+m' } }, look: {}, onSave() {}, onDelete() {}, onApplyStyle() {} }), 0)`,
  'deck-look': `(() => { const tile = document.querySelector('[data-tile-id^="deck"], .deck-tile, [data-tile="deck"]'); const id = tile && (tile.dataset.instanceId || tile.dataset.tileId || 'deck'); return __deckLook(tile || document.body, id, null), !!tile; })()`,
  'deck-asw': `(() => { const tile = document.querySelector('[data-tile-id^="deck"], .deck-tile, [data-tile="deck"]'); const id = tile && (tile.dataset.instanceId || tile.dataset.tileId || 'deck'); return __deckAsw(tile || document.body, id), !!tile; })()`,
  transfer: `(TransferWidget.openSheet(), 0)`,
  'transfer-list': `(TransferWidget.openSheet(), TransferWidget.onState({ enabled: true, bytes: 412000000, quotaBytes: 2e10, maxBytes: 2147483648, pending: [{ id: 'p1', name: 'Holiday in Sicily.mov', total: 840000000, received: 310000000 }], items: [{ id: 'a1', name: 'IMG_4821.jpg', size: 3400000, at: Date.now() - 120000, ext: '.jpg', thumb: true, direction: 'in', from: 'Phone' }, { id: 'a2', name: 'Contract signed final version with a very long name that never ends.pdf', size: 820000, at: Date.now() - 10800000, ext: '.pdf', direction: 'in', from: 'Phone' }, { id: 'a3', name: 'Screenshot 2026-11-07.png', size: 1300000, at: Date.now() - 86400000, ext: '.png', thumb: true, direction: 'out' }] }), 0)`,
  'transfer-many': `(TransferWidget.openSheet(), TransferWidget.onState({ enabled: true, bytes: 412000000, quotaBytes: 2e10, maxBytes: 2147483648, pending: [], items: Array.from({ length: 24 }, (_, i) => ({ id: 'm' + i, name: 'IMG_' + (4800 + i) + '.jpg', size: 3400000 + i * 90000, at: Date.now() - i * 3600000, ext: '.jpg', thumb: true, direction: i % 3 ? 'in' : 'out', from: 'Phone' })) }), 0)`,
  'transfer-help': `(TransferWidget.openSheet(), document.querySelector('.xfer-sheet-bar .xfer-help-btn').click(), 0)`,
  'transfer-phone': `(window.__xenonRemote = true, TransferWidget.openSheet(), TransferWidget.onState({ enabled: true, bytes: 412000000, quotaBytes: 2e10, maxBytes: 2147483648, pending: [{ id: 'p1', name: 'Holiday in Sicily.mov', total: 840000000, received: 310000000 }], items: [{ id: 'a1', name: 'IMG_4821.jpg', size: 3400000, at: Date.now() - 120000, ext: '.jpg', thumb: true, direction: 'in', from: 'Phone' }, { id: 'a2', name: 'Contract signed final version with a very long name that never ends.pdf', size: 820000, at: Date.now() - 10800000, ext: '.pdf', direction: 'in', from: 'Phone' }, { id: 'a3', name: 'Screenshot 2026-11-07.png', size: 1300000, at: Date.now() - 86400000, ext: '.png', thumb: true, direction: 'out' }] }), 0)`,
  'transfer-phone-empty': `(window.__xenonRemote = true, TransferWidget.openSheet(), TransferWidget.onState({ enabled: true, items: [], pending: [] }), 0)`,
  'transfer-ios': `(Object.defineProperty(navigator, 'userAgent', { get: () => 'iPhone' }), window.__xenonRemote = true, TransferWidget.openSheet(), TransferWidget.onState({ enabled: true, bytes: 412000000, quotaBytes: 2e10, maxBytes: 2147483648, pending: [], items: [{ id: 'a1', name: 'IMG_4821.jpg', size: 3400000, at: Date.now() - 120000, ext: '.jpg', thumb: true, direction: 'in', from: 'Phone' }, { id: 'a3', name: 'Screenshot 2026-11-07.png', size: 1300000, at: Date.now() - 86400000, ext: '.png', thumb: true, direction: 'out' }] }), 0)`,
  'transfer-prep': `(window.__xenonRemote = true, TransferWidget.openSheet(), document.querySelector('.xfer-sheet .transfer-widget-mount').dataset.xferPreparing = '1', TransferWidget.onState({ enabled: true, bytes: 412000000, quotaBytes: 2e10, maxBytes: 2147483648, pending: [], items: [{ id: 'a1', name: 'IMG_4821.jpg', size: 3400000, at: Date.now() - 120000, ext: '.jpg', thumb: true, direction: 'in', from: 'Phone' }, { id: 'a3', name: 'Screenshot 2026-11-07.png', size: 1300000, at: Date.now() - 86400000, ext: '.png', thumb: true, direction: 'out' }] }), 0)`,
  'transfer-undo': `((() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/transfer/delete') ? Promise.resolve(new Response(JSON.stringify({ ok: true, undoMs: 60000 }), { status: 200, headers: { 'content-type': 'application/json' } })) : f(u, o); })(), window.__xenonRemote = true, TransferWidget.openSheet(), TransferWidget.onState({ enabled: true, bytes: 412000000, quotaBytes: 2e10, maxBytes: 2147483648, pending: [], items: [{ id: 'a1', name: 'IMG_4821.jpg', size: 3400000, at: Date.now() - 120000, ext: '.jpg', thumb: true, direction: 'in', from: 'Phone' }, { id: 'a3', name: 'Screenshot 2026-11-07.png', size: 1300000, at: Date.now() - 86400000, ext: '.png', thumb: true, direction: 'out' }] }), document.querySelector('.xfer-sheet .xfer-row .xfer-row-acts .xfer-icon:last-child').click(), 0)`,
  'transfer-fail': `(TransferWidget.openSheet(), TransferWidget.enqueue([new File(['x'], 'Holiday in Sicily.mov')]), 0)`,
  aipanel: `openAiPanel()`,
};
// The sheet with Bit's plan, and with nothing to close.
const diskAnswer = (answer) => '(window.fetch = ((real) => (u, o) => String(u).includes("/api/disk/advisor") ? Promise.resolve(new Response(JSON.stringify(' + answer + '), { headers: { "Content-Type": "application/json" } })) : real(u, o))(window.fetch))';
const diskEnd = 'setTimeout(() => { const b = document.querySelector(".diskw-advisor-body"); b.scrollTop = 99999; }, 350)';
const diskAsk = 'setTimeout(() => document.querySelector(".diskw-modal-ask").click(), 120)';
const diskReport = '{ ok: true, fullContext: false, text: ["## Where the space went", "", "Most of **C:** is your own: *Users* and *Games* hold 485 GB. Windows itself is 39 GB, which is normal.", "", "### What I would do first", "", "1. Clear the package-manager caches: 11.9 GB, they come back only when you install something.", "2. Look through the old installers: 8 GB, you may still want one of them.", "", "| Item | Size | Risk |", "| --- | --- | --- |", "| Package caches | 11.9 GB | None |", "| Old installers | 8 GB | Your choice |"].join(String.fromCharCode(10)) }';
TARGETS['disk-open'] = '(' + TARGETS.disk + ', setTimeout(() => { document.querySelectorAll("details.diskw-modal-cat")[1].open = true; }, 100))';
TARGETS['disk-end'] = '(' + TARGETS.disk + ', ' + diskEnd + ')';
TARGETS['disk-bit'] = '(' + diskAnswer(diskReport) + ', ' + TARGETS.disk + ', ' + diskAsk + ', ' + diskEnd + ')';
TARGETS['disk-fail'] = '(' + diskAnswer('{ ok: false, error: "x" }') + ', ' + TARGETS.disk + ', ' + diskAsk + ', ' + diskEnd + ')';
TARGETS['disk-none'] = "window.__disk({ root: 'C:', total: 612e9, volume: { capacity: 1000e9, free: 318e9 }, categories: {}, dupes: [], tree: [], topFiles: [] }, { roots: [{ i: 0, path: 'C:' }] })";
TARGETS['disk-confirm'] = "(() => { const items = [1, 2, 3, 4].map((i) => ({ i, p: 'C:/Users/sam/AppData/Local/Temp/build-cache-' + i + '.tmp', s: 3e8 * i, kind: i % 2 ? 'file' : 'dir' })); const cats = { temp: { bytes: 6.4e9, count: 4, items } }; const wrap = document.createElement('div'); wrap.className = 'panel disk-panel'; wrap.style.cssText = 'position:fixed;z-index:3000;left:50%;top:50%;width:min(620px,92vw);height:min(420px,86vh);transform:translate(-50%,-50%);display:flex;flex-direction:column;overflow:hidden;padding:14px;border-radius:16px;container-type:size;background:rgb(var(--panel-rgb))'; wrap.append(window.__diskBox({ root: 'C:', categories: cats, dupes: [], tree: [], topFiles: [] }, { roots: [] }, 'temp')); document.body.append(wrap); })()";
TARGETS['disk-confirm-bin'] = TARGETS['disk-confirm'].replace("const cats = { temp: { bytes: 6.4e9, count: 4, items } };", "const cats = { recycleBin: { bytes: 2e9, count: 4, items } };").replace("'temp')", "'recycleBin')");
const galAnswer = galleryAnswer(Date.now());
galAnswer.entries[0].markers = [{ at: 3, kind: 'mark' }, { at: 7, kind: 'stutter' }, { at: 21, kind: 'mark' }];
galAnswer.entries[0].clips = 2;
const TRANSCRIPT = { ok: true, summary: 'Three rounds on the river map: a slow start, a clean push and the last fight at the bridge.',
  chapters: [{ at: 0, title: 'Warm up' }, { at: 9, title: 'The push' }, { at: 18, title: 'The bridge' }],
  lines: Array.from({ length: 14 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.8, text: ['Okay, going left this time.', 'They are on the roof.', 'Hold that corner for me.', 'Nice one, keep moving.'][i % 4] })) };
const galFetch = (answer) => '(window.fetch = ((real) => (u, o) => { const s = String(u); if (s.includes("/captures/transcript")) return Promise.resolve(new Response(JSON.stringify(' + JSON.stringify(TRANSCRIPT) + '), { headers: { "Content-Type": "application/json" } })); if (s.includes("/captures/spots")) return Promise.resolve(new Response(JSON.stringify({ ok: true, spots: [] }), { headers: { "Content-Type": "application/json" } })); return s.includes("/captures?") ? Promise.resolve(new Response(JSON.stringify(' + JSON.stringify(answer) + '), { headers: { "Content-Type": "application/json" } })) : real(u, o); })(window.fetch))';
const galOpen = (o, then) => '(' + galFetch(galAnswer) + ', window.CaptureGallery.open(' + o + ').then(() => new Promise((ok) => setTimeout(() => { ' + (then || '') + '; ok(); }, 500))))';
const galKey = (word) => '[...document.querySelectorAll(".capg-actions .capg-key")].find((b) => b.textContent === "' + word + '").click()';
TARGETS.gal = galOpen('{}');
TARGETS['gal-filter'] = galOpen('{ filter: "video" }');
TARGETS['gal-empty'] = '(' + galFetch({ ok: true, entries: [], more: false, editable: true, usedBytes: 0, games: [] }) + ', window.CaptureGallery.open({}))';
TARGETS['gal-nomatch'] = '(' + galFetch({ ok: true, entries: [], more: false, editable: true, usedBytes: 0, games: [] }) + ', window.CaptureGallery.open({ filter: "screenshot" }))';
TARGETS['gal-fail'] = 'window.CaptureGallery.open({})';
TARGETS['gal-shot'] = galOpen('{ id: "c1" }');
TARGETS['gal-video'] = galOpen('{ id: "c0" }');
TARGETS['gal-trim'] = galOpen('{ id: "c0" }', galKey('Trim'));
TARGETS['gal-export'] = galOpen('{ id: "c0" }', galKey('Export'));
TARGETS['gal-words'] = galOpen('{ id: "c0" }', galKey('Transcript'));
TARGETS['gal-delete'] = galOpen('{ id: "c1" }', galKey('Delete'));
TARGETS['gal-edit'] = galOpen('{ id: "c1" }', galKey('Edit'));
TARGETS['perf-sheet-plan'] = TARGETS['perf-sheet']
  .replace("return of(u, o); };", "if (url.includes('/api/performance/plan')) return ans({ ok: true, plan: { explanation: 'Chrome is using the most memory and nothing in your game needs it, so I picked it.', closeApps: ['Chrome'] } }); return of(u, o); };")
  .replace('manageApps: true } };', "manageApps: true, useAi: true }, aiProvider: 'xenon' };");
TARGETS['perf-sheet-empty'] = TARGETS['perf-sheet'].replace(/return ans\(\{ windows: \[.*?\] \}\);/, 'return ans({ windows: [] });');



// The preset family: each through its own door, and an import through the real code.
const WAIT = 'const wait = (ms) => new Promise((r) => setTimeout(r, ms));';
const reviewOf = (share) => '(async () => { ' + WAIT + ' await ' + share + '; await wait(500);'
  + " const code = document.querySelector('.preset-code-field').value;"
  + " document.querySelector('.preset-modal-close').click(); await wait(200);"
  + ' PresetShare.openImport(code); })()';
const SVG = "btoa('<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"#ccc\"/></svg>')";
const TRIED = [{ entryId: 'lakeside', name: 'Lakeside' }, { entryId: 'abisso', name: 'Abisso' }, { entryId: 'aracne', name: 'Aracne' }];
Object.assign(TARGETS, {
  'f-export': 'PresetShare.openExport()',
  'f-bundle': 'PresetShare.exportBundle()',
  'f-page': 'PresetShare.exportPage()',
  'f-icons': 'PresetShare.exportIcons()',
  'f-sounds': 'PresetShare.exportSounds()',
  'f-deck': 'PresetShare.exportDeck()',
  'f-widget': 'PresetShare.exportWidget()',
  'f-lock': "(async () => { " + WAIT + " await PresetShare.exportTheme(); await wait(500); document.querySelector('.preset-lock-toggle').click(); })()",
  'f-locked': "__ps.openLockedShareDialog('theme', 'Sunset Glass', btoa('locked-code-for-the-picture'), ['KQ7M-2XPD', 'T9VB-4LHC', 'H3RN-8GWF'])",
  'f-big': "__ps.openShareDialog('bg', 'Paper Moon', 'x'.repeat(120000), null, { name: 'Paper Moon', assets: { a: 'x' } })",
  'f-review-theme': reviewOf('PresetShare.exportTheme()'),
  'f-review-page': reviewOf('PresetShare.exportCurrentPage()'),
  'f-review-topbar': reviewOf('PresetShare.exportTopbar()'),
  'f-review-bg': "__ps.openBgImport('Paper Moon', { name: 'Paper Moon', assets: { 'moon.webp': 'data:image/webp;base64,' + 'A'.repeat(4000) } })",
  'f-review-icons': "__ps.openIconsImport('Mono Set', { manifest: { name: 'Mono Set', author: 'Lena', version: '1.2.0' }, icons: Array.from({ length: 12 }, (_, i) => ({ id: 'i' + i, name: 'Icon ' + i, type: 'svg', data: " + SVG + " })) })",
  'f-review-sounds': "__ps.openSoundsImport('Soft Clicks', { manifest: { name: 'Soft Clicks', author: 'Lena', version: '1.0.0' }, clips: [{ id: 'a', name: 'Tap' }, { id: 'b', name: 'Done' }] })",
  'f-review-deck': "__ps.openDeckImport('Stream keys', { id: 'p', name: 'Stream keys', root: { pages: [{ id: 'g', name: 'Main', keys: [{ id: 'k', label: 'Mute', action: { type: 'media.mute' } }, { id: 'l', label: 'Scene', action: { type: 'obs.scene' } }] }] } }, [])",
  'f-review-bundle': "__ps.openBundleImport('Full look', { theme: PresetShare.currentTheme(), name: 'Full look', pages: [], widgets: [] }, 12)",
  'f-buy': "(PresetShare.openImport(JSON.stringify({ xenonLocked: 2, kind: 'theme', name: 'Vanguard', enc: { iv: 'a', ct: 'b' }, redeem: { entryId: 'vanguard' } }), { source: 'catalog', sourceId: 'vanguard', sparks: 150, sparksOnly: false, name: 'Vanguard', sale: { kind: 'Theme', line: 'A dark theme with brass keys and quiet motion.', preview: { bg: '#16212b', text: '#f3ead6', accent: '#d6a24a' } } }), 0)",
  'f-import-store': "PresetShare.openImport('abc', { source: 'catalog', sourceId: 'lakeside', sourceName: 'Lakeside' })",
  'f-confirm': "(settingsPrompt({ type: 'confirm', title: 'Reset everything?', message: 'Your tiles, pages and theme go back to the first day.', danger: true, okLabel: 'Reset' }), 0)",
  'f-name': "(settingsPrompt({ title: 'Name this theme', value: 'My theme', maxLength: 40 }), 0)",
  'f-trial-end': "(window.__trial.setStatus({ state: 'ended', endsAt: '2026-11-01', tried: " + JSON.stringify(TRIED) + " }), window.__trial.showEndCard())",
  'f-welcome': "(window.__trial.setStatus({ state: 'ended', endsAt: 'pic-' + Date.now(), tried: " + JSON.stringify(TRIED) + " }), window.__trial.showWelcome([]))",
  'f-welcome-one': "(window.__trial.setStatus({ state: 'ended', endsAt: 'pic1-' + Date.now(), tried: " + JSON.stringify(TRIED.slice(0, 1)) + " }), window.__trial.showWelcome([]))",
});

export function parseArgs(argv) {
  const flag = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1]; };
  const size = flag('--size', 'monitor');
  const [width, height] = SIZES[size] || size.split('x').map(Number);
  if (!argv[0] || argv[0].startsWith('--') || !(width > 0 && height > 0)) throw new Error('usage: census.mjs <out dir> [--size name|WxH] [--light] [--style s] [--only a,b] [--pre js]');
  return {
    out: path.resolve(argv[0]), width, height, phone: size === 'phone', light: argv.includes('--light'),
    style: flag('--style', ''), pre: flag('--pre', ''), only: flag('--only', '').split(',').filter(Boolean),
  };
}

// A name that is not a target stops the run: a typing slip must not look like a sweep with nothing to say.
export function pickTargets(all, only) {
  const unknown = only.filter((name) => !(name in all));
  if (unknown.length) throw new Error(`not a target: ${unknown.join(', ')}`);
  return Object.entries(all).filter(([name]) => !only.length || only.includes(name));
}

// The Gallery plays this in place of a real capture, so no footage is needed.
function sampleVideo(out) {
  const file = path.join(out, 'sample-capture.webm');
  if (fs.existsSync(file)) return file;
  const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-c:v', 'libvpx-vp9', '-b:v', '600k', file]);
  if (made.error || made.status !== 0) throw new Error('the Gallery targets need ffmpeg on PATH');
  return file;
}

async function patchScripts(ctx) {
  for (const [file, swaps] of Object.entries(PATCHES)) {
    await ctx.route(`**/js/${file}*`, async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      for (const [from, to] of swaps) {
        if (!body.includes(from)) console.log('PATCH MISSING', file, from);
        body = body.replace(from, to);
      }
      await route.fulfill({ response: res, body });
    });
  }
}

async function answerCaptures(ctx, out) {
  await ctx.route('**/api/transfer/thumb*', (r) => r.fulfill({ path: DESK_PICTURE, contentType: 'image/webp' }));
  await ctx.route('**/captures/transcript*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(TRANSCRIPT) }));
  await ctx.route('**/captures/thumb*', (r) => {
    const i = Number(new URL(r.request().url()).searchParams.get('id').slice(1));
    r.fulfill({ contentType: 'image/svg+xml', body: GALLERY_ART[i]() });
  });
  await ctx.route('**/captures/file*', async (r) => {
    const id = new URL(r.request().url()).searchParams.get('id');
    const entry = galAnswer.entries.find((e) => e.id === id);
    if (entry && entry.kind !== 'screenshot') {
      await r.fulfill({ contentType: 'video/webm', body: fs.readFileSync(sampleVideo(out)) });
      return;
    }
    await r.fulfill({ contentType: 'image/svg+xml', body: GALLERY_ART[Number(id.slice(1))]().replace(/ width="\d+"/, ' width="1920"').replace(/ height="\d+"/, ' height="1080"') });
  });
}

async function shoot(ctx, base, name, code, opts) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(name, 'ERR', String(e.message).slice(0, 140)));
  try {
    await page.goto(base + 'demo/', { waitUntil: 'load' });
    await page.addStyleTag({ content: '#demo-badge,#demo-convert{display:none!important}' });
    await page.waitForTimeout(2400);
    if (opts.light) await page.evaluate(() => window.setAppearance('light'));
    if (opts.style) await page.evaluate((s) => window.setStyleMode(s), opts.style);
    if (opts.pre) { await page.evaluate(opts.pre); await page.waitForTimeout(500); }
    const res = await page.evaluate(code).catch((e) => `THREW ${String(e.message).slice(0, 120)}`);
    if (res !== undefined && res !== null) console.log(name, JSON.stringify(res).slice(0, 160));
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(opts.out, `${name}.png`) });
  } finally { await page.close(); }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = pickTargets(TARGETS, opts.only);
  fs.mkdirSync(opts.out, { recursive: true });
  const site = await startSite(0);
  const base = site.url || `http://127.0.0.1:${site.port}/`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, isMobile: opts.phone, hasTouch: opts.phone, deviceScaleFactor: 1, locale: 'en-US' });
    try {
      await ctx.addInitScript({ content: `try{localStorage.setItem('xeneonedge.bootLook.v1','{"off":true}');localStorage.setItem('xenon.site.consent','denied')}catch{}` });
      await patchScripts(ctx);
      await answerCaptures(ctx, opts.out);
      for (const [name, code] of targets) await shoot(ctx, base, name, code, opts);
    } finally { await ctx.close(); }
  } finally { await browser.close(); await site.stop(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
