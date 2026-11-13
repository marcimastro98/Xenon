'use strict';

// Pure formatters live in @xenon/core (served at /shared). Delegate to them when
// present, keeping the original inline bodies as a fallback so the dashboard still
// works if /shared is briefly unavailable. The fallbacks must stay byte-identical
// to packages/core/src/format.js.
const _xcFmt = (typeof window !== 'undefined' && window.Xenon && window.Xenon.format) || null;
