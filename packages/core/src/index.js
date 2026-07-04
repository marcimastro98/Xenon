'use strict';

/**
 * @xenon/core — barrel for Node consumers (tests, the iCUE packaging step and
 * any tooling that `require()`s the shared code).
 *
 * The browser dashboard (server/) and the iCUE widget (widget/) do NOT go
 * through this barrel: they load each `src/*.js` file directly as a classic
 * `<script>`, and every core module is authored UMD-lite so it attaches its
 * public API to `window.Xenon.<name>` in that context while still exporting via
 * CommonJS here. That keeps a single source of truth without forcing either
 * surface onto ES modules or a bundler.
 */

module.exports = {
  constants: require('./constants'),
  format: require('./format'),
};
