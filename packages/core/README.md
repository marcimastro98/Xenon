# @xenon/core

Surface-agnostic shared code for Xenon — the **single source of truth** for logic
that would otherwise be duplicated across the four surfaces:

- the browser dashboard served by `server/`
- the same dashboard embedded in an iCUE `<iframe>`
- the native iCUE widget in `widget/`
- the native Tauri app in `apps/native/`

## What lives here

Only code that is **pure and surface-agnostic**:

- the i18n dictionary and `tr()`
- constants (loopback base URL, supported languages, weather codes, …)
- pure formatters (date/time, bytes → GB, percentages)
- normalized sensor data models
- the loopback API / SSE / WebSocket **client contract** (fetch/EventSource/ws helpers)

Stateful, surface-specific modules stay in their surface (deck, lighting, AI,
dashboard grid in `server/`; the iCUE lifecycle adapter in `widget/`).

## Authoring rule — UMD-lite, no build

Every `src/*.js` file must work in **three** loaders without a bundler:

1. a browser **classic `<script>`** (the dashboard and the widget) — it attaches
   its public API to `window.Xenon.<name>`;
2. Node `require()` (tests, the iCUE packaging step) — it exports via
   `module.exports`;
3. the iCUE packaging step, which inlines these files at package time.

Use this header:

```js
;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.NAME = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // module body — return the public API
  return {};
});
```

## How the browser reaches these files

The `server/` static handler only serves paths under `server/`, so the browser
cannot read `packages/core` directly. A Windows **directory junction**
`server/shared → packages/core` (created by `npm run link:shared`, also run on
`postinstall`) exposes them at `/shared/*`, served by the existing static handler
with `shared` added to its allowlist. `server/shared` is git-ignored — the
junction is recreated per checkout, never committed. Editing happens only here in
`packages/core`.
