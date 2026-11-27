---
name: build-look
description: Make a theme, an animated background or a whole look for the Xenon dashboard with the xenon-widgets tools. Use when the person asks for a Xenon theme, colours, a background animation, a dashboard look or a package of them ("make me a cyberpunk theme for Xenon", "an animated background with stars", "a theme with a moving background"). For widgets use build-widget.
---

# Make a Xenon theme or background

Xenon is a dashboard for any spare screen. A theme is its whole visual identity (light or dark, canvas, panels,
text, state colours, glass, roundness). An animated background is a small piece of JavaScript drawn on a canvas
behind the tiles, in a sandbox with no network and no access to files. Both travel as a share code. The tools check
it with the same rules Xenon's own assistant uses, then open it in Xenon's import window, where the person looks at it
and confirms. Nothing changes on their dashboard before that.

## The loop

1. `xenon_status`. If Xenon is not running, say so and stop.
2. `preset_reference` with the kind: `theme`, `bg`, or `bundle` for a theme and a background together. Read every
   field and its range: do not guess keys.
3. Ask only what changes the result: the mood or reference, dark or light, calm or lively motion.
4. Write it. A background's code goes in its own `.js` file, passed as `codeFile`, so it never needs escaping in
   JSON: for `bg` it becomes `data.code`, for a theme `data.bgCustom.code`, for a bundle `data.bg.code`.
5. `check_preset`. `report` lists what the import would drop or change; `critique` lists design and performance
   findings. Fix every `fix` item and anything dropped, then check again.
6. `import_preset`. The import window opens on the dashboard: tell the person to look and press Import.
7. After they confirm, `dashboard_screenshot`. Look at the picture: are the tiles readable over it, does the motion
   pull the eye away from the numbers? Adjust and import again.
8. `check_preset` also returns the share code (when it is short enough) for the person to keep or send.

## Backgrounds

- The code is the body of `function (canvas, ctx, assets)` and defines `function draw(ctx, t, w, h, assets)`. `t` is
  seconds since start; `w`, `h` the size in pixels. Paint the whole frame every time.
- It runs at `fps` (30 by default, 10 to 60). Near-static looks are happy at 10 to 20. Speed never depends on fps:
  move things by `t`, not by frame count.
- Keep each frame small and steady: a fixed number of shapes made once, no arrays that grow, no `shadowBlur` or
  `filter` over the whole canvas, no `getImageData` in `draw`. The critique names the costly calls.
- It sits behind every tile, so keep it dark and low in contrast where the tiles are, and let colour live at the
  edges. A background that competes with the readouts is a bad background.
- `w` and `h` are the screen in CSS pixels, and any shape: a 2560x720 bar, 16:9, 16:10, a phone. Place things as
  fractions of them. A photo fills every screen with `Math.max(w / img.width, h / img.height)`, centred; `Math.min`
  leaves bars on other shapes.
- Pictures go in `assets` as `data:image/...` URLs and arrive as loaded images; the reference gives the limits.
  Prefer JPEG for photos, and never hide bytes inside another image to get past a limit.

## Themes

- Set `autoPalette: false`, or Xenon follows the system and ignores your colours.
- Set at least `accent`, `background` and `text`; leave other roles out and Xenon derives them from the surface.
- `contrastGuard` stays on unless the person asks for exact low-contrast art: it repairs unreadable pairs and keeps
  colours that already pass.
- A pair for light and dark mode goes in `paletteVariants`. Glass is `panelAlpha`, `glassBlur` and `glassSaturate`;
  roundness is `uiRoundness`; `styleMode` picks liquid, glass, retro or comic.
- A theme can carry its background in `bgCustom`; a `bundle` adds pages, the top bar and more.

The person always confirms in Xenon's own window. Fonts cannot be generated: the person keeps their own.
