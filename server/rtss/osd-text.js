'use strict';
// The words RivaTuner draws over the game: the readings the person chose for the Game
// performance tile (js/performance/perf-hud.js), one line per group (or all on one
// line), each led by the name everyone's overlay uses. Pure.
//
// ASCII only: RTSS reads the text in the PC's own code page, where a degree sign is a
// different letter on a Japanese or Chinese Windows. So "65C", never "65°C".

const PerfHud = require('../js/performance/perf-hud.js');

const ROW_GAP = '   ';
const NOT_ASCII = /[^\x20-\x7e\n]/g;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function gameLine(hud, fps, stats) {
  const s = stats || {};
  const out = [];
  if (hud.fps && num(fps) != null) out.push(Math.round(num(fps)) + ' FPS');
  if (hud.low1 && num(s.low1Fps) != null) out.push('1% ' + Math.round(num(s.low1Fps)));
  if (hud.low01 && num(s.low01Fps) != null) out.push('0.1% ' + Math.round(num(s.low01Fps)));
  const avg = num(s.avgFps) > 0 ? num(s.avgFps) : num(fps);
  if (hud.frame && avg > 0) out.push((1000 / avg).toFixed(1) + ' ms');
  return out.join('  ');
}

// One group of system readings after its name; '' when none of them has a value.
function group(name, parts, hud, read) {
  const values = parts.filter((p) => hud[p]).map(read).filter((v) => v !== '--');
  return values.length ? name + ' ' + values.join(' ') : '';
}

// { hud, fps, stats, sys, net, fahrenheit } → the text, '' when there is nothing to show
function osdText({ hud, fps, stats, sys, net, fahrenheit }) {
  const h = PerfHud.normalizePerfHud(hud);
  const temp = (c) => Math.round(fahrenheit ? (c * 9) / 5 + 32 : c) + (fahrenheit ? 'F' : 'C');
  const read = (part) => PerfHud.statText(part, sys, net, temp);
  const lines = [
    gameLine(h, fps, stats),
    group('CPU', ['cpu', 'cpuTemp', 'cpuClock', 'cpuPower'], h, read),
    [group('GPU', ['gpu', 'gpuTemp', 'gpuClock', 'gpuPower'], h, read), group('VRAM', ['vram'], h, read)].filter(Boolean).join('  '),
    [group('RAM', ['ram'], h, read), group('PING', ['ping'], h, read), group('LOSS', ['loss'], h, read)].filter(Boolean).join('  '),
  ].filter(Boolean);
  return lines.join(h.layout === 'row' ? ROW_GAP : '\n').replace(NOT_ASCII, '');
}

module.exports = { osdText };
