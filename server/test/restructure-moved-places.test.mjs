// A file that left the root of server/ for a feature folder may find its neighbours from the folder it sits in:
// a script, the data folder, a companion program. The move wrote the way back up into each such line. This is
// the proof that every one of them still ends at the place it ended at before, written out by hand from the
// lines as they were in the root: a line added later has to be added here on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

// moved file -> the places it names, in the order of its lines, from the repo root; `true` marks a file of the repo.
const PLACES = {
  'server/ai/ai-cli.js': [['server/ai-mcp-bridge.js', true]],
  'server/ai/ai-knowledge.js': [['docs/WIDGET_SDK.md', true]],
  'server/audio/audio-levels.js': [['server/helper/xenon-helper.exe']],
  'server/discord/discord-rpc.js': [['server/stream-tokens.json']],
  'server/disk/devclean-vhdx.js': [['server/data']],
  'server/disk/diskspace.js': [['.']],
  'server/engine/startup-log.js': [['server/data']],
  'server/layers/layer-strings.js': [['server/js/i18n.js', true], ['server/js/i18n-load.js', true]],
  'server/media/stream-spotify.js': [['server/stream-tokens.json']],
  'server/notification-open/winnotif.js': [['server/notifications.ps1', true], ['server/helper/xenon-helper.exe']],
  'server/performance/fpsmon.js': [['server/presentmon/PresentMon.exe'], ['server/PresentMon.exe']],
  'server/performance/gamedetect.js': [['server/foreground.ps1', true], ['server/helper']],
  'server/platform/session-watch.js': [['server/session-watch.ps1', true]],
  'server/search/filesearch.js': [['server/search.ps1', true]],
  'server/streaming/stream-twitch.js': [['server/stream-tokens.json']],
  'server/streaming/stream-youtube.js': [['server/stream-tokens.json']],
  'server/updates/icue-sdk-install.js': [['server/icue-sdk-update.ps1', true], ['server/icue-sdk']],
  'server/windows-tiles/embedded-browser.js': [['server/data']],
};

// Every `path.join(__dirname, 'a', 'b', ...)` of a file: the names written out after `__dirname`, up to the first
// argument that is not one (a name worked out at run time ends the part this test can read).
function joins(text) {
  const found = [];
  for (const match of text.matchAll(/\bpath\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*'[^']*')*)/g)) {
    found.push([...match[1].matchAll(/'([^']*)'/g)].map((one) => one[1]));
  }
  return found;
}

const rootMoves = JSON.parse(read('tools/restructure/moved.json')).moves
  .filter((move) => /^server\/[^/]+\.js$/.test(move.from) && /^server\/[^/]+\/[^/]+\.js$/.test(move.to));

test('every moved file that looks around from its folder is in the list', () => {
  const looking = rootMoves.map((move) => move.to).filter((file) => existsSync(path.join(REPO, file)) && /\b__dirname\b/.test(read(file)));
  assert.deepEqual(looking.sort(), Object.keys(PLACES).sort());
});

test('every such line is a join that starts at the folder, and ends where it ended in the root', () => {
  for (const [file, places] of Object.entries(PLACES)) {
    const text = read(file);
    const found = joins(text);
    assert.equal(found.length, (text.match(/\b__dirname\b/g) ?? []).length, `${file}: __dirname outside a join that starts with it`);
    const ends = found.map((parts) => path.relative(REPO, path.join(REPO, path.dirname(file), ...parts)).split(path.sep).join('/') || '.');
    assert.deepEqual(ends, places.map(([place]) => place), file);
    for (const [place, ships] of places) if (ships) assert.ok(existsSync(path.join(REPO, place)), `${file}: ${place} is not in the repo`);
  }
});
