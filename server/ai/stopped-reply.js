// Answers a turn the user stopped: no text, with what its tools had already made.

const aiTurns = require('../ai-turns.js');

// The user stopped the turn (ai-turns.js): answered as a reply with no text,
// carrying what its tools already made. False for any other error.
function aiStoppedReply(e, json, extra) {
  if (!e || (e.code !== 'turn_stopped' && e.code !== 'cli_cancelled')) return false;
  json({ stopped: true, text: '', clientActions: aiTurns.madeSoFar(), ...extra });
  return true;
}

module.exports = { aiStoppedReply };
