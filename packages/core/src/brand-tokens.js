;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.brandTokens = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Xenon's one look outside the dashboard themes: the site, the Maker, the
   * emails, the native splash, the logo and the app's own Beta tags. The
   * surfaces copy these values and their tests hold them equal, so a change
   * starts here (brand refresh, 27 Oct 2026).
   *
   * Why it looks like this:
   * - The base is neutral grey. The one interface colour is Bit's green, the
   *   colour of the mark: the main action of each screen (download, support,
   *   install) is filled with it, and what is picked or on and links wear it
   *   lighter. One element unlike the rest is the one found and remembered
   *   (von Restorff 1933); an all-grey interface read as monotone and did not
   *   pull towards support (owner's call, 27 Oct 2026, over three previews).
   *   Bit's other moods keep "careful" and "problem"; status colours carry
   *   meaning and are never alone: Bit's face changes and a sentence says
   *   what is wrong (WCAG 1.4.1).
   * - Dark grey, not black (Material dark theme); cool, low-saturation
   *   neutrals read as more trustworthy for a technical tool, and Bit brings
   *   the warmth.
   * - Small rounded corners: people prefer curved contours (Bar & Neta 2006);
   *   a tag stays smaller and squarer than a button so it is not mistaken
   *   for one.
   * Text holds 4.5:1 on every surface, Bit's colours 3:1 (non-text, 1.4.11).
   */

  const MODES = Object.freeze({
    dark: Object.freeze({
      surface: Object.freeze(['#232323', '#2c2c2c', '#333333', '#3c3c3c']),
      rule: '#464646',
      ruleStrong: '#5c5c5c',
      text: Object.freeze(['#ededed', '#bdbdbd', '#a6a6a6']),
      // Under the preview canvas: a step below the page.
      stage: '#1b1b1b',
      main: '#6ee787',
      mainHover: '#8bf0a0',
      mainInk: '#0b2412',
      // The green as words: links, a picked tab, a switch that is on.
      mainText: '#6ee787',
      // Picked parts on an editor's canvas; blue is the editors' convention.
      select: '#6ea8ff',
      // Bit's mood colours (packages/core bit-clips MOOD_RGB) as fills.
      bit: Object.freeze({ ok: '#6ee787', idle: '#ffd75e', worry: '#ffa657', angry: '#ff5a5f', think: '#b4a0ff', sleep: '#8ab4f8' }),
    }),
    light: Object.freeze({
      surface: Object.freeze(['#e4e4e4', '#efefef', '#d8d8d8', '#cbcbcb']),
      rule: '#c4c4c4',
      ruleStrong: '#a3a3a3',
      text: Object.freeze(['#141414', '#444444', '#545454']),
      stage: '#d4d4d4',
      main: '#1f8040',
      mainHover: '#1a6e37',
      mainInk: '#ffffff',
      mainText: '#145e2c',
      select: '#1f5fd1',
      // The same moods deepened until they hold on light grey.
      bit: Object.freeze({ ok: '#1f8040', idle: '#6e5200', worry: '#843c0a', angry: '#9a2016', think: '#5b45c9', sleep: '#2a5bb8' }),
    }),
  });

  const RADIUS = Object.freeze({ tag: 4, control: 6, panel: 10 });

  const FONT = Object.freeze({
    display: "'Sofia Sans Semi Condensed', 'Sofia Sans', system-ui, sans-serif",
    text: "'Sofia Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
    code: "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace",
  });

  // NN/g (Laubheimer 2020): ~100ms feedback, 200-300ms something entering.
  const MOTION = Object.freeze({
    fast: 100,
    base: 180,
    slow: 260,
    ease: 'cubic-bezier(0.2, 0, 0, 1)',
    easeIn: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  });

  return { MODES, RADIUS, FONT, MOTION };
});
