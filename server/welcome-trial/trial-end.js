'use strict';
// The welcome Sparks (welcome-sparks.js) ended on this PC.
//
// When the hub answers `welcome_over`, ai-xenon-credits.js forgets the trial's
// code, and from then on this PC looks like one that never had Sparks. This file
// keeps the one fact that tells them apart, so Bit's chat can say the trial is
// over and what keeps Bit on, instead of a plain "buy Sparks" card.
//
// Only the moment is kept, never the code. The hub's clock decided it; nothing
// here can bring the trial back.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('../atomic-write.js');

const FILE = 'welcome-ended.json';

// The first end is the one kept: a second `welcome_over` changes nothing.
async function noteEnded(dataDir, at = Date.now()) {
  if (await endedAt(dataDir)) return false;
  try {
    await writeFileAtomic(path.join(dataDir, FILE), JSON.stringify({ at: Math.floor(at) }));
    return true;
  } catch {
    return false; // the chat falls back to the plain card, nothing else depends on it
  }
}

// When the trial ended, in ms, or 0 when it never did on this PC.
async function endedAt(dataDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dataDir, FILE), 'utf8'));
    return Number.isSafeInteger(parsed && parsed.at) && parsed.at > 0 ? parsed.at : 0;
  } catch {
    return 0;
  }
}

module.exports = { noteEnded, endedAt, FILE };
