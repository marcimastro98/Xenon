'use strict';
// The numbers for one stretch of the path (router, provider, internet) over its
// newest echoes. Pure, so the tests drive it with invented samples. A sample is
// the round trip in ms, or null for an echo that never came back.
//
//   now     median of the newest NOW_ECHOES answers: the value to show, steady
//           enough that one late echo does not make the digit jump
//   ms      median of the whole window
//   min     the fastest answer in the window: the path with nothing queued on it,
//           the baseline a rise is measured against
//   jitter  mean change between two answers in a row
//   loss    share of the window that never came back, %
//   lossNow the same over the newest LOSS_NOW_ECHOES, so a burst shows in seconds
//   n       echoes in the window

const WINDOW = 30;
const NOW_ECHOES = 5;
const LOSS_NOW_ECHOES = 10;

const round1 = (x) => Math.round(x * 10) / 10;

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function lossOf(samples) {
  if (!samples.length) return null;
  const lost = samples.filter((s) => s === null).length;
  return round1((lost / samples.length) * 100);
}

function summarize(samples) {
  const answered = samples.filter((s) => s !== null);
  let diff = 0;
  let pairs = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] === null || samples[i - 1] === null) continue;
    diff += Math.abs(samples[i] - samples[i - 1]);
    pairs += 1;
  }
  const recent = answered.slice(-NOW_ECHOES);
  const at = (v) => (v === null ? null : round1(v));
  return {
    now: at(median(recent)),
    ms: at(median(answered)),
    min: answered.length ? round1(Math.min(...answered)) : null,
    jitter: pairs ? round1(diff / pairs) : null,
    loss: lossOf(samples),
    lossNow: lossOf(samples.slice(-LOSS_NOW_ECHOES)),
    n: samples.length,
  };
}

function createWindow(size = WINDOW) {
  const samples = [];
  return {
    add(ms) {
      samples.push(Number.isFinite(ms) && ms >= 0 ? ms : null);
      if (samples.length > size) samples.splice(0, samples.length - size);
    },
    summary: () => summarize(samples),
    count: () => samples.length,
    answered: () => samples.some((s) => s !== null),
  };
}

module.exports = { createWindow, summarize, median, WINDOW, NOW_ECHOES, LOSS_NOW_ECHOES };
