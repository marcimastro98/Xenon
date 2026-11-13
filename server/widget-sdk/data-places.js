// Where installed widget packages, the record of where each came from and the artwork kept for
// widgets sit in the user's data folder.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

// Third-party widget packages (sandboxed SDK widgets): one folder per package.
// Served ONLY through the dedicated /sdk/widget/ handler (strict path + CSP);
// the generic static handler never reaches into DATA_DIR.
const SDK_WIDGETS_DIR = path.join(DATA_DIR, 'widgets');

// ── Package origin store (redistribution policy) ────────────────────────────
// Records WHERE each installed package came from, so exports are limited to the
// user's OWN creations: 'import' arrived via a share code / bundle / gallery,
// 'creator' via the Widget Creator or the AI tool, 'builtin' is the bundled
// example. No record = a developer-dropped folder ('local') → the user's own
// work. This is policy, not a security boundary — but GET /sdk/export enforces
// it server-side, so an imported package can never round-trip into a new code.
// The merge rules (mergeOrigin/originExportable) are pure in sdk-widgets.js.
const WIDGET_ORIGINS_FILE = path.join(DATA_DIR, 'widget-origins.json');

// Widget artwork, kept across restarts (GET /sdk/asset/…). Bounded per package
// and in total, swept on a timer; see sdk-asset-cache.js for why the bound is
// the feature rather than a detail of it.
const SDK_ASSETS_DIR = path.join(DATA_DIR, 'widget-assets');

module.exports = { SDK_WIDGETS_DIR, WIDGET_ORIGINS_FILE, SDK_ASSETS_DIR };
