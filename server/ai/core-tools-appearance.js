// The tools the assistant always has to change how the dashboard looks and what it prefers.

function appearanceAiFunctions() {
  return [
        // ── Appearance & preferences (fine-grained dashboard customization) ──
        { name: 'customize_appearance', description: 'Change the dashboard look in detail. Pass any subset: a named theme preset, the light/dark/auto mode, the base skin (liquid/glass/retro/comic), or exact semantic colours for the app canvas, panels, nested surfaces, controls, text, borders, accent and UI states. Use this (not change_theme) for any specific-colour request. Applies live, contrast-checks by default and persists.', parameters: { type: 'OBJECT', properties: {
          preset: { type: 'STRING', description: 'Optional named theme: xenon, ocean, ember, violet, mono' },
          style: { type: 'STRING', description: 'Optional base skin: "liquid" (Liquid Glass, real blur over the wallpaper), "glass" (Classic), "retro" (Pixel Retro CRT), or "comic" (Comic Book)' },
          appearance: { type: 'STRING', description: 'Optional UI mode: light, dark, or auto' },
          accent: { type: 'STRING', description: 'Optional accent colour as #RRGGBB (the highlight/brand colour)' },
          background: { type: 'STRING', description: 'Optional app canvas/background colour as #RRGGBB' },
          surface: { type: 'STRING', description: 'Optional main panel/widget/modal surface colour as #RRGGBB' },
          surface_alt: { type: 'STRING', description: 'Optional secondary row/card/tab surface colour as #RRGGBB' },
          control_color: { type: 'STRING', description: 'Optional input/menu/button surface colour as #RRGGBB' },
          text: { type: 'STRING', description: 'Optional primary text colour as #RRGGBB' },
          muted_text: { type: 'STRING', description: 'Optional secondary text colour as #RRGGBB' },
          line_color: { type: 'STRING', description: 'Optional border/divider colour as #RRGGBB' },
          accent_text: { type: 'STRING', description: 'Optional text/icon colour used on accent-filled controls as #RRGGBB' },
          success_color: { type: 'STRING', description: 'Optional success state colour as #RRGGBB' },
          warning_color: { type: 'STRING', description: 'Optional warning state colour as #RRGGBB' },
          danger_color: { type: 'STRING', description: 'Optional danger/error state colour as #RRGGBB' },
          info_color: { type: 'STRING', description: 'Optional informational state colour as #RRGGBB' },
          contrast_guard: { type: 'BOOLEAN', description: 'Automatically repair unsafe text/control contrast (default true)' },
        } } },
        { name: 'style_tile', description: 'Dress ONE tile, as the Material tab of its style window does: what it is made of and the colour of the glass. Use it when the user names a single tile ("clear glass on the music tile", "make the chat violet"); for the whole dashboard use customize_appearance. Works on every skin. Pass tile and at least one of material and tint. Applies live and saves with the layout. Its shape, pictures and frames stay in the style window: open layout mode for those.', parameters: { type: 'OBJECT', properties: {
          tile: { type: 'STRING', description: 'The tile: its id when you know it (media is the music player; chat, calendar, agenda, tasks, notes, system, audio, mic, timer, weather) or just its name as shown on screen, in the user\'s language' },
          material: { type: 'STRING', description: 'One of: liquid (Liquid Glass), clear (nearly see-through), frosted (thick blur), solid (nothing shows through), none (no panel, only the content over the background), theme (back to what the theme gives)' },
          tint: { type: 'STRING', description: 'Colour of the glass as #RRGGBB, or "none" for the colour of the theme. On a dark look use a deep colour, so light text stays readable' },
        }, required: ['tile'] } },
        { name: 'create_dashboard_style', description: 'Build a COMPLETE custom dashboard theme from a description, apply it live, and save it as a named card in the Temi gallery so the user can switch back to it. Pass any subset: every field defaults to the current look. Use this when the user asks for a whole vibe/aesthetic rather than one colour ("crea un tema cyberpunk viola", "make me a warm minimalist theme", "un look pastello morbido e arrotondato"). Prefer create_preset kind "theme" when the theme needs its own light AND dark palettes, or when the user wants a code to share or to review before applying.', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'Short theme name for the gallery card (e.g. "Cyberpunk Viola")' },
          skin: { type: 'STRING', description: 'Base skin: "liquid" (Liquid Glass, real blur over the wallpaper), "glass" (Classic), "retro" (Pixel Retro CRT), or "comic" (Comic Book)' },
          base_appearance: { type: 'STRING', description: 'Base mode: "light" or "dark"' },
          accent: { type: 'STRING', description: 'Accent/brand colour #RRGGBB' },
          background: { type: 'STRING', description: 'App canvas/background colour #RRGGBB' },
          surface: { type: 'STRING', description: 'Main panel/widget/modal surface colour #RRGGBB' },
          surface_alt: { type: 'STRING', description: 'Secondary row/card/tab surface colour #RRGGBB' },
          control_color: { type: 'STRING', description: 'Input/menu/button surface colour #RRGGBB' },
          text: { type: 'STRING', description: 'Primary text colour #RRGGBB' },
          muted_text: { type: 'STRING', description: 'Secondary/muted text colour #RRGGBB' },
          line_color: { type: 'STRING', description: 'Dividers/borders colour #RRGGBB' },
          accent_text: { type: 'STRING', description: 'Text/icon colour on accent-filled controls #RRGGBB' },
          success_color: { type: 'STRING', description: 'Success state colour #RRGGBB' },
          warning_color: { type: 'STRING', description: 'Warning state colour #RRGGBB' },
          danger_color: { type: 'STRING', description: 'Danger/error state colour #RRGGBB' },
          info_color: { type: 'STRING', description: 'Informational state colour #RRGGBB' },
          contrast_guard: { type: 'BOOLEAN', description: 'Automatically repair unsafe text/control contrast (default true)' },
          panel_opacity: { type: 'NUMBER', description: 'Panel opacity 0.05–1 (lower = more translucent)' },
          corner_radius: { type: 'NUMBER', description: 'Corner roundness 0–2 (0 = square, 1 = default, 2 = very round)' },
          glass_blur: { type: 'NUMBER', description: 'Glass blur in px 0–40 (default 22)' },
          glass_saturation: { type: 'NUMBER', description: 'Glass colour saturation % 100–220 (default 160)' },
          border_strength: { type: 'NUMBER', description: 'Panel border strength 0–2 (1 = default)' },
          shadow_strength: { type: 'NUMBER', description: 'Tile drop shadow strength 0–2 (0 = default, no shadow)' },
        } } },
        { name: 'create_animated_background', description: 'Write and apply a custom ANIMATED BACKGROUND for the dashboard from the user\'s description. YOU author the code: define a JavaScript function draw(ctx, t, w, h) that paints ONE frame, ctx is a canvas 2D context, t is elapsed seconds (float), w and h are the pixel size. It is called ~60×/second on a full-screen canvas behind the dashboard. Keep it self-contained (declare any particles/state with const or let ABOVE the draw function so it persists across frames), efficient, and tasteful behind a UI (avoid a pure-white fill or harsh strobing). The code runs in an isolated sandbox with NO network, DOM, storage or dashboard access, so use only the canvas 2D API, Math and Date. Use for requests like "crea uno sfondo animato con particelle blu", "make me a drifting starfield background", "sfondo tipo nebulosa viola". Applies live and persists.', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'Short name for this background (e.g. "Nebulosa viola")' },
          code: { type: 'STRING', description: 'The full JavaScript source defining function draw(ctx, t, w, h). May declare helper state/constants above draw. No imports, no network, no DOM.' },
        }, required: ['code'] } },
        { name: 'configure_preferences', description: 'Adjust dashboard preferences: 12h/24h clock, temperature unit, interface language, weather location, and which widgets appear on the focus lock screen. Pass only the fields the user asked to change. Applies live and persists.', parameters: { type: 'OBJECT', properties: {
          clock_format: { type: 'STRING', description: 'Clock format: auto, 12, or 24' },
          temp_unit: { type: 'STRING', description: 'Temperature unit: c or f' },
          language: { type: 'STRING', description: 'UI language code: en, it, ko, ja, zh, es, fr, de, pt, ru, or nl' },
          weather_mode: { type: 'STRING', description: 'Weather location mode: auto (geolocate) or manual' },
          weather_city: { type: 'STRING', description: 'City name: sets weather_mode to manual automatically' },
          lock_widgets: { type: 'OBJECT', description: 'Focus lock-screen widgets to show/hide', properties: {
            clock: { type: 'BOOLEAN' }, weather: { type: 'BOOLEAN' }, media: { type: 'BOOLEAN' }, calendar: { type: 'BOOLEAN' },
          } },
        } } },
        { name: 'set_creation_model', description: 'Sparks (Bit credits) only: change which model makes creations (widgets, themes, backgrounds, scenes, Decks) and how much it reasons before creating. Pass only what the user asked to change. Saved in Settings → Bit, and a creation asked in the same message already uses it. Use for "usa Opus", "use Sonnet", "ragiona di più", "think less", "fallo più curato". Per widget at the Normal level: Haiku about 3 Sparks, Sonnet about 50, Opus about 150; Thorough costs about twice Normal, Light stays close to Normal.', parameters: { type: 'OBJECT', properties: {
          model: { type: 'STRING', description: 'haiku (fast, simplest), sonnet (balanced) or opus (most accurate)' },
          effort: { type: 'STRING', description: 'low (Light: little reasoning, for simple requests), medium (Normal, recommended) or high (Thorough: more polished, about twice the credits and time)' },
        } } },
        { name: 'set_media_source', description: 'Choose which media app the Now Playing tile follows when several are playing: pass the app/source name (e.g. "Spotify", "YouTube") or "auto" to follow whatever is active. Use when the user says "show Spotify", "segui YouTube", "torna automatico".', parameters: { type: 'OBJECT', properties: {
          source: { type: 'STRING', description: 'Media source name (e.g. "Spotify", "YouTube") or "auto"' },
        }, required: ['source'] } },
        { name: 'list_audio_devices', description: 'List the available speaker/output and microphone/input devices (and which are current). Use before set_audio_device when you do not know the exact device names, or to answer "what speakers/mics do I have?".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_audio_device', description: 'Switch the default audio output (speaker) or input (microphone) device by name. If the name does not match, you get the list of available devices back, then ask the user which one. Use for "switch to my headphones", "usa le casse", "cambia microfono".', parameters: { type: 'OBJECT', properties: {
          kind: { type: 'STRING', description: 'Which device to switch: "speaker" (output) or "mic" (input)' },
          name: { type: 'STRING', description: 'The device name or a distinctive part of it, e.g. "Headphones", "Realtek", "USB microphone"' },
        }, required: ['kind', 'name'] } },
  ];
}

module.exports = { appearanceAiFunctions };
