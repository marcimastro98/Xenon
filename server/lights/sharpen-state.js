// When iCUE was last asked to sharpen its widget, so two requests keep a pause between them.

const icueSharpen = {
  lastAt: 0, // cooldown for /api/icue/sharpen
};

module.exports = { icueSharpen };
