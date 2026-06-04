# Changelog

All notable changes to XenonEdge Hub are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [v3.0.0] - 2026-06-01
### ✨ New Features
- **Celsius / Fahrenheit toggle**: a new **°C / °F** switch in **Settings → Meteo** changes the unit for every temperature in the app — the topbar weather pill, the full weather panel (current, "feels like", the hourly strip and the 3-day forecast) and the Focus lock screen. Your choice is saved and persists across reloads and restarts. It's display-only (no re-fetch), so switching is instant.
- **Duplicate a widget (System + Playback)**: in Layout mode the **"+"** adds another copy of a component instead of moving the original — so a component can live on several pages at once and **adding never removes it from elsewhere**. Every copy is a live mirror of the same source, so they update together (e.g. two System tiles both track CPU/GPU/RAM/Disk; two Playback tiles both follow the current track and controls). Each copy has its own **×** to remove just that copy — removal is always manual. Duplicable now: **every dashboard module** — System, Playback, Microphone, Volume, Calendar, Tasks, Timer, Notes, Lighting **and the Xenon AI Chat** (edit one copy — e.g. tick a task, type a note, send a message — and every copy updates). The Chat is a single shared AI session shown in every copy: each copy mirrors the same conversation and has its own text box that sends to that one session, while voice, screen-capture and attachments stay on the original tile. *(One-time: saved layouts migrate cleanly; no copies until you add them.)*
- **Group widgets into tabs**: in Layout mode drag a tile (by its left-edge grip) and drop it **onto the centre of another** — the target highlights to confirm — to merge them into a single **tabbed** tile (e.g. Calendar + Music); drag a tab's ⤤ out to split it again, or add Playback/Chat from the "+" palette to pull them out individually. Dropping on empty space (or a tile's edge) just repositions. Playback and the Xenon-AI Chat are now separate widgets — the default dashboard still shows them together as a tab-group, exactly like before. *(One-time: layouts reset to the welcome default on upgrade.)*
- **Drag-and-drop layout editor**: Layout mode is now direct — **drag** a tile by its **grip on the left edge** to reposition it, and **resize** from the **corner chip** at the bottom-right (snapped to a clean grid); no more arrow/size buttons. The dedicated grip means a tile's content no longer "eats" the drag, and the move and resize handles can't be confused for one another. Each tile keeps just **hide** (👁) and **move to another page** (⇄). A **"+" drop-zone** fills the free area of every page (iCUE-style) and opens a palette to add any available widget — including **Playback** and **Chat** (adding one pulls it out of the default group) — so it shows up whenever a page still has room, not just when it's empty. Added widgets land in that free space on **the page you're looking at** (a bug that scattered them onto other pages is fixed). The editor toolbar is now minimal (reset · done), sits above the grid and never covers your widgets or their controls. Built on GridStack. *(One-time: existing custom arrangements reset to a clean default on upgrade.)*
- **Custom dashboard pages**: in Layout mode you can now **add and remove** dashboard pages (up to 8) straight from the **page dots** in the top bar — a **"+"** adds a new blank page, and a red **"×"** removes the current one (disabled when it's the only page; asks for confirmation if it still holds modules, which then move to the hidden list). Pages are unnamed for a cleaner look. Place any module on any page; your pages and arrangement persist, and Reset restores the two defaults.
- **Arrange modules across pages**: in Layout mode each tile now has a **"move to other page"** button, so you can place any module on any dashboard page. A page with no modules is hidden from the pager until you send something to it (it stays reachable while you're editing). Your arrangement persists, and Reset restores the defaults.
- **Multi-page dashboard**: the dashboard is now a horizontal pager. Swipe, scroll sideways, drag, use the arrow keys, or tap the page dots in the top bar to move between pages. Page 1 is your dashboard, and you can add your own pages and arrange any modules across them. The pager is built to be extensible, so more pages can be added in the future. It is compositor-driven (CSS scroll-snap), so paging stays smooth and cheap even under load.
- **Lighting lives entirely in Settings → Illuminazione**: every RGB control is in one place — master on/off, brightness, manual colour, ambient animation, reactive effects, event flashes, iCUE devices and external systems — so the main dashboard stays clean (there is no separate Lighting page). **Timer, notifications and reminders** can each flash the lights with a chosen colour (default red) and style — **blink**, **pulse** (breathing) or **solid**. Xenon AI can set these by voice. Fixes: the manual colour now always applies, and the timer flash resets cleanly afterwards.
- **RGB lighting bridge (Corsair / iCUE)**: the dashboard can now drive your Corsair devices from real data, all from **Settings → Illuminazione**. CPU temperature paints a cool→warm gradient, an expiring timer pulses red, and changing the volume gives a brief accent flash — plus a manual colour picker for a fixed colour. It **coexists with iCUE**: it shares control and hands it straight back when you turn the bridge off (or per device). To stay out of the way during heavy load it **idles while you game** (toggleable), so it costs nothing when it matters most. Every effect, the per-game pause, the brightness, and each individual device are separately toggleable, and the whole bridge is **off by default** — existing setups are unaffected until you opt in. **Xenon AI** can control it by voice too: "turn the lights red", "enable the temperature effect", "switch the lighting off", "what's the CPU temperature?". Requires iCUE running with the **SDK enabled** (Settings → enable SDK); without it Settings shows a friendly notice and everything else keeps working.
- **Real in-game FPS (PresentMon)**: the FPS counter can now show the actual frame rate of the running game — including **exclusive-fullscreen** titles, which the previous DWM/LibreHardwareMonitor methods couldn't read (they only worked windowed/borderless, hence the frequent `N/D`). PresentMon is now **downloaded automatically by the one-click installer** (`INSTALL.bat`) into `server/presentmon/` and removed by `UNINSTALL.bat` — no manual setup. The server streams its ETW present data in the background and reports the busiest game's FPS (the elevated startup task provides the rights PresentMon needs). It degrades gracefully to the old DWM reading if PresentMon couldn't be downloaded.
- **Per-app Audio Mixer (speaker)**: a compact App Mixer section now appears directly below the master volume slider whenever any application is producing audio. Each active app (Spotify, Discord, Chrome/YouTube, iCUE, etc.) gets its own row showing the real app icon extracted from its executable, a name resolved to a friendly label (same logic as the App Switcher), a horizontal volume slider, a percentage readout, and an individual mute toggle. Slide any row to change only that app's volume independently of the master. The section hides automatically when no apps are producing audio, so the panel stays clean.
- **Per-app Mic Mixer**: the same concept is applied to the microphone panel. When an application is actively capturing audio (e.g. Discord in a voice channel, Teams, OBS), a dedicated section appears below the master sensitivity controls, with per-app volume and mute. The section is invisible when no app is using the mic — typical during normal use — and appears the moment a voice call starts.
- **App icons in the mixer**: icons are extracted directly from the running executable via `Icon.ExtractAssociatedIcon`, the same method used by the App Switcher. Results are cached in memory so extraction only happens once per app session. Apps without a resolvable icon fall back to an accented initial-letter badge.
- **Accent colour from album art**: while music is playing, the dashboard now tints its accent colour to match the cover of the current track — a vibrant colour pulled from the artwork, smoothly cross-faded. The colour is chosen by how prominent it actually is in the cover (keeping the hue faithful to the artwork rather than amplifying stray pixels), and near-greyscale covers deliberately fall back to your theme instead of inventing a colour. When playback stops, or the cover is missing/greyscale, it restores your chosen theme accent. It's on by default and can be turned off under **Settings → Aspetto → Accent from album art**; your saved accent is never overwritten, so toggling it off (or stopping the music) brings your colour straight back. Works with both inline and remote (e.g. Apple) cover art, runs entirely on-device with no extra dependencies, and is available in all five languages.
- **Album colour on your RGB lighting**: the same now-playing cover colour can drive your Corsair LEDs, so the room glows to match the music. This effect is **independent of the main RGB bridge toggle** — switch on **Settings → Illuminazione → Album → colore LED** (or the quick toggle on the Lighting page) and it lights up on its own while music plays, then hands the LEDs straight back to iCUE when playback stops. It's **off by default** (opt-in, so it never seizes your lighting unasked). When the full bridge *is* on, the album colour sits above the CPU-temperature base but yields to transient flashes (volume, timer, reminders) and to a manual colour.
- **Ambient lighting animations**: a new **Animation** selector on the Lighting page adds decorative motion on top of the reactive effects — **Solid** (a fixed colour), **Breathing** (a smooth fade in/out) and **Rainbow** (a full-spectrum colour cycle) — each with a **speed** control, and a **colour** picker for Solid/Breathing. Animations play in sync across **all** your lights (iCUE *and* external), pause automatically while you game, and cost nothing when set to **None**: the render loop only runs while a moving animation is actually painting, so there's no idle overhead.
- **Performance Mode (opt-in, transparent, reversible)**: a new profile under **Settings → Performance** that optimizes your setup on demand. It **notices what you're doing** — playing a game, coding, or writing — and can show a small **banner** offering to optimize for that activity (you choose which activities trigger it; games only by default, so it never nags during normal work). You decide **which apps count** for each activity too: every activity has an editable list you can **add your own apps to or trim** (defaults included), so the suggestion fires exactly when you want. You can trigger it any time with **Optimize now** in Settings or the new **Optimize performance** button right on the System tile. Before anything happens, a **confirmation sheet** opens where **you tick exactly what to apply** — pause animations, power plan, a gentle **priority boost for the app you're actually using** (e.g. the running game), and which background apps to close — all clearly labelled by risk; nothing runs until you confirm. What it does today: **pauses the dashboard's animations and animated backgrounds** (zero-risk, instant), switches Windows to a **high-performance power plan**, **nudges up the priority** of the detected active app (a safe AboveNormal, never the system-starving levels), and — when you opt in — offers to **close background apps you pick** to free up resources. It's **fully reversible**: it remembers your previous power plan, the boosted process, the closed apps' executables, and restores everything (power plan, priority, animations, and reopening the apps) when you hit **Restore** or end the session, even after a restart. **App closing is graceful** (the app can still prompt to save — nothing is force-killed), **never automatic**, and **critical Windows processes are always refused**. It's **off by default** and runs nothing without your explicit confirmation. A dedicated toggle lets you **use Xenon AI to drive the decisions** when it's configured, or keep them **deterministic** by turning AI off just for this mode — so Performance Mode works fully with or without AI. When AI is on, it **reads what you're doing** (gaming / coding / writing) and the apps you have open, then **pre-selects exactly which background apps are worth closing** and writes a one-line explanation at the top of the sheet — you still confirm before anything happens, and it only ever picks from apps that are actually open. With AI off, nothing is pre-selected and you choose entirely by hand. You can also just **ask Xenon AI** by voice or chat — "optimize performance" / "restore performance" — and it opens the same confirmation sheet (or undoes it). Works with both the Gemini and local (Ollama) providers.
- **Game mode (auto-pause ambient effects)**: the dashboard now detects when a real game is running full-screen and automatically **pauses the animated background** — the Aurora, the neon grid and the spinning glow of the Xenon AI button all freeze and fade out — so the widget stops competing with the game for the GPU. Everything resumes the moment you exit the game. Detection now keys on the **foreground full-screen window** (a game owns the foreground and covers its whole monitor with no title bar), which is far more reliable than the previous frame-rate-based approach: maximized desktop apps (they keep their title bar and leave the taskbar visible), the dashboard's own browser/WebView host, iCUE/Corsair and other apps that render continuously are all correctly excluded — so game mode no longer switches on by itself when no game is running. It needs no extra tools or administrator rights. A new toggle in **Settings → Performance → Game mode** turns this on or off (on by default). PresentMon remains an **optional** one-tap install, used only to show the real in-game FPS in the system panel — game mode itself works without it.

- **Local AI provider (groundwork)**: settings foundations for choosing between Gemini (cloud) and a free local AI backend (Ollama). No user-visible behaviour changes in this step — it adds and validates the new `aiProvider`, `ollamaModel`, `ollamaUrl`, and `hardwareScan` settings on both the server and the client so future steps can wire up the local provider.
- **Local AI provider backend**: new server module `ai-local.js` (Ollama for chat and function calling, Whisper.cpp for speech-to-text, Edge neural voices for text-to-speech), a hardware scanner that recommends a suitable model for your PC, and the endpoints `/api/ai-local/scan`, `/api/ai-local/status`, and `/api/ai-local/pull`. Chat, voice, and transcription now switch transparently between Gemini and the local provider based on your selection — Gemini stays the default.
- **Settings → Xenon AI provider selector**: a new control in Settings lets you switch Xenon AI between **Gemini (cloud)** and the free **Local (Ollama)** provider. Choosing local reveals a hardware-compatibility panel that scans your PC (RAM, VRAM, CPU cores) and **blocks the option on machines that aren't powerful enough**, automatically restoring Gemini. You can pick the model (Auto / Light / Balanced / Powerful / Custom), check the live status of Ollama, Whisper and the Edge voice, and download a model directly from Settings with a progress bar. Available in all five languages.
- **Ollama: detect-if-installed, one-tap start, and autostart**: the local-AI panel now distinguishes between Ollama being **installed but not running** (amber status with a **Start** button that launches it for you) and **not installed at all** (red). A new **"Start Ollama at Windows startup"** checkbox keeps the local AI ready after every reboot. The model dropdown now shows the exact model behind each tier (e.g. *Balanced — qwen2.5:7b*), and the local-provider settings panel was widened to use the full settings width so controls no longer crowd the column.
- **Local AI model picker now knows what's installed**: the local-AI panel scans the models already present in Ollama, so the **Custom** field autocompletes from your installed models instead of blind free-text, and a small note shows whether the selected model is already downloaded.
- **Free web search for the local AI (DuckDuckGo)**: the local (Ollama) provider can now search the internet **without any API key**. Previously the assistant's `web_search` tool always went through Gemini, so in local mode it silently depended on a Gemini key and returned English results. The local provider now searches via **DuckDuckGo** (Instant Answers + organic results) — fully key-free and offline-friendly — and replies in your language. The Gemini (cloud) provider keeps its richer grounded search unchanged.
- **Local AI set up on demand (faster installer)**: the one-click installer **no longer downloads Ollama or Whisper.cpp**, so first-time setup stays fast for everyone. The local-AI components are now set up only when you actually switch Xenon AI to the **Local (Ollama)** provider in Settings → Xenon AI. From that panel, **Whisper** (speech-to-text engine + its voice model) downloads in-app with a live progress bar via the new "Download Whisper" button, and a new "Install Ollama" button opens the official Ollama installer page when Ollama isn't found. The chat model itself is still downloaded from the same panel with a progress bar. Nothing is fetched up front — you only download what you choose to use.
- **Deck widget (foundation)**: a new programmable key-grid widget you can add to any dashboard page and duplicate like the others. This first release renders the grid with nested folders and swipeable pages; configuring key actions arrives in the next update.
- **Deck widget — build your own keys**: the Deck now has an edit mode (✎ in its title bar) where you can add keys, give each a title, an emoji or image icon and an accent colour, turn a key into a folder, add and remove pages, and assign a typed action (open an app, file or URL, media controls, mic and volume mute). Your layout is saved locally and each duplicated Deck keeps its own keys. (Keys start running their actions in the next update.)
- **Deck keys now run**: tapping a Deck key triggers its action — open an app, file or website, control playback, or mute the mic and volume. Every action runs through a single allowlisted dispatcher on the local server (no arbitrary commands), and the key flashes briefly while it fires. If an action fails (e.g. a file path that doesn't exist, or OBS not connected) the key now **flashes red** so the failure isn't silent.
- **Deck keys can show live state**: bind a key to "mic muted" or "speaker muted" (in the key editor) and it lights up with an accent ring whenever that state is active — so a mic-mute key visibly shows whether you're muted, updating the instant it changes.
- **Deck keys do more per key (Key Logic)**: a single key can now trigger up to three different actions — one for a single tap, one for a double tap, and one for press-and-hold — chosen separately in the key editor. (Building multi-step action sequences arrives in the next update.)
- **Deck keys can run a sequence (Multi-Action)**: a trigger (tap / double / hold) can now run several actions in order — add as many as you like in the key editor, set a delay before each, and reorder them. For example one key can mute the mic, wait, then open an app.
- **Deck → OBS control**: a Deck key can now drive OBS Studio over its WebSocket — switch scene, start/stop recording, start/stop streaming, and mute/unmute a source. Enable it in Settings → OBS (host, port, password from OBS → Tools → WebSocket Server). The connection opens only when a key fires and closes itself when idle.
- **Deck → OBS, easier setup**: when you choose the *OBS: scene* action the scene is now picked from a **dropdown of your live OBS scenes** (no need to type the exact name), and the OBS actions are **hidden from the action list until you've configured OBS** in Settings. (Falls back to a text field if OBS isn't running.)
- **Deck → OBS live indicators**: OBS keys now light up to show what's happening — a recording key glows green while recording, a streaming key glows red while live, a mic-mute key shows when that OBS source is muted, and a scene key highlights when its scene is on air. It updates instantly while the dashboard is open (no setup — it's inferred from the key's action), and the live OBS connection is held only while the dashboard is open and reconnects on its own if OBS restarts.
- **Deck → Xenon AI key**: a Deck key can now invoke Xenon AI on tap — send a prompt you've written (the question and Xenon's written answer appear in the Chat tab of the Media tile, and the prompt can even drive the dashboard), start a voice session, or just open the chat. Pick the mode in the key editor; it also works as a step inside a multi-action key.
- **Deck → LED reactions**: any Deck key can now also drive your RGB lighting. Pick a colour (and optionally an effect — solid, breathing or cycle) in the key editor, and choose whether it's a one-shot on tap or *follows the key's state* — so a mic-mute key can turn the LEDs red while you're muted, or a record key can pulse red while recording, clearing on its own when it ends. For toggle keys (OBS record/stream, mic/speaker mute, OBS scene) the reaction now **defaults to "follows state"**, so the second press turns the lights back off automatically without you having to set anything. (Works while the dashboard is open and requires the Lighting feature enabled.)
- **Deck → OBS scene preview**: the Deck now shows a small live thumbnail of the OBS scene that's on air, painted onto your scene key (or, if you don't have one, your recording or streaming key). It refreshes every few seconds and updates instantly when you switch scenes — so you can see what's going out at a glance. (Works while the dashboard is open with OBS connected.)
- **Deck → launch OBS automatically**: tap an OBS key (record, stream, switch scene, mute…) while OBS is closed and the dashboard now **opens OBS for you** and runs the action as soon as it's ready — a brief "Avvio OBS…" toast shows the progress. Turn it off in Settings → OBS ("Avvia OBS se è chiuso"). (OBS still needs its WebSocket server enabled.)
- **Deck — real Stream Deck look & feel**: the Deck has been completely restyled to look and behave like a physical Stream Deck — a matte device chassis with a faceplate header and a recessed key "screen". Keys are glossy LCD caps that **press in** when you tap them, **lift and brighten** on hover, and **light up and breathe** when active (a coloured key glows in its accent, a recording key pulses green, a live one red). Even edit mode feels alive: keys gently jiggle and empty "+" slots pulse so it's obvious you're arranging them.
- **Deck — choose your key size, and it fits itself to the tile**: a new edit-mode toolbar lets you pick **Small / Medium / Large** keys, and by default the Deck **auto-fits** — as you resize the widget it shows exactly as many keys as comfortably fit at that size (more, smaller keys, or fewer, larger ones). Prefer to set it by hand? Turn **Auto** off and dial the exact columns and rows with the steppers. Your keys are never lost when the grid changes.
- **Deck — built-in music screen**: turn on **Musica** in the Deck's edit toolbar to dock a now-playing **LCD-style screen** under the keys — album art with title, artist and previous / play-pause / next controls, the screen tinted by the cover's own colours (the same transport used in the AI chat). It stays in sync with playback and **hides itself completely when nothing is playing**, so the panel never sits there empty.
- **Deck — profiles**: the Deck now supports **multiple profiles**, each with its own keys, folders and pages — keep one for streaming, one for work, one for gaming. Tap the profile name in the faceplate header to open a switcher and jump between them instantly. Enter edit mode (✎) to **create a new profile**, **rename** any profile inline, or **delete** one you no longer need (the last profile is always kept). Each duplicated Deck keeps its own set of profiles, saved locally.
- **Deck profiles by voice or chat (Xenon AI)**: you can now ask **Xenon AI** to change Deck profile — just say or type *"switch to my streaming profile"* (or *"passa al profilo gaming"*). Xenon knows your profiles by name, switches the Deck instantly, and shows a brief confirmation on screen.
- **Consistent dropdowns, scrollbars and checkboxes everywhere**: form controls now share one cohesive look across the whole app. Dropdowns use the same styled menu (with the accent dot on the selected entry) in Settings, the Deck editor and everywhere else — the Deck editor's pickers were switched from the raw OS dropdown (which renders blank on the Xeneon Edge) to this custom menu, which floats above the dialog instead of being clipped by it. Scrollbars are slim and rounded with an accent-tinted thumb on hover, and checkboxes are custom accent-filled boxes with a tick — all matching in both dark and light themes.
- **Deck — roomier, tidier key editor**: the "Edit key" dialog is now wider with more breathing room between sections, and its dropdowns and scrollbar match the rest of the app, so configuring a key feels less cramped.
- **Deck — a proper icon picker for keys**: the key editor now offers three ways to dress a key. **Emoji** is now a large, scrollable palette organised by category (media, system, communication, symbols, colours and more) instead of a short fixed row. A new **Icone** tab adds a built-in library of crisp **vector icons** — play/pause, mic, volume, settings, lock, arrows, and dozens more — that automatically take on the key's colour, so they look sharp at any size and consistent across devices (unlike emoji, which vary per platform). **Immagine** still lets you upload your own picture.
- **External calendars (Outlook & Google/Gmail)**: the dashboard calendar can now show the events from your real Outlook and Google calendars alongside your local ones. Add them in **Settings → Calendari esterni** by pasting each calendar's **iCal (`.ics`) link** — the panel gives step-by-step instructions for finding it in Google (*Impostazioni → Integra calendario → Indirizzo segreto in formato iCal*) and Outlook (*Impostazioni → Calendario → Calendari condivisi → Pubblica*). Each feed gets its own colour (shown as a dot on its events), an on/off switch, and an optional reminder toggle; the dashboard refreshes them automatically every 15 minutes. **Limits, by design** (also explained in the panel): external events are **read-only** — you can see them but can't create, edit or delete them from the widget; Google's secret link can take **hours** to reflect changes (that delay is on Google's side); reminders can arrive **twice** if your phone/PC already notifies you (so you can switch them off per feed); the secret link is stored **only on your PC** and grants read access to your calendar, so keep it private; and a few unusual recurring events may not display perfectly. Works with any calendar that publishes an `.ics` link (iCloud, etc.), needs no account or sign-in, and runs entirely on-device.

