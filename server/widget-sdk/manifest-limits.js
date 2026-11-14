'use strict';
// How much a widget's manifest may declare: its size, the number of packages scanned, and the
// caps on hosts, hooks, macros, states and key handlers.

const MANIFEST_MAX_BYTES = 32 * 1024;
// How many installed packages the scan will load. Was 32, which a supporter
// with a shelf of community widgets passes without noticing — and passing it
// was silent: the scan stopped, and every folder past the cap existed on disk,
// installed correctly, while being absent from the package list, absent from
// the invalid list, and therefore absent from the tile picker, the palette and
// the Store's idea of what is installed. Reported on Discord as a widget that
// installs, reports success, and cannot be found afterwards — reinstalled three
// times, and dropped into the folder by hand, with the identical result. The
// folders are read in name order, so it is always the same alphabetical tail
// that disappears.
//
// Two answers, and both are needed. The number moves to a size no real library
// reaches (a scan is a stat + a bounded read + a parse per folder, cached and
// re-run only on install or Rescan), and listPackages now COUNTS what it left
// out so the surfaces can say so instead of showing a shorter list.
const MAX_PACKAGES = 96;

// Caps for the manifest extensions (all additive to api 1).
const MAX_HOSTS = 8;
// User-filled host slots. Deliberately smaller than MAX_HOSTS: each slot is a
// field a human has to understand and type at approval time, so a package that
// wants four of them is already asking too much.
const MAX_USER_HOSTS = 4;
const USER_HOST_SCOPES = Object.freeze(['private', 'any']);
const MAX_HOOKS = 8;
const MAX_MACROS = 8;
const MAX_MACRO_STEPS = 10;
const MAX_STATES = 8;
// Handler actions (deck keys answered by the widget's own code) and their
// declared per-key params. Small on purpose: a handler is a named entry point,
// not a scripting surface.
const MAX_HANDLERS = 8;
const MAX_HANDLER_PARAMS = 4;
const HANDLER_PARAM_KINDS = Object.freeze(['text', 'select', 'number']);
const HANDLER_ARG_TEXT_MAX = 200;
// Per-step delay cap for SDK macros. Lower than the native Deck step cap
// (clampDelay's 10s) ON PURPOSE: an SDK macro runs server-side inside one
// /actions/run request, so its total wait must stay bounded. The registry
// enforces the SAME number at run time — keep the two in lockstep.
const MAX_MACRO_STEP_DELAY_MS = 5000;

// The shapes a package may say it was drawn for (manifest "size").
const TILE_SIZES = Object.freeze(['small', 'medium', 'wide', 'tall', 'large']);

module.exports = {
  MANIFEST_MAX_BYTES, MAX_PACKAGES, MAX_HOSTS, MAX_USER_HOSTS, USER_HOST_SCOPES, MAX_HOOKS,
  MAX_MACROS, MAX_MACRO_STEPS, MAX_STATES, MAX_HANDLERS, MAX_HANDLER_PARAMS, HANDLER_PARAM_KINDS,
  HANDLER_ARG_TEXT_MAX, MAX_MACRO_STEP_DELAY_MS, TILE_SIZES,
};
