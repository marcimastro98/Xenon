# `common/` — shared widget library

Reusable building blocks shared by every widget in `icue/widgets/`.

**Why a build step:** QtWebEngine silently blocks external `<script src>` from a widget's
`file://` page, so the distributed widget must have **all JS inlined** in `index.html`.
We still author shared code *once* here; the packager (`icue/tools/`) inlines the pieces a
widget declares into its final `index.html`. Source stays DRY, output stays self-contained.

Each file is a plain script (no ES `import` at runtime) that defines a small, single-purpose
piece. Keep files short and focused — one concern per file.

```
common/
  plugins/sdk-plugins.js   official iCUE plugin wrappers (Sensors, Media, Link) + base
  runtime/icue.js          iCUE property access + lifecycle helpers
  format/datetime.js       locale-aware date/time formatting (DateFormatter)
  format/color.js          hex → "r, g, b" for rgba()
  i18n/i18n.js             runtime body-text translation (added with first localized widget)
  storage/local-store.js   XenonStore — try/catch localStorage wrapper (string + JSON);
                           swappable for a local-file backend with the Phase 4 bridge
  ui/custom-select.js      styled <select> replacement (QtWebEngine can't style native
  ui/custom-select.css     popups). Add data-custom-select [data-cs-fixed], call
                           initAllCustomSelects(). Use this for EVERY dropdown.

```
