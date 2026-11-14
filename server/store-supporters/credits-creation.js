'use strict';
// Which rounds of a turn paid with Sparks are handed from the chat model to the creation model,
// and the tools the creation model gets.

const { CREATION_MAX_TOKENS } = require('./credits-limits.js');

// Everyday turns (a question, a command, a voice turn) run on Haiku. Every
// round carries about 23K tokens of instructions and tools: caching them costs
// half a credit on Haiku and over ten on Sonnet, so the chosen model is kept
// for what it is chosen for, creations. A round that reaches for a creation
// tool is asked again of that model, which writes the rest of the turn; the
// Haiku round's tool calls are dropped unrun. A Haiku round cut at its length
// limit was writing something large itself (a whole widget, a long fix): it is
// handed over the same way, not answered with an empty reply.
const CHAT_MODEL = 'haiku';
const CREATION_TOOLS = new Set([
  'create_preset', 'preset_reference', 'create_widget', 'sdk_reference',
  'create_animated_background', 'create_dashboard_style', 'configure_deck',
]);

function reachesForCreation(resp) {
  if (resp && resp.stop_reason === 'max_tokens') return true;
  return Array.isArray(resp && resp.content)
    && resp.content.some((b) => b && b.type === 'tool_use' && CREATION_TOOLS.has(b.name));
}

// The creation model gets the creation tools only (plus the Store search, for
// what it cannot write, my_widgets to change one the user has, and any tool
// this turn already called): the other seventy-odd tools are most of what its
// cache write costs, and a creation never plays music or sets a timer.
// The Deck catalog is read for a creation and to run one action now: only
// configure_deck, not the lookup, hands the turn over.
const CREATION_KIT = new Set([...CREATION_TOOLS, 'deck_action_catalog', 'marketplace_search', 'my_widgets']);
function forCreation(body, effort) {
  const room = { effort, max_tokens: CREATION_MAX_TOKENS[effort], use: 'create' };
  if (!Array.isArray(body.tools)) return { ...body, ...room };
  const used = new Set();
  for (const m of body.messages || []) {
    for (const b of Array.isArray(m.content) ? m.content : []) if (b && b.type === 'tool_use') used.add(b.name);
  }
  return { ...body, ...room, tools: body.tools.filter((t) => CREATION_KIT.has(t.name) || used.has(t.name)) };
}

module.exports = { CHAT_MODEL, CREATION_TOOLS, reachesForCreation, CREATION_KIT, forCreation };
