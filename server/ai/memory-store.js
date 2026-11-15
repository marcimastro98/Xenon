// What the assistant was asked to remember about the person, made when the engine starts: the
// file is read at the first use.

const { createAiMemory } = require('./ai-memory.js');
const { DATA_DIR } = require('../engine/paths.js');

// Xenon's persistent memory of the user (data/ai-memory.json). Local, private,
// injected into the AI system prompt so the assistant remembers across sessions.
const aiMemory = createAiMemory({ dataDir: DATA_DIR });

module.exports = { aiMemory };
