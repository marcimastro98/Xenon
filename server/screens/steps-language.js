// The language the steps recorder writes in: the user's, or English.

const { hub } = require('../settings/current.js');

// The steps recorder (steps-recorder.js): every click a step, written up in
// the user's language in Documents/Xenon/Steps. State to every dashboard over
// SSE `steps` (the Deck key, the "Recording steps" card); the document over
// SSE `capture` with the count only, never a step's text.
const stepsLanguage = () => (hub.settings && hub.settings.language) || 'en';

module.exports = { stepsLanguage };
