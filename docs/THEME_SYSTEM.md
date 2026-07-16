# Xenon semantic theme system

Xenon themes use semantic color roles. Components never need a separate color
map for Light, Dark, Comic, or a community theme: they consume the same CSS
variables and the palette engine derives any role the author leaves on `Auto`.

## Theme roles

| Setting key | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--bg` | App canvas behind panels |
| `surface` | `--surface`, `--panel-rgb` | Widgets, panels, modals, menus |
| `surfaceAlt` | `--surface-alt` | Nested cards, rows, tabs |
| `controlColor` | `--control-bg`, `--input-bg` | Inputs, selects, button wells |
| `text` | `--text` | Primary text and icons |
| `mutedText` | `--muted-text` | Labels and secondary copy |
| auto-derived | `--dim-text` | Tertiary and disabled copy |
| `lineColor` | `--line`, `--border` | Borders and dividers |
| `accent` | `--accent` | Selection, focus and primary action |
| `accentText` | `--on-accent` | Foreground on an accent fill |
| `successColor` | `--color-success` | Success state |
| `warningColor` | `--color-warn` | Warning state |
| `dangerColor` | `--color-danger` | Error/destructive state |
| `infoColor` | `--color-info` | Informational state |

The engine also exposes `--on-success`, `--on-warning`, `--on-danger`, and
`--on-info`. Use those variables as foregrounds on the corresponding solid
state color. `--success-bg`, `--warning-bg`, `--danger-bg`, and `--info-bg`
provide theme-aware translucent state surfaces; the matching `--*-rgb` tokens
support legacy `rgba(var(--danger-rgb), .2)` effects.

## Minimal and complete themes

Old three-color themes remain valid:

```json
{ "accent": "#ff4058", "background": "#f4edcf", "text": "#201a18" }
```

Xenon derives panels, controls, secondary text, lines, and state colors from
those values. A theme can override any role when its art direction needs exact
materials:

```json
{
  "appearance": "light",
  "styleMode": "comic",
  "accent": "#ef4058",
  "background": "#d9cfaa",
  "surface": "#f4edcf",
  "surfaceAlt": "#e9dfbd",
  "controlColor": "#ded2ad",
  "text": "#201a18",
  "mutedText": "#625850",
  "lineColor": "#403833",
  "accentText": "#111111",
  "successColor": "#236844",
  "warningColor": "#735514",
  "dangerColor": "#9d2e37",
  "infoColor": "#245f78",
  "contrastGuard": true
}
```

`appearance` seeds a usable Light or Dark palette. `Auto` follows the Windows
scheme until the user manually edits a color. The actual compatibility tone is
calculated from `surface`, so a mislabeled imported theme does not select the
wrong component rules.

Legacy settings that selected `Auto` before `autoPalette` existed are migrated
to the same OS-following behavior. Once a color is edited, `autoPalette:false`
is persisted so that manual palette remains stable across OS mode changes.

## Contrast guard

`contrastGuard` defaults to `true`. The engine preserves valid author colors
and repairs only unsafe foreground/background pairs:

- primary text on `surface`: target 7:1;
- muted text and semantic states on `surface`: target 4.5:1;
- text/icons on `accent`: target 4.5:1;
- tertiary text: target 3:1.

The user can disable the guard for deliberate display artwork, but production
themes and generated themes should keep it enabled.

## Component contract

Application components should use semantic roles, never literal light/dark
fills:

```css
.my-panel { color: var(--text); background: var(--surface); border: 1px solid var(--line); }
.my-row { color: var(--text); background: var(--surface-alt); }
.my-input { color: var(--text); background: var(--input-bg); border-color: var(--line); }
.my-primary { color: var(--on-accent); background: var(--accent); }
.my-error { color: var(--color-danger); }
```

Brand artwork and immersive media can define a local palette on their root.
Do not apply a dark-island palette to portaled menus or editors: those are app
chrome and must follow the global semantic theme.

Skins such as `comic` and `retro` may change geometry, type, shadows, and
texture. They should not duplicate every component color. Comic consumes the
same semantic roles, so both light paper and dark comic palettes work.

An immersive component may opt into a local material when that material is an
explicit component setting. The Deck's `vivid` (Fumetto) cap style is the
reference: it is scoped to `.deck-root[data-capstyle="vivid"]`, carries a complete
local paper/ink palette so it works under any dashboard style, mixes authored key
accents into that material, and puts light or dark imported icons and captions on
a contrast-backed paper layer. The selected cap style, shape, plate, well artwork
and music-strip styling belong to the individual Deck profile and travel with it;
the dashboard's `comic` style must never force sibling Deck profiles to change.
Continuous material motion must animate transforms or opacity only and provide
both `prefers-reduced-motion` and Performance Mode exits.

## Per-widget override

The in-app widget style editor and page presets use the same `style` object:

```json
{
  "mode": "custom",
  "accent": "#ef4058",
  "panel": "#f4edcf",
  "surfaceAlt": "#e9dfbd",
  "controlColor": "#ded2ad",
  "text": "#201a18",
  "mutedText": "#625850",
  "lineColor": "#403833",
  "accentText": "#111111",
  "contrastGuard": true
}
```

Every field is optional. Missing fields inherit the effective global palette;
the result is then derived and scoped to that tile. The style object already
round-trips through dashboard layout storage, page presets, backup export, and
backup import.

## Import, export, and saved themes

The Appearance theme format includes every role above plus `appearance`,
`autoPalette`, skin/material settings, font, and background effects. Theme
export/import and saved theme cards use the same allowlist. Older exports omit
the new keys and are upgraded through derivation; unknown keys are dropped.

All global values are normalized on both client and server before persistence.
This prevents a restart, another dashboard surface, or backup restore from
silently stripping semantic colors.

## Widget SDK

Sandboxed SDK widgets receive the effective, contrast-checked palette in both
`init.theme.palette` and subsequent `theme` messages. See
[WIDGET_SDK.md](WIDGET_SDK.md#4-theme--host--widget) for the payload and a CSS
variable adapter. The historical flat `accent`, `background`, and `text` fields
remain available for compatibility. The payload is computed from the iframe
element after tile scoping, so a custom widget receives its own local override
rather than the global palette. `theme.overrides` identifies which roles were
explicitly changed on that tile when a widget needs to preserve authored values
for every other role.
