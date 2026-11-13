// The two tools Bit gets when memory is on: remember a fact about the user, and forget one.

// Persistent-memory tool declarations (remember/forget a durable fact). Gated on
// the aiMemory setting at BOTH callers — the /api/ai turn-based handler and the
// Voce Live endpoint — so "remember this" works by voice in either mode. Fresh
// array each call.
function buildMemoryFunctions() {
  return [
    { name: 'remember_fact', description: 'Save a durable fact about the USER to your persistent memory so you recall it in future conversations (their name, hardware, preferences, favourite teams, routines, how they like things). Write it as a short third-person statement, e.g. "The user\'s name is Anna", "The user has an RTX 4090", "The user supports Napoli". Call this whenever the user shares something worth remembering. Do NOT store secrets/passwords or one-off task details, and do NOT store something you already remember.', parameters: { type: 'OBJECT', properties: {
      fact: { type: 'STRING', description: 'The fact to remember, as a short third-person statement.' },
    }, required: ['fact'] } },
    { name: 'forget_fact', description: 'Remove something from your persistent memory when the user asks you to forget it or corrects an outdated fact. Pass the fact text (or a distinctive part of it) to remove.', parameters: { type: 'OBJECT', properties: {
      fact: { type: 'STRING', description: 'The fact (or a distinctive part of it) to forget.' },
    }, required: ['fact'] } },
  ];
}

module.exports = { buildMemoryFunctions };
