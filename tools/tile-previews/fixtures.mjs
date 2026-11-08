// What each tile of the Add list needs to look connected: invented data fed to the
// tile's real code on the site's demo, for the shots of tools/tile-previews/shoot.mjs.
// answers   JSON by path, in front of the demo's fetch shim
// events    live events by type, pushed each second like the server's stream
// settings  merged into the demo's seed
// cards     the tile's own card settings, in the page's layout
// files     pictures by path, served to the page by the shot's route
// frames    a third-party player's page by host, served by the shot's route
// sockets   text a WebSocket to that host receives (Twitch chat)
// relay     the embedded browser's page: its address and its picture
// stage     runs in the page once it settled: a tab to open, a value to set
// crop      what to shoot, when it is not the tile's place in the grid
// demo      a function's source, given the demo's data before it boots: what no route can reach
// Nothing here is real: no people, channels, songs, or anything read from this PC.

import { socketScript } from './fixture-sockets.mjs';
import * as ai from './fixtures-ai.mjs';
import * as home from './fixtures-home.mjs';
import * as media from './fixtures-media.mjs';
import * as pc from './fixtures-pc.mjs';

const FIXTURES = { ...ai, ...home, ...media, ...pc };

export const FIXTURE_TILES = Object.freeze(Object.keys(FIXTURES));

export function fixtureFor(id, now = Date.now()) {
  return Object.hasOwn(FIXTURES, id) ? FIXTURES[id](now) : null;
}

// The fixture as a script for the page: it lands on window.__SHOT__, which
// tools/site-shots/page/*.js read before and after the demo's boot.
export function fixtureScript(fixture) {
  const { answers = {}, events = {}, settings = {}, demo } = fixture;
  return `Object.assign(window.__SHOT__.answers, ${JSON.stringify(answers)});
Object.assign(window.__SHOT__.events, ${JSON.stringify(events)});
Object.assign(window.__SHOT__.settings, ${JSON.stringify(settings)});
${demo ? `window.__SHOT__.demo = ${demo};` : ''}
${socketScript(fixture)}`;
}
