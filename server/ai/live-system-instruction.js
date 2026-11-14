// What the live voice conversation is told before it starts: the date and time, who it is, what
// it remembers of the person, and the language to answer in.

const { aiMemory } = require('./memory-store.js');
const { hub } = require('../settings/current.js');

function _buildLiveSystemInstruction({ langName, summary }) {
  const now = new Date();
  const nowDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const nowTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const memText = (hub.settings && hub.settings.aiMemory !== false && aiMemory.count() > 0)
    ? ' ' + aiMemory.formatForPrompt() : '';
  const sumText = summary ? ` Earlier in this conversation: ${summary}` : '';
  const langText = langName ? ` Always reply in ${langName}.` : '';
  return `Current date and time: ${nowDate}, ${nowTime} (${tz}). You are Xenon, the voice assistant for a dashboard the user runs on a second screen of their own. This is a spoken conversation: keep answers short and natural, 1-2 sentences, no markdown, no lists. Use the provided tools to control the dashboard when the user asks, and confirm briefly what you did. For questions about how Xenon itself works (setup, features, sensors, updates, marketplace, troubleshooting), call xenon_knowledge first and answer from its card. When the user asks you to make something (a theme, a page, a widget, an Ambient scene, a Deck profile, a package), ground it with preset_reference, build it with create_preset, and fix every critique "fix" item with another create_preset call before you speak about it; then say in one sentence what you made and that it is open in the import window for them to check. Never read codes, JSON or file contents aloud.` + memText + sumText + langText;
}

module.exports = { _buildLiveSystemInstruction };
