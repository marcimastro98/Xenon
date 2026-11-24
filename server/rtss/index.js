'use strict';
// The Game performance readings over a game in exclusive full screen, drawn by RivaTuner
// Statistics Server (RTSS) when it is installed and the person turned the option on
// (perfHud.rtss). Windows only: RTSS is a Windows program, and elsewhere no game owns
// the display that way. Loading this file starts nothing: routes.js calls start().
//
// Nothing here reads a sensor or the frame rate on its own: the text is made from what
// the engine already reads for the dashboard (the frame reader, the system tick, the
// ping). With no dashboard connected those would stop, so while RivaTuner is open the
// frame reader is asked to run (fps-demand.js `overlay`), and while it draws the system
// tick keeps reading (`drawing`, server.js _systemTick).

const { createOsdLoop } = require('./osd-loop.js');
const { createWindowsMemory } = require('./windows-memory.js');
const { osdText } = require('./osd-text.js');
const PerfHud = require('../js/performance/perf-hud.js');
const fpsMonitor = require('../performance/fps-monitor.js');
const gameDetect = require('../performance/gamedetect.js');
const { _perfNet } = require('../performance/engine-perf-net.js');
const { _fpsDemand } = require('../performance/engine-fps-demand.js');
const { latestSystemInfo } = require('../system/latest-reading.js');
const { hub } = require('../settings/current.js');

const SUPPORTED = process.platform === 'win32';
// Where people get RivaTuner: its makers' own page. Any other copy may not be theirs.
const DOWNLOAD_URL = 'https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download';
// The system tick reads every 1-10 s (sensorRateMs); older than this is not "now".
const SYSTEM_MAX_AGE_MS = 15000;

const settings = () => hub.settings || {};
const hud = () => PerfHud.normalizePerfHud(settings().perfHud);

function frameStats() {
  try { return fpsMonitor.getFrameStats() || null; } catch { return null; }
}

function fahrenheit() {
  const s = settings();
  return s.hwTempUnit === 'f' || s.hwTempUnit === 'c' ? s.hwTempUnit === 'f' : s.tempUnit === 'f';
}

async function text() {
  let fps = null;
  try { fps = fpsMonitor.getFpsDetail()?.fps; } catch { fps = null; }
  return osdText({
    hud: settings().perfHud, fps, stats: frameStats(), sys: latestSystemInfo(SYSTEM_MAX_AGE_MS),
    net: _perfNet.last(), fahrenheit: fahrenheit(),
  });
}

const loop = createOsdLoop({
  memory: createWindowsMemory(),
  enabled: () => hud().rtss,
  gameRunning: () => gameDetect.isGameRunning(),
  exclusive: () => frameStats()?.exclusive === true,
  text,
  want: (on) => _fpsDemand.overlay(on),
});

const start = () => { if (SUPPORTED) loop.start(); };

// What Settings, the menu and Bit say about it: null where it cannot exist.
// { on, running, showing, url }: `running` = RTSS is open, `showing` = it draws Xenon's
// readings over a game right now.
function state() {
  if (!SUPPORTED) return null;
  return { on: hud().rtss, ...loop.state(), url: DOWNLOAD_URL };
}

const drawing = () => SUPPORTED && loop.drawing();

module.exports = { start, stop: loop.stop, state, drawing, DOWNLOAD_URL, SUPPORTED };