- **Remote PC control from your phone (opt-in)**: a new **Settings → Controllo Remoto** tab lets you turn your phone into a full remote control of the PC — see the screen and use mouse and keyboard — **even when you're away from home**. It's built as a *command centre*: the dashboard installs and configures the heavy lifting for you (the free, open-source **Sunshine** streaming host and **Tailscale** for secure access, both via Windows' own **winget** from official sources), then walks you through a guided setup — install, sign in to your Tailscale account, configure Sunshine, and pair your phone with a PIN — all from the touchscreen. On the phone you just use the free **Moonlight** app. **Nothing is installed unless you ask**: the feature does nothing until you open the tab, read what it does, and choose to configure it. Crucially, **the dashboard's local server is never exposed to the internet** — your phone talks directly to Sunshine over your private, encrypted Tailscale network, so there are no open ports and the remote-control traffic never passes through the dashboard or any cloud. A one-tap **kill-switch** disconnects any paired device instantly, and you can disable the whole feature at any time. *(Requires a free Tailscale account and one Windows UAC confirmation during setup.)*
- **Remote control panel**: once remote access is configured, **Settings → Controllo Remoto** now shows a live control panel instead of asking you to reconfigure. From it you can **choose which monitor is streamed** to Moonlight (if you have more than one display), **disconnect an active session** with one tap, and **block or reactivate remote access** without tearing down the whole setup. The kill-switch and "reconfigure credentials" buttons are also available there.
- **Remote Control dashboard widget**: the remote control panel is now also available as a tile you can **add to any dashboard page** — just like any other widget — and duplicate across pages for quick access. When remote access is not yet configured, the tile shows a friendly prompt pointing you to Settings. The widget and the Settings panel show the same live state.
- **Deck → Remote Control keys**: three new Deck actions let you control your remote session from a programmable key: **Disconnect remote session** (ends any active Moonlight connection immediately), **Block/reactivate remote access** (toggles access without touching the setup), and **Cycle streamed monitor** (steps through your monitors to change which screen Moonlight shows). A **connected-state** key lights up with an accent ring whenever a device is actively connected — so a glance at the Deck tells you if someone is in. All three actions appear in the key editor only when remote access is configured.

### 🐛 Bug Fixes
- **Deck — the profile menu now actually appears**: tapping the profile name showed the open state (the arrow flipped) but no menu, because the deck tile clips its overflow and was cutting the popover off. The profile menu is now drawn on top of everything (anchored under the name, flipping above when there's no room below), so you can pick another profile reliably.
- **Deck editor — long dropdowns no longer get cut off**: the Action picker (and other long lists) ran past the bottom of the screen with no way to reach the last entries (e.g. the OBS actions). Dropdowns now cap their height to the available space and **scroll**, and open upward when there's more room above.
- **Deck — missing labels in the "remote access" mode menu**: the Block / Unblock options showed their raw keys (`deck_opt_block`, `deck_opt_unblock`) instead of translated text. They're now translated in all five languages.
- **Notes are readable in the light theme**: with the light appearance the Appunti (Notes) scratchpad stayed a dark box with dark text, making it almost impossible to read. The notepad's dark gradient background wasn't being cleared in light mode (only its colour was, leaving dark-on-dark); it now switches to a clean white field with dark text like the other inputs.
- **Deck — the profile switcher opens reliably**: tapping the profile name in the Deck's header didn't open the profile menu on touch. The "tap outside to close" listener was being armed during the very tap that opened the menu, so that tap immediately closed it again. The listener now arms on the next frame, so the menu opens and stays open. (To create more profiles, enter the Deck's edit mode ✎ and use "＋ Nuovo profilo".)
- **Deck — all key rows stay visible when you open edit mode**: tapping the Deck's edit pencil could sometimes collapse a full grid (e.g. three rows of keys) down to a single row. Entering edit mode adds the size toolbar and the page footer, which briefly shrinks the key area; a leftover auto-fit measurement, queued a moment earlier, then ran against that shrunken area and re-packed the grid into one row — and saved it. Auto-fit is now cancelled cleanly when you enter edit mode (or the dashboard Layout editor), so your grid keeps all its rows.
- **Deck — uploaded key images now show up**: choosing your own picture as a key icon left the key blank (a broken-image placeholder). The image was being truncated to 256 characters when the Deck's config was saved, which corrupted the stored picture. Uploaded images are now kept intact (and automatically shrunk to a small, crisp icon so they stay well within the browser's storage limits), so a custom image appears on the key as expected.
- **Deck — added at a usable size, and it grows when you resize it**: adding the Deck to a page could drop it in as a thin sliver, and dragging the corner to enlarge it didn't seem to take. The Deck was trying to re-fit its key grid to the tile *while you were still resizing it* — measuring a tile that hadn't settled yet and fighting the drag. It now holds its layout steady while you arrange and resize in Layout mode, then fits the keys neatly to the final size once you're done, so it lands at a sensible size and enlarges smoothly.
- **You can now hide the Deck in Layout mode**: in Layout mode every widget shows a small hide / move-to-page overlay in its top-right corner — but the Deck's was missing, so it was the one module you couldn't remove from a page. The Deck redraws its own contents (when it auto-fits to the tile or the music changes) and that redraw was wiping the overlay the instant it appeared. The Deck now preserves the layout controls across its redraws, so you can hide it or move it to another page like any other widget.
- **Settings no longer floods the server with requests**: opening **Settings → Illuminazione** could send a non-stop stream of background requests (lighting/gamemode/AI-status checks repeating hundreds of times a second), wasting CPU and network. The lighting panel re-applied translations across the *whole* app after each render, which — with Settings open — re-rendered the Settings modal, which re-rendered the lighting panel, looping forever. The lighting panel now localises only its own controls, so opening Settings makes each status check exactly once.
- **Dashboard no longer freezes when using RGB lighting**: turning the RGB lighting bridge on or off — or leaving it on while music played and skipping between tracks — could freeze the whole dashboard: the track stopped updating, the playback buttons stopped responding, and even the lights froze, until the server was restarted. The cause was the iCUE bridge calling the Corsair SDK **synchronously from inside the SDK's own connection callback**, which could deadlock with the iCUE service and stall the entire server. The bridge now runs every SDK call off the main thread with a hard timeout, and never calls back into the SDK from within that callback, so a busy or unresponsive iCUE service degrades the lighting to a harmless no-op instead of locking up the dashboard.
- **Volume mixer now matches Windows exactly**: the per-app volume list showed sessions that the Windows 11 Volume Mixer hides — background apps holding an idle audio session (e.g. *RtkUWP*, *Explorer*) appeared as extra rows. The mixer now lists only sessions Windows itself considers **active**, so what you see in the dashboard matches the Windows mixer one-to-one.
- **Dashboard tiles now fill the screen height**: on the Xeneon Edge (and any short window) the grid tiles stopped short of the bottom, leaving an empty band and clipping tall panels. The grid now sizes its rows to the real available height, so the three columns reach the bottom edge as intended.
- **System panel fits without scrolling**: the merged *Sistema* view (CPU/GPU/RAM/Disk + Rete & Gaming) was taller than the tile on the Xeneon Edge's short screen, cutting off the bottom cards. The cards now compress to share the available height (the sparkline shrinks first), so everything stays visible — and still fills tall desktop windows.
- **Media/Chat tab stays where you put it**: when music was playing the tab-group kept snapping back to *Riproduzione* (and to *Chat* when idle), so tapping a tab seemed to "open and close". Choosing a tab now permanently turns off the playback-driven auto-switch (saved with your layout), so your choice sticks.
- **Deck → Xenon AI key now opens the chat correctly**: the AI key's *Send prompt* and *Open chat* modes opened the voice overlay, which in this release holds only the voice orb — so it showed as an **empty black panel**, while the question and answer were actually posted to the Chat tab hidden behind it. Both modes now reveal the **Chat tab in the Media tile** (adding it to the current page if it was hidden) and show the question and Xenon's written answer there. The *Voice session* mode is unchanged.
- **Deck → AI voice key opened and closed instantly (every other tap)**: a Deck key set to *Voice session* opened the full-screen voice orb and then closed it again on the very same tap — so it seemed to work only every other press and otherwise just flicked back to the dashboard. Deck keys fire on finger-up, and the trailing click the browser sends afterwards landed on the just-opened voice screen (whose tap = "stop"), dismissing it instantly. The voice screen now ignores that opening tap for a short grace window, so a Deck voice key opens the assistant reliably on every press. (The top-bar ✦ button was never affected.)
- **Now playing returns to the Chat tab**: while music plays, the Chat tab again shows the mini player (cover, title, prev/play-pause/next) with the album art as a soft blurred backdrop — restored after Playback and Chat became separate widgets.
- **Tab-group tabs match the rest of the UI**: the *Riproduzione/Chat* tabs now use the same pill style and icons as the Agenda/System tab bars.
- **Settings stopped loading after restart**: the dashboard could come up with no saved settings applied (default theme, empty Settings, broken layout). A newly added lighting helper read a constant (`LIGHTING_STYLES`) before it was declared, throwing at startup the moment settings were normalized — which aborted the whole settings module and left `hubSettings` undefined for every panel. The constant is now declared before settings hydrate, so your saved theme, colours, layout and all other preferences load correctly again on every launch.
- **Ollama reported "not found" while running**: the local-AI status/health checks now force IPv4 when contacting Ollama. On Windows, Node resolves `localhost` to the IPv6 address `::1` first, but Ollama listens only on IPv4 `127.0.0.1`, so the connection was refused and Ollama showed as "not found" even when it was installed and running. All three Ollama calls (status check, chat, model download) now connect over IPv4.
- **Gemini API key hidden for the local provider**: selecting **Local (Ollama)** now hides the Gemini API Key field, since it isn't used by the local provider; switching back to **Gemini (cloud)** shows it again.
- **Local voice now works without a Gemini key**: when Xenon AI is set to the free Local (Ollama) provider, voice input (speech-to-text) no longer requires a Gemini API key. Both voice paths — the browser microphone and the server-side recorder — now transcribe locally with Whisper.cpp, so you can talk to Xenon entirely offline. The Gemini cloud path is unchanged and still uses your key.
- **Local AI "model not found" with Auto selected**: with the model set to **Auto**, the "Download model" button pulled a fixed lightweight model while the chat actually requested the model recommended for your hardware — so on a capable PC the download finished instantly (a model you already had) but every message failed with `model '…' not found`. The download button now resolves **Auto** exactly like the chat does (using your hardware scan), so it downloads the same model the chat will use.
- **Local AI replying in English**: with the local (Ollama) provider, questions that triggered a web search (e.g. "what's the weather tomorrow") could come back in English, because the search results were in English and smaller local models tended to copy them verbatim. The local system prompt now enforces translating tool/search output into your language, so Xenon answers in Italian (or your selected language) again.
- **Local AI model status clearer**: when the selected model is already installed, the local-AI panel now hides the "Download model" button and shows **"In use: &lt;model&gt; ✓"** instead, so it's obvious which model Xenon is running; the download button reappears only when the selected model is missing.
- **Local voice was silent in voice mode**: with the free Local (Ollama) provider, Xenon replied in text but you couldn't hear the spoken voice. The local text-to-speech wrote its audio through a streaming pipe, which left the WAV file's size headers blank — and the Windows audio player needs those to know how much to play, so it played nothing. The audio is now written so the headers are always correct, and the local voice is audible again. (Gemini voice was never affected.)
- **Game mode stuck on with no game running**: game mode used to detect games purely from GPU frame rates (PresentMon), so any app that renders continuously kept it permanently on and stripped every ambient effect. On Corsair hardware the culprit was **iCUE** (it drives the Xeneon Edge and RGB previews at the display refresh rate); on a dev machine it was **VS Code** at 240 fps. Detection was rebuilt around the foreground full-screen window instead, which only matches an actual full-screen game — so game mode no longer activates on its own.
- Fixed a startup bug where the "AI unavailable — insert your API key" message appeared in the Chat tab even when the Gemini API key was already configured. This happened when the browser session started before the local server was fully ready, causing the key to be temporarily missing; after the server responded, the chat UI was not refreshed. The chat now correctly re-syncs its state once the server settings are loaded.
- Fixed mixer slider not changing the volume of an app when the session CLI identifier contained backslashes (e.g. `SRS-XB100\Application\Spotify`). The previous inline `oninput` handler was broken by quote escaping; replaced with event delegation reading `data-app-id` directly from the DOM.
- Apps that pause audio (Spotify paused, Chrome tab muted by browser) no longer disappear from the mixer. The filter now includes `Inactive` sessions and only excludes `Expired` ones, matching the behaviour of the Windows Volume Mixer.
- System pseudo-sessions ("Sistema operativo", "System Sounds") are excluded from the mixer list by filtering on the exe process path — sessions without a real process path are skipped at the source.
- App names sourced from poor session metadata (e.g. "Qt6" for iCUE) are resolved to their friendly name via the exe basename and the existing `prettyAppName` helper, so every row shows a recognisable label.
- SSE refresh no longer interrupts an in-progress slider drag: the mixer render is skipped for 1.5 s after any interaction so the gesture completes cleanly.

### 🎨 Interface Redesign
- Full redesign of the dashboard toward a minimal, Apple-inspired "Liquid Glass" look with a modular Bento layout. The visual foundations: the Inter typeface across the interface, a unified set of base controls, shared "liquid glass" and deep-OLED surface materials, tabular figures so data numbers no longer shift width, and a refreshed colour/spacing system. No features change in this step — the groundwork prepares the redesign of every screen (dashboard, lock screen, weather, settings and all components) in the next steps.
- Glass topbar and softer panels: the top bar is now a floating "liquid glass" surface, and all panels use gentler rounded corners with a consistent shadow.
- Bento dashboard layout: the dashboard is now a modular 4-column grid. **Audio** (volume + output/input devices) and **Agenda** (calendar, tasks, timers) are now their own independent tiles — you can move, resize, hide, or install each on its own — instead of being tucked inside the System and Media panels. Each data tile carries a small colour accent for quicker recognition, and the layout reflows into a single stacked column when the display is mounted vertically (portrait). On upgrade the dashboard automatically adopts the new layout (your other settings — theme, weather, API key — are preserved). The System tile now shows the essentials (load %, temperature, capacity) and hides verbose model/module names to stay tidy; the full names remain in the standalone System view.
- Tabbed hubs (minimal default): the dashboard now defaults to three tidy tiles, each with tabs. **Agenda** = Calendar · Timer · Tasks · Notes. **System** = System (CPU/GPU/RAM/Disk + Network & Gaming together) · Volume · Microphone. Every tab can still be pulled out into its own tile from the Customize editor, and all tab bars share one consistent look.
- **Media hub with built-in Xenon AI chat**: the Media tile now has two tabs, **Playback** and **Chat**. When nothing is playing it opens on the Chat so the tile is never empty; while music plays it shows the now-playing, and on the Chat tab a mini player (cover, title, prev/play/next) appears with the album art blurred behind the conversation. The ✦ button opens the chat; the voice orb stays for voice. Without an API key the Chat shows a clear "AI unavailable — add your API key" message (all languages) with an option to hide the chat entirely; the choice is saved.
- Settings redesigned with a category sidebar: Appearance · Lock screen · Weather · Xenon AI · Background. One category at a time keeps the panel calm and easy to scan; it collapses to a row of tabs on narrow/portrait screens.
- **Fully modular dashboard items**: every content piece can now be pulled out into its own resizable, movable tile — **Calendar** and **Timer** join the items that were already extractable (Notes, Tasks, Volume, Microphone). The Customize editor was cleaned up: the old, stale tab controls (a "Network & Gaming" tab that no longer exists, and the calendar/tasks tab reordering) are gone; instead every hidden item appears as a single "add" chip, and any visible tile can be moved, resized or hidden. When a hub (Agenda or System) has only one item left inside, its tab bar hides automatically. Also fixed the Volume tile showing an untranslated label in the editor, and a glitch where entering edit mode could show two stacked control bars on a hub (Agenda/System).
- **Ambient background effects**: two new optional, GPU-light ambient layers, configurable in Settings → Appearance. **Animated background (Aurora)** paints soft flowing accent-coloured gradients behind the dashboard — shown only when you haven't set a custom image/video background — with intensity and speed sliders. **Grid** draws a neon perspective grid that scrolls toward a glowing horizon (synthwave/Tron style), with adjustable colour, intensity and speed. Each can be toggled on/off independently; both stop animating automatically when the system "reduce motion" accessibility setting is on. Enabled by default with subtle values; turn either off if you prefer a flat background.
- **Light / Dark / Auto theme**: a new Theme control in Settings → Appearance lets you choose a true **light** theme, the classic **dark** theme, or **Auto** (follows your operating system's light/dark setting and switches live when the OS does). The chosen accent colour applies to both schemes. Dark remains the default, so nothing changes on upgrade until you pick a theme. The light theme now covers the dashboard panels properly — Notes, Calendar, Tasks, Volume/Microphone, dropdowns, sliders, inputs, the Settings panel and the event modal all get readable light surfaces and contrast (sliders fill with the accent colour). Immersive full-screen views (Focus lock screen, Xenon AI space) stay dark by design. **Auto** now reads the Windows app theme directly from the registry (server-side) instead of relying on the browser's `prefers-color-scheme`, which the embedded WebView often reported incorrectly — so Auto reliably follows your actual Windows light/dark setting (*Settings → Personalization → Colors → "Choose your default app mode"*) and updates within ~30s if you change it. In light mode the panel-opacity slider now works (white tiles become genuinely translucent), and the neon grid background is kept gentler so it doesn't overpower the light surface.
- **Light-theme contrast fixes**: more elements now read correctly in the light theme — the topbar weather pill (temperature, place and the animated condition icon were white and vanished on the light bar), the timer (time, label, delete, ring, inputs), the calendar (month, weekday labels, day cells, nav arrows), the Customize editor dock + chips, the audio device rows (speaker/mic) and the device-picker modal, and form fields without an explicit type. The Media and Weather panels intentionally stay dark "islands" (they sit on album art / a colour-led glass), so their controls keep light-on-dark styling and no longer disappear in light mode.
- **Real timer icons**: the countdown timer's pause / play / restart / delete buttons now use proper SVG icons instead of emoji.
- **Xenon AI presence redesign**: the voice mode now centres on a sleek **circular audio equaliser** — a ring of luminous bars, where a wave travels around the ring, around a glowing **sparkle** core (soft formless glow + a gently pulsing, slowly-rotating star) with expanding ripples. It stays coherent across the three states: a gentle calm wave while **listening**, a tight bright pulse racing around the ring while **thinking**, and a big energetic wave with outward ripples while **speaking**; the illuminated border is kept. The floating bottom-right launcher orb (which sat in the way of the bottom tiles) is gone — Xenon is started from a prominent **accent pill** in the top bar with a clean sparkle icon and a subtle light-sweep, so the AI is highlighted without floating over the dashboard. All GPU-light (transform/opacity only) and respects reduced-motion.
- **Top bar follows the Surface settings**: the top bar (clock, weather, actions) now uses the same panel surface as the tiles, so the panel-opacity slider (and the light/dark theme) apply to it too — previously it kept a fixed glass look that ignored those settings.
- **Settings → Appearance no longer scrolls**: the Animated background (Aurora) and Grid controls moved to the **Background** tab, where they belong, so the Appearance tab fits without scrolling.
- **FPS card "N/D" badge fixed**: the "N/D" tag and the "requires PresentMon" hint now hide as soon as a real FPS value is available (they used to stay even while a frame rate was shown).
- **Album art no longer flickers to "No media"**: when the system media service momentarily drops the cover for the *same* track, the last known artwork is kept instead of flashing the empty placeholder.
- **One unified Xenon AI mark**: the assistant used a mix of icons (sparkles in some places, a diamond in others). There is now a single distinctive Xenon mark — a four-point spark with a central aperture — used everywhere: the top-bar launcher pill, the chat header, the Settings → Xenon AI tab, the "AI unavailable" notice, and as the glowing centre of the voice equaliser. The voice layers are also perfectly concentric now.
- **Weather hero shows the moon at night**: in the weather modal, cloudy/rainy/etc. conditions kept drawing the sun behind the clouds even after dark (only clear skies switched to the moon). The light source now becomes the moon at night for every condition, matching the hourly icons. The same fix is applied to the Focus lock screen's weather widget.
- **Lock screen clock spacing**: the digits and the colon were unevenly spaced (extra gap on one side); the hour/minute now centre in their slots so the colon sits symmetrically.
- **Softer tile accent bar**: the coloured accent stripe on the left edge of each tile no longer looks like a hard painted line — it now fades gently into the panel surface and tapers out at the top and bottom for a more elegant, glow-like finish (all accent colours).
- **Media Playback panel polish**: the source badge now shows the **official icon** of where you're listening (the Spotify / YouTube brand mark, or the app's real executable icon) instead of a generic dot, and the artwork sits on a softer shadow. A new **per-source volume slider** (with mute) appears right in the Playback tab and controls the volume of the app currently playing (Spotify, a browser tab, …) independently of the master volume — kept in sync live, and hidden automatically when the source can't be matched to an audio session.
- **Media chat refinements**: the mini player at the top of the Chat tab is now compact (the play/pause button no longer balloons to full size). Added a **New chat** button next to the input to reset the conversation in one tap. Attachments now accept **documents and text files** (PDF, TXT, Markdown, CSV, JSON, common code files) in addition to images — non-image attachments show a labelled file chip both in the pending preview and inside the conversation, and unsupported formats give a brief notice.
- **Topbar rebuilt for clarity**: the top bar was redesigned from scratch. The two confusing icon-only buttons are gone — the AI chat shortcut (now lives inside the Media tile) and the single-components opener (you reorganise tiles from the Customize editor). Every remaining action is now a clear labelled button (icon **+** text — Lock, Focus, Layout, Settings, Apps) so there's nothing to memorise on the touchscreen, with labels collapsing back to icons only on very narrow widths. The weather chip is far more visible: a larger pill with a live animated condition icon (sun, moon, clouds, rain, snow…), a bigger temperature, and a soft colour tint that matches the current weather. Labels are translated in all five languages.

---

## [v2.0.3] - 2026-05-30
### 🐛 Bug Fixes
- Fixed a regression where all Gemini API calls (speech recognition, chat, weather search) were incorrectly using the TTS-only model (`gemini-3.1-flash-tts-preview`), causing "Audio input modality is not enabled" errors. Each endpoint now uses the correct model: `gemini-3.5-flash` for text/audio, `gemini-3.1-flash-tts-preview` for speech synthesis only.

---

## [v2.0.2] - 2026-05-30
### 🐛 Bug Fixes
- Fixed GPU temperature not showing for AMD and Intel graphics cards. Previously only NVIDIA users (via nvidia-smi) received a temperature reading; AMD and Intel users always saw a blank. The GPU script now falls back to LibreHardwareMonitor — already installed by the one-click installer — to read GPU temperature on any vendor without adding new dependencies.

---

## [v2.0.0] - 2026-05-28
### ✨ New Features / Improvements

- **Xenon AI — completely redesigned presence experience**: The assistant is no longer a chat panel over the dashboard — opening Xenon now dims the screen into a calm, deep-black ambient space built around motion, light, and large expressive typography. The voice mode centres on a living *resonance* orb: a volumetric sphere of light whose edge melts into its own glow (no hard disc, no box behind it — it truly floats in the black), filled with a slow fluid colour mesh and a bright beating core. Each state feels distinct — it leans in and pulses calm sonar rings while **listening**, an orbiting conic light scans around it while **thinking**, and energy bursts outward in brighter, faster waves while **speaking**. The chat reads as a calm transcript instead of a messaging app: Xenon speaks in borderless typography with a soft accent marker, only your messages keep a minimal tinted pill. A new abstract identity mark — a resonance aperture — replaces the old sparkle on the assistant and its topbar button. The Siri-style animated edge glow is retained and refined (calmer palette, state-reactive speed). Respects `prefers-reduced-motion`.

- **Xenon AI — full assistant with voice, vision, and function calling**: Powered by Google gemini-3.1-flash-tts-preview. Tap the sparkle (✦) button in the top-right corner to open a Liquid Glass chat panel. Xenon can control every dashboard component by text or voice: toggle the mic, play/pause and skip tracks, set volume, read and write notes, create calendar events and tasks, start and delete timers, lock the PC, change the colour theme, open the weather panel, app switcher, settings, and focus lock screen, and open any app, website, or file on the PC.

- **AI voice mode — button-triggered with follow-up listening**: Press the large floating voice orb button to start a voice session. Xenon listens, transcribes your command, thinks, and replies aloud. After it finishes speaking, it stays listening for a few seconds so you can ask a follow-up straight away — no need to press the button again. Ask another question and the conversation continues in the same context; stay silent and the session closes on its own with a soft chime. The microphone stays quiet while Xenon is speaking, so it never misinterprets the assistant's own voice.

- **AI voice — tap to interrupt**: During the thinking or speaking phase a **"· tap to stop"** hint is shown on the voice screen. Tapping anywhere on that screen **instantly** stops TTS playback, cancels any active server recording, and closes the voice session. This is the primary way to interrupt Xenon on the Xeneon Edge touchscreen.

- **AI voice orb — animated resonance interface**: Voice sessions are centred on a living *resonance* orb: a volumetric sphere of light whose edge melts into its own glow, filled with a slow fluid colour mesh. Each state feels distinct — it leans in and pulses calm sonar rings while **listening**, an orbiting conic light scans around it while **thinking**, and energy bursts outward in brighter, faster waves while **speaking**.

- **AI voice — natural human-like voice with short spoken replies**: Spoken answers now use Google Gemini's native neural voice — markedly more lifelike than a standard TTS — and voice replies are deliberately kept short and conversational (1-2 sentences), which also makes them faster to generate and speak.

- **AI screen vision — capture and analyse any monitor**: Ask Xenon "what's on my screen?" or "read that text" and it captures a live screenshot via NirCmd and sends it to Gemini for analysis. On multi-monitor setups, clickable monitor buttons appear directly in the dashboard so you can pick which screen to analyse without typing.

- **AI markdown rendering**: AI replies now render headings, bold/italic text, bullet lists, numbered lists, inline code, horizontal rules, and links as formatted HTML inside the chat bubbles. Plain text and emoji still display exactly as before.

- **AI audio ducking**: Master volume is automatically lowered while Xenon speaks and restored to the previous level when it finishes, so the assistant's voice is never drowned out by your music.

- **AI app control — close apps too**: Beyond opening apps, Xenon can now close them on request — say "close Spotify" during a voice session and the app terminates. Works for common apps (Spotify, Chrome, Edge, Discord, Steam, OBS, VLC, Office, Teams, and more) and any process by name.

- **AI calendar — clear all events**: Xenon can now delete every calendar event at once on request (with a confirmation first), and correctly sees past events as well as upcoming ones — previously "delete all events" could wrongly report an empty calendar when only past events remained.

- **AI — microphone sensitivity slider**: Settings → Xenon AI exposes a microphone sensitivity slider (0–100) that controls the input gain for voice recording. Useful on headsets with naturally quiet microphones, or to improve speech recognition with Bluetooth audio. Maps to 1.5× to 5× amplification on the captured audio signal.

- **Countdown timers with AI integration**: A new Timer tab sits next to Calendar and Tasks in the media panel. Create timers by typing a label and a duration (e.g. `5:00`, `1:30:00`, or a plain number of minutes). Each timer shows a live SVG ring progress arc, a countdown display, and pause / restart / delete controls. You can also say "set a timer for 10 minutes called Pasta" during a voice session and the AI creates it instantly. A toast notification and chime play when a timer finishes. Timers survive server restarts (persisted to `timers.json`).

- **AI settings panel — complete setup guide**: The Xenon AI section in Settings now shows a full explanation of capabilities, a step-by-step setup guide with a direct link to Google AI Studio, and a privacy note confirming the API key is stored only on this PC. Available in all five supported languages.

- **Voice session chimes**: Soft audio cues mark the start and end of voice sessions (8% amplitude) — noticeably softer than notification sounds.

- **Weather UI redesign**: All weather components (topbar pill, weather modal, lock screen weather card) rebuilt with an iOS Weather-inspired aesthetic — dynamic sky gradient backgrounds per condition (sun, moon, cloud, rain, storm, snow, fog), thin-weight temperatures, flat minimal icons, frosted glass metric cards, and subtle CSS animations (sun glow pulse, moon gleam, cloud drift).

### ⚡ Efficiency
- **Snappier, better-synced voice turns**: Xenon now stops recording as soon as you finish talking, instead of waiting out a fixed window — so it reacts and closes the session promptly. The voice screen also stays on **"Sto pensando…" / "Thinking…"** until the spoken answer actually begins playing, rather than showing "speaking" during the brief moment the voice is still being generated.
- **Voice transcription ignores silence**: a near-silent recording (below the speech-energy floor) is no longer sent to Gemini at all, so silence or stray background noise can never be turned into a phantom command.
- **Lighter client**: removed unused voice-detection code and disabled the per-event debug network logging by default, reducing background work and network chatter on the display.

### 🐛 Bug Fixes
- Fixed weather and lock screen always showing the sun icon at night. Day/night is now determined using actual sunrise and sunset times from the weather API, instead of hardcoded hours.
- Fixed dashboard data (audio, media, system stats) freezing on the last value when the real-time stream temporarily dropped: the polling fallback now correctly schedules a periodic refresh for every panel — previously it fetched each one only once on disconnect, so the UI could stay stale until the stream reconnected. The fallback also no longer leaves orphan timers behind on reconnect, eliminating a slow build-up of duplicate background requests.

---

## [v1.3.5] - 2026-05-22
### ✨ New Features
- Added a media source selector that appears when Windows reports multiple active media sessions, letting users choose Auto, Spotify, YouTube, or another detected player instead of relying only on automatic SMTC scoring.

### 🐛 Bug Fixes
- Fixed a long-running stability issue where the media widget could freeze on the last snapshot, other SMTC-aware apps could stop receiving "now playing" updates, and Windows shutdown could stall. The PowerShell media helper now releases the WinRT thumbnail stream, input stream, and data reader after every read, applies an internal timeout to WinRT calls so a stuck system media broker can no longer hang the script, and the Node server lets the helper exit on its own instead of killing it mid-flight, which previously left dangling references on the system media broker.

---

## [v1.3.4] - 2026-05-21

### 🐛 Bug Fixes
- Forced UTF-8 JSON output in `cpu-temp.ps1`, `gpu.ps1`, `media.ps1`, `network.ps1`, and `windows.ps1` so the server reads PowerShell data consistently even when titles, names, or labels contain multibyte characters.
- Restored `server.js` to launch PowerShell scripts through the original `-File` path while keeping UTF-8 handling in the scripts themselves, reducing the risk of regressions in server-side media, system, network, and window data collection.

---

## [v1.3.3] - 2026-05-15

### ✨ New Features
- Added Korean, Japanese, and Simplified Chinese language options to the server dashboard.

### 🐛 Bug Fixes
- Remembered the user's Media/Calendar view choice, so returning to the Media widget no longer resets the panel back to full media when Calendar was selected.
- Fixed Spotify and other media metadata with Korean, Japanese, Chinese, and other multibyte characters so song titles, artists, and artwork searches no longer use corrupted text.

---
## [v1.3.2] — 2026-05-14

### 🐛 Bug Fixes

- Improved automatic CPU temperature setup: `INSTALL.bat` now asks for administrator privileges, installs LibreHardwareMonitor and PawnIO through winget when available, registers the Windows startup task with elevated privileges, restarts the local server so elevated sensor access takes effect immediately, and the server can read CPU temperatures directly from the LibreHardwareMonitor library before falling back to WMI.

## [1.3.0] — 2026-05-14

### ⚡ Performance

- **Server-Sent Events** replace client-side polling for mic status, media, system, and audio data. The dashboard now receives updates the moment the server has new data instead of waiting for the next polling cycle. A fallback to conventional polling is active if the connection drops or if an older server build is detected.
- **GPU-accelerated animations**: added `will-change: transform` and `will-change: opacity` to all long-running CSS animations — mic orbit ring, weather (blob, float, cloud drift, rain, snow, fog), clock colon blink, and status dot pulse. Animations now run on the GPU compositor thread instead of the CPU.
- **Lock screen clock** now uses `requestAnimationFrame` instead of `setInterval`. The display updates precisely when the second changes and wastes zero frames otherwise.
- **Artwork cache** is now capped at 200 entries with LRU eviction. Memory use stays bounded even after an extended session with many different tracks.
- **Media panel background layer** promoted to its own GPU layer via `translateZ(0)`, preventing the heavy `blur + saturate + brightness` filter from forcing full repaint cycles.

### ✨ New Features

- **Task tracker panel**: a new Tasks widget lets you manage a personal to-do list directly on the dashboard. Each task has a colour-coded priority dot — red for high, amber for medium, green for low. Action buttons follow the same palette: the complete button is green, the undo button is orange, and the delete button is red for immediate clarity. Completed tasks move to a separate section with strikethrough styling. Tasks support automatic recurrence: daily, weekly, or a custom number of days — recurring tasks reset themselves at page load once the interval has elapsed. By default the panel lives inside the Calendar view as a toggle tab; users can also restore it as a standalone widget via the dashboard customisation editor.
- **Custom dropdown controls**: all select inputs across the dashboard (task priority, recurrence, event reminder) now use a custom-styled dropdown that matches the dashboard aesthetic, replacing the plain browser-native selects.
- **Animated theme transitions**: switching colour theme (Xenon, Ocean, Ember, Violet, Mono, or custom hex) now cross-fades the accent colour and background over 380 ms instead of changing instantly. Implemented via CSS `@property` with no JavaScript.
- **View Transitions** on dashboard layout changes: hiding, restoring, reordering, and resizing panels now uses the browser's View Transitions API for a smooth cross-fade animation. Falls back silently on builds without the API.

---
## [1.2.2] — 2026-05-14
### 🐛 Bug Fixes
- Improved embedded server dashboard sizing so borderline Xeneon/WebView viewport heights no longer show stray white space or trigger unnecessary panel scrollbars.


---
## [1.2.1] — 2026-05-13

### 🐛 Bug Fixes
- Fixed manual weather display names so selected cities such as Los Angeles show the city instead of a nearby provider area.
- Moved Settings status messages to the shared footer and tightened the Settings layout so Weather sits closer to Media background.
- Fixed manual weather city typing so the first space is no longer swallowed while entering names such as `Los Angeles` or `San Francisco`.
- Fixed manual weather city lookup so ambiguous names such as `Rome` are resolved more reliably instead of drifting to the wrong city.

---

## [1.2.0] — 2026-05-13

### ✨ New Features

- Added a persistent **Customize Dashboard** mode for the server dashboard and iCUE widget. Users can reorder, resize, hide, restore, and reset dashboard widgets without editing code.
- Added persistent customization for the **System** and **Network & Gaming** cards, including card order, size, visibility, tab order, and the remembered active tab.
- Added persistent customization for the server dashboard **Audio** controls, so Volume, Speaker, and Microphone controls can be reordered, resized, hidden, restored, and reset.
- Added **Weather location settings** with automatic location detection or a manually entered city.

### 🐛 Bug Fixes

- Fixed the server dashboard customization toolbar so it no longer covers the Speaker and Microphone audio controls while editing the layout.
- Expanded the server dashboard customization toolbar so its controls wrap across the full available width instead of requiring horizontal scrolling.
- Fixed weather animations so storm lightning, rain, snow, fog, and sun rings only animate for the matching weather condition.
- Improved weather condition detection by using weather provider condition codes first, with translated condition text only as a fallback.

---

## [1.1.3] — 2026-05-12

### 🐛 Bug Fixes

- Fixed **Windows installer startup registration** on systems where `Register-ScheduledTask` rejected a plain username (`HRESULT 0x80070057`). The installer now uses the full current Windows identity and falls back to `schtasks.exe` when needed.
- Fixed **animated GIF backgrounds** that sometimes stayed invisible right after upload until the dashboard/component was reloaded. Background media now recreates a fresh image/video node when changed, which makes problematic GIFs appear immediately without a manual reload.
- Raised the **background upload limit** from 32 MB to 200 MB across server validation, UI messages, and documentation.

### 📘 Documentation

- Updated the README to reflect the current install flow, weather endpoint, custom media background support, and the revised 200 MB upload limit.

## [1.1.2] — 2026-05-11

### 🐛 Bug Fixes

- Increased **overall text readability** across the dashboard, panels, modals, and compact iCUE embed breakpoints.
- Improved **background media sharpness** by removing the fixed 105% background upscale when blur is disabled.
- Added a clearer error message when unsupported background files such as MP3/audio are selected.
- Improved uploaded **MP4/WebM background playback** reliability in browser/iCUE WebView with explicit autoplay attributes and playback retries.
- Added HTTP **byte-range streaming** for uploaded backgrounds so MP4/WebM files can be decoded correctly by browser and iCUE WebView video players.
- Added automatic **MP4 → WebM VP8 conversion** on background upload when FFmpeg is available, so users can upload common Pexels/Pixabay MP4 files without manual conversion.
- Improved **FFmpeg discovery** for winget installs that place `ffmpeg.exe` under the WinGet package directory instead of adding it to `PATH`.
- Lowered **panel opacity** minimum from 42% to 18% for lighter glass-style layouts.
- Softened panel borders, highlights, and shadows at low opacity so panels do not look overly stamped on subtle backgrounds.
- Improved topbar, weather chip, clock text, and icon readability on bright custom backgrounds with darker floating controls and text/icon shadows.

### 📘 Documentation

- Added a note that MP4/WebM backgrounds at display resolution usually look sharper than downloaded GIFs.
- Clarified that iCUE WebView may reject MP4 files that play in Chrome, so WebM VP8/VP9 is recommended for animated backgrounds inside iCUE.
- Added step-by-step background video guidance covering supported formats, automatic MP4 conversion, FFmpeg installation, server restart, and the 200 MB upload limit.

## [1.1.1] — 2026-05-11

### 🐛 Bug Fixes

- Fixed **media title clipping** in the main Media panel and Focus Lock Screen variants by increasing title line-height and adding a small bottom padding for heavy-weight glyphs.
- Fixed **theme persistence after reboot / restart** by persisting hub settings server-side in `server/settings.json` in addition to browser `localStorage`.

### 📘 Documentation

- Clarified that the current release is **not a native iCUE widget** yet.
- Corrected the iCUE setup instructions to use the full **`<iframe>` HTML tag** instead of pasting only the localhost URL.

## [1.1.0] — 2026-05-11

### ✨ New Features

#### Focus Lock Screen
- Added a full-screen **Focus Lock Screen** overlay (`id="lockscreen-overlay"`) — an internal client-side lock distinct from the Windows PC lock.
- Accessible via the **Focus** button in the topbar (lock icon).
- Escape key or tap/click anywhere on the overlay closes it; the existing `quickLock()` PC-lock shortcut is unchanged.
- The lock screen shows a live **clock** (hours : minutes, AM/PM), configurable via Settings.
- Configurable **widget tiles** on the lock screen: Clock, Weather summary, Now Playing card, Upcoming Events list — each can be individually enabled or disabled in Settings → Lock Screen.
- **Settings persistence**: lock widget preferences stored under `xeneonedge.settings.v1.lockWidgets`.

#### Animated Lock Screen Clock
- Clock digits are split into separate DOM nodes (`lock-time-h`, `lock-time-sep`, `lock-time-m`, `lock-time-ampm`) enabling per-digit animation.
- **Digit-tick animation**: each digit performs a subtle vertical bounce when its value changes.
- **Colon pulse animation**: the separator `:` fades in and out on a 2-second cycle.
- **Clock breathe animation**: the entire clock gently scales up/down for a living-display feel.

#### Lock Screen — Media Card
- Now Playing card displays song title, artist, and playback controls (previous / play-pause / next).
- Play/pause icon is kept in sync with the actual playback state using the same `playbackStatus === 'Playing'` logic as the main dashboard.
- **Media-wide state**: when the media card is visible but the events list is hidden (no upcoming events), the media card expands to fill the available width — larger album art, bigger title/artist text, and enlarged action buttons.
- **Media-only state**: when media is the sole active widget, the card expands further with a scaled cover and maximum layout.
- The card is only shown when there is genuinely active media (`title` or `artist` from the current media session).

#### Lock Screen — Upcoming Events
- Shows the next 1–3 upcoming calendar events with title, date, and time.
- Only rendered when there is at least one real upcoming event; the tile is hidden completely if the calendar is empty or all events are in the past.

#### Lock Screen — Weather Summary
- Compact weather chip showing current condition icon and temperature.
- Integrated with the existing weather data refresh cycle.

---

### 🎨 UI / UX Improvements

#### Topbar Clock
- Redesigned clock area in the topbar with improved spacing and visual hierarchy.
- Seconds display and AM/PM indicator configurable via Settings.

#### Settings Modal
- **Language switcher moved into Settings**: language selection is now a dedicated row inside the Settings modal instead of a floating button.
- **Removed scroll**: settings content fits in a compact grid layout — no scrollbar needed.
- **Color personalization**: replaced native `<input type="color">` pickers (broken in iCUE WebView) with a hex text input + live div preview, ensuring reliable color editing on all hosts.

#### Weather Details Modal
- Full redesign of the animated weather details modal.
- **Removed metric dots**: eliminated the decorative `::before`/`::after` pseudo-element dots from `.weather-metric` items for a cleaner look.
- **Removed blue rain bar**: removed the `box-shadow` glow under mini cloud icons in rainy conditions (`.weather-mini-icon.state-rain`) that was visually confusing.
- Improved contrast on `.weather-hero-chips em`, `.weather-metric-label`, `.weather-day-condition`, and `.weather-day-sun`.

#### Text Contrast Improvements
- Raised `--muted-text` from `#7d8784` → `#a6b1ad` (global CSS variable).
- Raised `--dim-text` from `#46504d` → `#7f8a86` (global CSS variable).
- Raised `.stat-head` color in System Panel to `#a6b1ad`.
- Raised `.stat-muted-detail` in System Panel to `#929d99`.
- Raised `.vol-title` in Audio Section to `#b8c3bf`.

---

### 🐛 Bug Fixes

- **Play/pause icon always showed Pause on lock screen**: fixed by using the same `style.display` visibility pattern as the dashboard instead of the `hidden` attribute. Introduced `syncLockMediaPlaybackIcon(playing)` helper in `media.js` called from every code path that mutates playback state (`applyMedia`, `updateCalendarMiniPlayer`, `refreshMediaEmpty`, `mediaAction('playpause')`).
- **Lock screen Events/Media tiles showing as empty**: fixed by computing real availability before deciding visibility. `eventsActive` is now only `true` when `calendarEvents` contains at least one upcoming event; `mediaActive` is only `true` when `mediaData.active` is truthy and title or artist is non-empty.
- **Lock screen overlay rendered inside weather modal**: fixed after reading DOM structure; overlay moved to correct top-level position in `index.html`.
- **Settings color pickers not firing in iCUE WebView**: replaced with hex text input + div preview (no reliance on native color-picker events).

---

### 🗑️ Removed

- **"Focus lock" label pill** on the lock screen overlay — removed for a cleaner, distraction-free look.
- **"Esc or X to exit" hint text** on the lock screen — removed; the overlay is intuitive without the label.
- Unused i18n keys: `lockscreen_open`, `lock_tap_to_exit`.

---

### 📁 Files Changed

| File | Change |
|------|--------|
| `server/index.html` | Added lock screen overlay markup at top level; split clock nodes; removed label/hint elements |
| `server/js/lockscreen.js` | New module — lock screen runtime, clock animation, widget rendering, media/events availability logic |
| `server/js/settings.js` | Lock widget settings, hex color picker, language in settings modal |
| `server/js/media.js` | `syncLockMediaPlaybackIcon()` helper; all playback paths wired to lock screen |
| `server/js/main.js` | Escape key checks lock screen first; `quickLock()` unchanged |
| `server/js/i18n.js` | Added lock screen translation keys; removed obsolete keys |
| `server/components/LockScreen/LockScreen.css` | New — full lock screen styling, digit-tick, colon-pulse, clock-breathe animations, media-wide/media-only states |
| `server/components/WeatherModal/WeatherModal.css` | Removed metric dots and rain box-shadow; contrast improvements |
| `server/components/SystemPanel/SystemPanel.css` | Raised `.stat-head` and `.stat-muted-detail` contrast |
| `server/components/AudioSection/AudioSection.css` | Raised `.vol-title` contrast |
| `server/styles/global.css` | Raised `--muted-text` and `--dim-text` CSS variables |

---

## [1.0.0] — Initial public release

- System monitor: CPU, GPU, RAM, network throughput with LibreHardwareMonitor integration
- Media panel with now-playing via Windows SMTC, album art lookup, playback controls
- Microphone mute/unmute toggle with visual indicator
- Calendar panel with event management and reminder toasts
- Notes panel with inline editing
- Audio device picker with master volume control
- App switcher panel
- Color theming with accent, text, and background color personalization
- One-click install/uninstall scripts for Windows
- Support for both browser and Corsair iCUE / Xeneon Edge display
