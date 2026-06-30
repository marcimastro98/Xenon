# Xenon — native iCUE widgets

Clean rebuild of the Xenon dashboard as **independent** native iCUE widgets for the
CORSAIR Xeneon Edge (and pump / keyboard LCDs where it makes sense). The production web
widget (`../server/`) and the legacy attempt (`../widget/`) are untouched.

See [`CLAUDE.md`](CLAUDE.md) for the working rules and [`docs/parity.md`](docs/parity.md)
for the conversion checklist. Scope authority: `../report corsair/Xenon-SDK-Feasibility.html`.
SDK authority: [`reference/`](reference/) — offline CORSAIR SDK mirror (`skill.md`, `docs/`, `references/`).

## Layout

```
common/            shared, reusable code (inlined into widgets at build time)
widgets/<name>/    one independent, packageable widget (source)
tools/package.mjs  inliner — produces self-contained widgets in dist/
dist/<name>/       build output, ready to load in iCUE (git-ignored)
docs/parity.md     living conversion checklist
```

## Develop

Open a widget's `index.html` directly in a browser to iterate — shared `<script src>`
includes resolve normally there, and the widget renders outside iCUE thanks to the
`iCUE_initialized` fallback. Resize the window to the device slots (see `CLAUDE.md` /
`reference/references/css-template.md`) to check responsiveness.

## Build (for iCUE)

```bash
node tools/package.mjs            # package every widget
node tools/package.mjs clock      # just one
```

This inlines `common/` scripts and the widget stylesheet into a single self-contained
`index.html` (required because iCUE blocks external `<script src>` from file://) and
copies `manifest.json`, `translation.json` and `resources/` into `dist/<name>/`.
Load that folder in iCUE, or validate/package it with the `icuewidget` CLI when available.
