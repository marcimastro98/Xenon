'use strict';

// What a person calls a screen: the model name the shell read from the monitor. Two of the
// same model differ by size, or by a number when that is the same too; with no name, only
// the size is left. One owner: the Xenon menu (server/menu-tune.js) and the first question
// (js/usage-ask-plan.js) must say the same name.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenName = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const pixels = (m) => (m.width && m.height ? m.width + '×' + m.height : '');

  function screenName(m, screens) {
    const size = pixels(m);
    if (!m.name) return { name: '', size };
    const twins = screens.filter((x) => x.name === m.name);
    if (twins.length < 2) return { name: m.name, size };
    const bySize = size && twins.filter((x) => pixels(x) === size).length === 1;
    return { name: m.name + ' ' + (bySize ? size : twins.indexOf(m) + 1), size };
  }

  return Object.freeze({ screenName });
});
