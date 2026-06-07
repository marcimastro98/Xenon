# XenonEdge Hub

A polished, all-in-one dashboard widget built for the **CORSAIR Xeneon Edge 14.5" LCD** — also works in any browser or iCUE iFrame on Windows.
Everything runs **100 % locally**: no cloud, no telemetry, no account required.

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![node](https://img.shields.io/badge/node-%E2%89%A5%2018.15-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-3.0.0-informational)

> **⚠️ Note:** This is **not a native iCUE widget** yet. It runs as a local Node.js server and is displayed inside iCUE via an **iFrame** — not as a `.icuewidget` package. A native iCUE widget version is in development.

---

## Overview

![XenonEdge Hub dashboard overview](docs/images/overview.png)

XenonEdge Hub turns your Xeneon Edge display into a real productivity panel.
At a glance you can monitor your PC health, control media playback, mute your mic, check your schedule, jot down a note, and even dim the screen into a focus lock — all without touching your keyboard.

---

## Sections at a glance

### Customizable Dashboard

![Dashboard customization edit mode](docs/images/dashboard-customize.png)
![Dashboard customization layout options](docs/images/dashboard-customize-2.png)

The home dashboard is a fully modular **Bento** grid. You can shape it around the panels you actually use most.

By default it shows three tidy **hub tiles**, each grouping related content as tabs:

- **Media** — Playback · Chat (Xenon AI)
- **Agenda** — Calendar · Timer · Tasks · Notes
- **System** — System (CPU/GPU/RAM/Disk + Network & Gaming) · Volume · Microphone

Tap the **Layout** button in the top bar to enter edit mode. From there:

- **Add anything individually** — Calendar, Timer, Tasks, Notes, Volume and Microphone can each be pulled out of their hub into their own standalone tile, or put back. Hidden items appear as one-tap **"add" chips**
- **Move** any tile earlier/later in the grid
- **Resize** tiles through a set of sizes (compact → full) to give more space to what matters
- **Hide** any tile you do not need and restore it later — your other tiles are untouched
- **Reset** the layout at any time to return to the default arrangement
- When a hub (Agenda or System) is left with a single item inside, its tab bar hides automatically for a cleaner look

Customization goes deeper too: the individual **System cards** (CPU, GPU, RAM, Disk) and **Audio sub-controls** (Volume, Speaker, Microphone) can each be reordered, resized, hidden and restored.

All of these layout choices are saved automatically (locally and to the server), so the dashboard stays the way you left it after a refresh or restart. On upgrade the layout migrates automatically while preserving your other settings (theme, weather, API key…).

---

### Multi-page Dashboard

<!-- TODO screenshot: la dashboard con i puntini di paginazione in alto e/o la seconda pagina.
     Salva l'immagine come docs/images/dashboard-pager.png e togli il commento alla riga sotto. -->
<!-- ![Multi-page dashboard with page dots](docs/images/dashboard-pager.png) -->

The dashboard is a horizontal **pager**: page 1 is your dashboard, page 2 hosts the **Lighting** controls (see below), and the system is built to grow with more pages over time. Move between pages however you like:

- **Swipe** sideways on the touchscreen
- **Scroll** horizontally, or hold **Shift** while scrolling the wheel
- **Drag** an empty area of the page left/right with the mouse
- **Arrow keys** ← / →
- Tap the **page dots** in the top bar to jump directly to a page

Navigation is compositor-driven (CSS scroll-snap), so it stays smooth and inexpensive even while a game or heavy workload is running. Your panels and their own scrolling keep working exactly as before — the pager never hijacks a panel interaction or a layout-edit drag.

In **Layout mode** you **drag** tiles to reposition them and **resize** them from the corner (snapped to a clean grid). Each tile keeps two controls — **hide** (👁) and **move to another page** (⇄) — and a **"+"** on every page opens a palette to add any available widget (empty pages show a large "+"). The **Lighting hub** is itself a movable module. Your arrangement persists across reloads. *(Upgrading to the drag-and-drop editor resets any previous custom arrangement to a clean default, once.)*

<!-- TODO screenshot: modalità Layout con drag&drop, maniglia di resize e "+" per aggiungere.
     Salva come docs/images/layout-dragdrop.png e togli il commento alla riga sotto. -->
<!-- ![Drag-and-drop layout editor](docs/images/layout-dragdrop.png) -->

You can also **group widgets into tabs**: in Layout mode drag one tile onto another to merge them into a single tabbed tile (e.g. Calendar + Music), and drag a tab's ⤤ out to split it back. Playback and the Xenon-AI Chat are separate widgets, shown grouped by default.

<!-- TODO screenshot: due widget uniti in un tab-group (es. Calendario + Musica).
     Salva come docs/images/tab-group.png e togli il commento alla riga sotto. -->
<!-- ![Tab-group of two widgets](docs/images/tab-group.png) -->

Pages are fully yours: the Layout mode **Pages** panel lets you **add, rename, remove and reorder** dashboard pages (1–8). Removing a page asks to confirm and moves its modules to the hidden list (restorable).

<!-- TODO screenshot: il pannello "Pagine" nel menu Layout (aggiungi/rinomina/riordina/rimuovi).
     Salva come docs/images/layout-pages.png e togli il commento sotto. -->
<!-- ![Layout → Pages manager](docs/images/layout-pages.png) -->

<!-- TODO screenshot: modalità Layout con il pulsante "sposta a pagina" su un modulo.
     Salva come docs/images/layout-move-page.png e togli il commento sotto. -->
<!-- ![Move a module to another page](docs/images/layout-move-page.png) -->

---

### RGB Lighting (Corsair / iCUE)

<!-- TODO screenshot: la pagina Illuminazione (pagina 2 della dashboard) con i controlli RGB.
     Salva l'immagine come docs/images/lighting-page.png e togli il commento alla riga sotto. -->
<!-- ![Lighting page with RGB controls](docs/images/lighting-page.png) -->

Page 2 of the dashboard is the **Lighting** page: it lets the widget **drive your Corsair RGB devices from real data**, instead of the other way around. Reactive effects:

- **CPU temperature → colour** — a cool blue → warm red gradient that follows your CPU temp
- **Timer expiring → pulse** — a red pulse when a countdown finishes
- **Volume → light bar** — a brief accent-coloured flash when you change the volume

You can also set a **fixed manual colour** (name or hex) that overrides the effects until you reset it.

It is designed to **share control with iCUE**, not fight it: when you turn the bridge off — globally or per device — it hands the LEDs straight back to your normal iCUE profile. It also **idles automatically while you game** (toggleable), so it never competes for resources under load. Everything is opt-in and granular: a master switch, per-effect toggles, a per-game-pause toggle, a brightness slider, and a per-device on/off list. The bridge is **off by default**.

**Where things live:** the page-2 **hub** is for live control (master, manual colour, brightness, per-device opt-in, quick effect toggles), while the deeper **configuration** lives in **Settings → Illuminazione** — turn reactive effects on/off and set, per event, a colour and an animation style. The **timer**, **notifications** and **reminders** can each flash the lights with a chosen colour (default red) and a style: **blink**, **pulse** (breathing) or **solid**.

<!-- TODO screenshot: Impostazioni → Illuminazione (configurazione effetti).
     Salva come docs/images/settings-lighting.png e togli il commento sotto. -->
<!-- ![Settings → Lighting configuration](docs/images/settings-lighting.png) -->

**Xenon AI** can control all of this by voice or chat — e.g. *"turn the lights red"*, *"enable the temperature effect"*, *"turn the lighting off"*, *"set the timer effect to a blue pulse"*, *"what's the CPU temperature?"*, *"go to the lighting page"* — on both the Gemini and local (Ollama) providers.

> **Requirements:** iCUE must be installed and running with the **SDK enabled** (iCUE → Settings → enable the SDK). Without it, the Lighting page shows a friendly "iCUE not detected" notice and the rest of the dashboard is unaffected. The bridge loads its native binding (koffi + the iCUE SDK) **only when you enable it**, so users who never turn it on pay zero cost.

---

### Media

![Media panel with now-playing track and controls](docs/images/media.png)

The Media tile has two tabs — **Playback** and **Chat** (Xenon AI). It shows the currently playing track from **any SMTC-aware app** (Spotify, YouTube Music, Windows Media Player, Chrome, Edge, …).

- Album artwork fetched automatically
- Song title and artist name
- **Play / Pause / Previous / Next** transport controls
- Falls back gracefully when nothing is playing — the tile opens on the **Chat** tab so it is never empty
- On the **Chat** tab a compact mini player (cover, title, prev/play/next) stays visible while music plays, with the album art softly blurred behind the conversation
- The Chat is the built-in **Xenon AI** assistant (see below): a **New chat** button resets the conversation, and you can attach **images, PDFs and text/code files**. Without an API key it shows a clear "AI unavailable — add your API key" message (all languages), with an option to hide the Chat tab entirely

---

### Microphone

![Microphone mute toggle and level meter](docs/images/microphone.png)

- **One-click mute / unmute** toggle with a clear visual indicator
- Live microphone input level meter
- **Change default mic device** from a drop-down list — no need to open Windows Settings
- **Per-app mic mixer**: when an app actively captures audio (Discord in a voice channel, Teams, OBS, …) a dedicated section appears below the master controls with a per-app sensitivity slider and individual mute toggle. It hides automatically when no app is using the microphone

---

### Audio

![Audio output device picker and volume slider](docs/images/audio.png)

- **Output device picker** — switch between speakers, headphones, headsets in one tap
- **Master volume slider** (0 – 100 %)
- **Speaker mute toggle**
- **Per-app Audio Mixer**: whenever any application produces audio (Spotify, Discord, Chrome/YouTube, iCUE, …) a compact App Mixer section appears directly below the master slider. Each app row shows the real icon extracted from the executable, a friendly name, an independent volume slider, a percentage, and a per-app mute toggle. Changing a row only affects that app's volume, leaving everything else untouched. The section disappears automatically when no apps are producing audio
- In **Customize Dashboard** mode, Volume, Speaker, and Microphone can each be reordered, resized, hidden, or restored independently
- All changes take effect immediately via [SoundVolumeView](https://www.nirsoft.net/utils/sound_volume_view.html) (bundled, freeware)

---

### System Monitor

![System monitor with CPU, GPU, RAM and disk stats](docs/images/system-monitor.png)

Real-time hardware readouts pulled from Windows performance counters and LibreHardwareMonitor:

| Metric | Details |
|--------|---------|
| **CPU** | Usage %, temperature (package), hostname, uptime |
| **GPU** | Usage %, temperature (NVIDIA `nvidia-smi` or WMI fallback) |
| **RAM** | Used / total (GB), load % |
| **Disks** | Temperature per drive (LibreHardwareMonitor) |

In **Customize Dashboard** mode, the System / Network & Gaming panel now supports persistent card order, size, visibility, tab order, and remembered active tab.

---

### Network

![Network throughput, ping and jitter readouts](docs/images/network.png)

- Live **download / upload** throughput (MB/s) sampled from the active adapter
- **Ping** and **jitter** to a configurable target
- **In-game FPS** — shows the *real* frame rate of the active game, including exclusive-fullscreen titles, via PresentMon (installed automatically by `INSTALL.bat`); falls back to a DWM reading (windowed/borderless only) if PresentMon isn't present
- Updates every few seconds without blocking the UI

---

### Weather

![Weather current conditions](docs/images/weather.png)
![Weather forecast and hourly timeline](docs/images/weather-2.png)

- **Current conditions** — temperature, feels-like, humidity, wind speed and direction, pressure, visibility, UV index, cloud cover, precipitation
- **3-day forecast** — daily high / low and condition summary
- **8-hour hourly forecast** with scrollable timeline
- Location can be **auto-detected via IP** or set manually to your preferred city
- Data provided by [wttr.in](https://wttr.in/) (free, no account), refreshed every 10 minutes
- Tap the weather chip in the top bar to open the full detail modal
- Fully bilingual — descriptions in Italian or English following the widget language setting

How location selection works:

- Open **Settings** and choose whether weather should use **automatic detection** or a **manual city**
- In automatic mode, the widget resolves your approximate location from your IP and refreshes weather for that area
- In manual mode, the widget keeps using the city you entered, even after reloads or restarts
- This is useful if the display is used in a fixed setup or if IP-based detection resolves the wrong city

---

### Calendar

![Calendar month view](docs/images/calendar.png)

![Calendar day modal with event details](docs/images/calendar-2.png)

- Add, edit, and delete **events** directly on the widget
- Tap any day to open the **Day Modal** with full event details
- **Reminder toasts** pop up on screen at the configured time — no external app needed
- Data stored locally in `server/events.json` (web version) or `localStorage` (iCUE widget)

---

### Task Tracker

![Task tracker with priorities and recurrence](docs/images/tasks.png)

Part of the **Agenda** hub (Calendar · Timer · Tasks · Notes) — switch with a single tap, or pull **Tasks** out into its own standalone tile from the Layout editor.

- Add tasks with a name, a **priority level** (high / medium / low) and optional **recurrence** (daily, weekly, or every N days)
- **Colour-coded priority dots**: red for high, amber for medium, green for low
- **Colour-coded action buttons**: complete (green), undo (orange), delete (red)
- Completed tasks move to a separate section with strikethrough styling
- Recurring tasks **reset themselves automatically** when their interval elapses — no manual intervention needed
- Data stored locally in `server/tasks.json` (auto-created, gitignored)

---

### Countdown Timers

![Countdown timers with progress rings](docs/images/timers.png)

Part of the **Agenda** hub (and pullable into its own standalone tile from the Layout editor). Create timers by typing a label and a duration (`5:00`, `1:30:00`, or a plain number of minutes) and tapping **+**.

- **SVG ring arc** shows real-time progress around each timer card
- **Countdown display** updates every ~250 ms for smooth M:SS readout
- **Pause / Resume / Restart / Delete** controls on each card
- **Toast notification** slides up from the bottom when a timer finishes
- **AI integration**: press the voice orb to start a session, then say "set a 10-minute timer called Pasta" and the assistant creates it instantly
- Timers persist across server restarts (stored in `server/timers.json`)
- Up to 20 simultaneous timers

---

### Xenon AI

![Xenon AI chat panel](docs/images/xenon-ai.png)
![Xenon AI voice mode listening](docs/images/xenon-ai-2.png)
![Xenon AI response with markdown](docs/images/xenon-ai-3.png)
![Xenon AI capabilities](docs/images/xenon-ai-4.png)

An AI assistant powered by **Google Gemini** (text & vision via `gemini-3.5-flash`, spoken replies via `gemini-3.1-flash-tts-preview`). The text chat lives in the **Media tile's Chat tab**; voice mode is started from the prominent **Xenon** pill in the top bar. In voice mode the assistant is visualised as an animated **circular audio equaliser** (a ring of luminous bars around a breathing core) that reacts to its three states (listening / thinking / speaking).

#### What it can do

| Category | Commands |
|----------|----------|
| **Mic** | Toggle mute / unmute |
| **Media** | Play/pause, next, previous track |
| **Volume** | Set to any level (0 – 100) |
| **Timers** | Start named countdowns, list running timers, delete timers |
| **Notes** | Read or rewrite the scratchpad |
| **Tasks** | List tasks, create a task with priority |
| **Calendar** | List upcoming events, create a new event |
| **Screen vision** | Capture and analyse any monitor in real time |
| **Apps & web** | Open any app, website, or file by name or URL |
| **Dashboard** | Open weather, settings, app switcher, lock screen |
| **Theme** | Switch colour theme by name |
| **System** | Lock the PC, get CPU/GPU/RAM stats, check weather |

#### Voice mode — button activated

- Press the **Xenon** button in the top bar to start a session.
- Activation is **instant** — Xenon starts listening right away.
- A Siri 2026-style **conic-gradient animated border** glows around the display while listening, and the equaliser reacts to each state.
- **Master volume ducks to 20 %** while the AI listens or speaks, then restores automatically.

#### How a voice session works

1. Press the **Xenon** button in the top bar to start. Xenon listens and waits for your command, e.g. **"what's the weather tomorrow?"** or **"set a timer for 10 minutes"**.
2. Xenon thinks and then speaks the answer aloud. The spoken request is transcribed *and* answered in a single step, so the reply comes back quickly.
3. After the answer Xenon **keeps listening for a few seconds** so you can ask a follow-up straight away — no need to press the button again. Continue the conversation in the same context, or stay silent and the session closes on its own with a soft chime.

The microphone re-opens only *after* Xenon finishes speaking (never while it talks), and near-silent or noise-only clips are discarded, so the assistant's own voice is never misheard as a command.

#### Tap to interrupt (touchscreen)

During the **thinking** or **speaking** phase a **"· tap to stop"** hint appears on the voice screen. Tapping anywhere on that screen **instantly** stops playback, cancels any active recording, and exits voice mode — no need to wait for the TTS to finish.

#### Stopping a voice session

You can close a voice session in three ways:
- Tap the screen (touchscreen devices)
- Say **"stop"**, **"basta"**, **"fermati"**, or similar dismissal commands
- Wait in silence for a few seconds and the session closes automatically

#### Neural voices

Spoken answers use **Google Gemini's native neural voice** — natural and human-like, in any language. Voice replies are kept short and conversational (1-2 sentences), which keeps them quick to speak.

#### Markdown rendering

AI responses render **headings, bold/italic, bullet lists, numbered lists, inline code, and links** as formatted HTML inside the chat bubbles. Plain text and emoji display exactly as before.

#### Setup (one time only)

1. Go to **[aistudio.google.com](https://aistudio.google.com)** → create a free API key
2. Open **Settings → Xenon AI** in the dashboard → paste the key
3. Optionally enable **Risposta vocale (TTS)** to hear answers spoken aloud

The API key is stored **only on this PC** (`server/settings.json`). It is never transmitted to any other service.

#### Provider AI locale (gratuito)

Xenon AI può girare interamente sul tuo PC, gratis e senza chiave API, tramite Ollama (modello Qwen 2.5), Whisper.cpp (trascrizione) e le voci neurali Microsoft Edge. Richiede un PC adeguato: il widget esegue una scansione hardware e blocca l'opzione se non sei idoneo.

In **Impostazioni → Xenon AI** scegli il provider con il selettore **Gemini (cloud) / Locale (Ollama)**. Selezionando il provider locale compare un pannello di compatibilità che analizza RAM, VRAM e core della CPU: se il PC non è sufficiente (minimo consigliato 16 GB di RAM o una GPU con 6 GB+ di VRAM) l'opzione viene disabilitata e Gemini ripristinato. Puoi scegliere il modello (Auto / Leggero / Bilanciato / Potente / Personalizzato), verificare lo stato di Ollama, Whisper e della voce Edge, e scaricare il modello direttamente dalle Impostazioni con una barra di progresso.

I componenti locali **non vengono più scaricati dall'installer** (così l'installazione resta veloce per tutti): li configuri su richiesta da questo stesso pannello, solo quando passi al provider locale. **Whisper** (motore di trascrizione + modello vocale) si scarica direttamente nell'app con barra di progresso tramite il pulsante **Scarica Whisper**, mentre il pulsante **Installa Ollama** apre la pagina ufficiale di download di Ollama quando non è installato.

<!-- SCREENSHOT: Impostazioni → Xenon AI con il selettore provider e il pannello compatibilità hardware → docs/images/ai-local-settings.png -->

<!-- SCREENSHOT: download del modello in corso con barra di progresso → docs/images/ai-local-pull.png -->

---

### Notes

![Notes scratchpad panel](docs/images/notes.png)

- Inline, always-visible **scratchpad** — just tap and type
- **Auto-saves** on every keystroke; survives server restarts
- Plain text, no formatting needed

---

### App Switcher

![App switcher window list](docs/images/app-switcher.png)
![App switcher favorite shortcuts](docs/images/app-switcher-2.png)

- Lists all currently **open top-level windows**
- **Tap to bring any window to the foreground** — great for switching context from the touchscreen
- **Favorite app shortcuts** — save URLs or deep links to your most-used apps

---

### Focus Lock Screen

![Focus lock screen with animated clock](docs/images/lock-screen.png)

An internal, client-side overlay that dims everything into a distraction-free view — separate from the Windows PC lock.

- Activated via the **Focus button** (lock icon) in the top bar; dismissed with a tap or Esc
- **Animated clock** — digits bounce on change, colon pulses, clock breathes
- Configurable **widgets** (all independently toggleable in Settings):
  - **Clock** — large live time display with optional seconds / AM-PM
  - **Now Playing card** — album art, title, artist, playback controls
  - **Upcoming Events** — next 1–3 calendar events with date and time
  - **Weather summary** — current condition icon and temperature
- When only the Now Playing card is active, it expands to fill the full screen

---

### Deck

A programmable, Stream Deck-style key grid you can add to any dashboard page (and duplicate like every other widget) — restyled to look and feel like a real physical device.

- **Tactile, lit keys**: glossy LCD caps in a matte chassis with a soft RGB underglow. Keys **press in** on tap, **lift and brighten** on hover, **flash** while an action runs, and **light up and breathe** when active — a coloured key glows in its accent, an OBS recording key pulses green, a live one red.
- **Pick your key size — it fits the tile**: an edit-mode toolbar (✎) offers **Small / Medium / Large** keys. With **Auto** on (default) the Deck shows exactly as many keys as fit the current tile size; turn Auto off to set the **columns and rows** by hand with steppers. Your keys are never dropped when the grid changes.
- **Built-in music screen**: flip on **Musica** to dock a now-playing **LCD-style screen** under the keys — album art, title/artist and previous / play-pause / next, tinted by the cover's colours (the same transport used in the AI chat). It hides itself when nothing is playing.
- **Build your own keys**: in edit mode add keys with a title, emoji/image icon and accent colour; turn a key into a **folder**; add/remove **pages**; and assign **typed actions** — open an app, file or URL, media and mic/volume controls, OBS scene/record/stream, Xenon AI, and remote-control actions. A single key can run a **tap / double-tap / hold** trigger and even a **multi-step sequence** with delays. Layouts are saved locally, per instance.
- **Profiles**: keep separate key sets — e.g. streaming, work, gaming — as **profiles**. Tap the profile name in the faceplate header to **switch** instantly; in edit mode you can **create**, **rename** (inline) and **delete** profiles (the last one is always kept). Each profile has its own keys, folders and pages, saved per instance. You can also **switch profile by voice or chat** through Xenon AI ("switch to my streaming profile").

---

### Remote Control

Turn your phone into a full remote control of the PC — see the screen and use mouse and keyboard — **even when you're away from home**. Configured entirely from **Settings → Controllo Remoto**, and **off until you opt in**.

- **Command centre, not a reinvention**: the dashboard orchestrates two mature, free tools instead of reinventing them — **Sunshine** (open-source streaming host: screen capture, hardware video encoding, mouse/keyboard input, multi-monitor) and **Tailscale** (secure access from outside your home with no open ports). On the phone you use the free **Moonlight** app.
- **Guided, one-place setup**: install Sunshine and Tailscale (via Windows **winget**, official sources), sign in to your Tailscale account, configure Sunshine, and pair your phone with a **PIN** — all from the touchscreen. The dashboard does the technical work; you confirm.
- **Opt-in and transparent**: nothing is downloaded or installed until you open the tab, read what it does, and choose to configure it. Setup needs **one Windows UAC confirmation** and a sign-in to **your own** Tailscale account.
- **Private by design**: the dashboard's local server is **never exposed to the internet**. Your phone talks **directly to Sunshine over your encrypted Tailscale network** — the remote-control traffic never passes through the dashboard or any cloud, and there are no open ports.
- **Always in control**: a one-tap **kill-switch** disconnects any paired device instantly, and you can disable the whole feature (and uninstall the tools) at any time.
- **Live control panel**: once configured, Settings → Controllo Remoto shows a live control panel — choose which monitor Moonlight streams, disconnect an active session, and block or reactivate remote access, all without touching the setup wizard.
- **Addable dashboard widget**: the Remote Control panel is also available as a regular dashboard tile — add it to any page from the "+" palette and duplicate it like any other widget. Shows the same live state as Settings; prompts you to configure if not yet set up.
- **Deck actions**: three Deck keys are available — **Disconnect remote session**, **Block/reactivate remote access**, and **Cycle streamed monitor** — plus a **connected-state** key that lights up when a device is actively streaming. All appear in the key editor only when remote access is configured.

> Requires a free [Tailscale](https://tailscale.com/) account and the free [Moonlight](https://moonlight-stream.org/) app on the phone. [Sunshine](https://github.com/LizardByte/Sunshine) and Tailscale are installed for you from the Settings tab.

---

### Streaming (Twitch & YouTube)

Connect your **Twitch** and **YouTube** accounts to control your stream from the dashboard and Deck — create Twitch clips, markers and ads, go live / end stream and switch scenes via OBS, watch your viewer count, and read Twitch chat live.

- **Connect from the dashboard**: **Settings → Streaming** has a card per service. The first time, paste your app credentials right there (Twitch **Client ID**; YouTube **Client ID + Secret**) and tap **Save** — no config files to edit. Then tap **Connect** and authorise on your phone or PC with a short code (no password typed on the touchscreen).
- **Your accounts, your credentials**: each user registers their own free Twitch app and Google Cloud project, so nothing is shared or hard-coded. Tokens stay on your PC (`server/stream-tokens.json`), never sent to the browser.
- **One-time setup guide**: step-by-step for both services — including the easy-to-miss Google "test user" step — is in **[docs/streaming-setup.md](docs/streaming-setup.md)**.

> Twitch needs only a free app registration (Public client). YouTube uses a Google Cloud OAuth client (type *TVs and Limited Input devices*) with the YouTube Data API enabled; while the Google app is in Testing mode you add yourself as a test user and re-authorise about weekly (a Google policy). See the setup guide for details.

---

### Settings

![Settings panel with themes and customization](docs/images/settings.png)

<!-- TODO screenshot: nuova scheda "Performance" delle impostazioni (toggle Game mode).
     Salva l'immagine come docs/images/settings-performance.png e poi togli il commento alla riga sotto. -->
<!-- ![Settings Performance tab with Game mode toggle](docs/images/settings-performance.png) -->

- **Theme** — **Light / Dark / Auto**. Auto follows your Windows app theme, read reliably from the registry server-side (the embedded WebView's `prefers-color-scheme` is unreliable), and updates within ~30s when you change it; your chosen accent colour applies to both schemes (Dark is the default). On Windows the relevant setting is *Settings → Personalization → Colors → "Choose your default app mode"*
- **Background effects** — two optional, GPU-light ambient layers, each with colour / intensity / speed and an on-off toggle: **Aurora** (soft flowing accent gradients, shown only when no custom image/video background is set) and **Grid** (a neon perspective grid scrolling toward a glowing horizon). Both stop automatically when the system "reduce motion" setting is on
- **Game mode** — when a game is running full-screen, the animated background and the Xenon AI button's glow automatically pause and fade out, so the widget stops competing with the game for the GPU; they resume when you exit. Detection keys on the **foreground full-screen window** (a game owns the foreground and covers its whole monitor with no title bar) — far more reliable than frame-rate guessing: maximized desktop apps, the dashboard's own browser host, iCUE/Corsair and other continuously-rendering apps are all excluded, so game mode never stays on by itself. Needs no extra tools or admin rights. On by default, with a toggle in Settings → Performance. PresentMon is an optional install used only for the in-game FPS readout — game mode works without it
- **Language** — Italian / English / Korean / Japanese / Chinese, switchable on the fly
- **Clock format** — 12 h / 24 h, show or hide seconds
- **Weather location** — choose automatic detection or enter a city manually, then keep that location saved
- **Temperature unit** — switch every temperature between **°C** and **°F**; the choice is saved
- **Color presets** — one-click themes: Xenon (green), Ocean (cyan), Ember (orange), Violet, Mono
- **Color personalization** — accent color, text color, background color (hex input + live preview)
- **Accent from album art** — while music plays, the accent colour follows the cover of the current track (a prominent, hue-faithful colour, smoothly cross-faded); near-greyscale covers and stopped playback fall back to your chosen accent. The same colour can also drive your Corsair RGB lighting (**Settings → Illuminazione → Album → colore LED**) — this LED effect works on its own, independent of the main RGB bridge toggle, and hands control back to iCUE when the music stops. The theme is on by default; the LED effect is opt-in (off by default). Both are separately toggleable and run on-device
- **Surface controls** — panel opacity down to 18%, background dim and blur, with softer borders and readability protection for bright custom backgrounds
- **Xenon AI** — paste your Gemini API key once; shows a full capabilities guide, setup steps, privacy notice, and a link to Google AI Studio; toggle TTS on/off
- **Background media** — upload a custom image (JPG, PNG, WebP, GIF) or video (MP4, WebM, up to 200 MB); MP4 files are automatically converted to WebM when FFmpeg is available
- **Lock Screen widgets** — enable / disable each tile individually
- All preferences stored under `xeneonedge.settings.v1` in `localStorage`

---

### Top Bar

![Top bar with clock and quick actions](docs/images/topbar.png)

Redesigned from scratch for clarity on a touchscreen — every action is a clear **labelled button** (icon **+** text), so there is nothing cryptic to memorise. Labels collapse back to icons only on very narrow widths.

- **Big centred live clock** (configurable format) with a pulsing accent colon
- A prominent **weather chip** with a **live animated condition icon** (sun, moon, clouds, rain, snow…), a large temperature, and a soft colour tint matching the current weather — tap to open the full weather modal
- **Lock** (Windows lock) · **Focus** (distraction-free lock screen) on the left
- **Layout** (customize the dashboard) · **Settings** · **Apps** (open-window switcher + favourites) on the right

---

## Installation

XenonEdge Hub runs as a tiny local Node.js server (`http://127.0.0.1:3030/`) and is embedded in iCUE as an **iFrame** widget.
It includes the full feature set: microphone control, audio device switching, app switcher, weather, and more.

#### Step 1 — Run the installer (once)

1. Download the ZIP from **[Releases](https://github.com/marcimastro98/XenonEdgeWidget/releases/latest)** and extract it anywhere.
2. Open the extracted folder.
3. Double-click **`INSTALL.bat`**.
4. If Windows asks permission to install Node.js, click **Yes**.

The installer automatically:
- installs **Node.js LTS** if missing;
- installs **FFmpeg** if missing, so MP4 backgrounds can be converted automatically for iCUE;
- downloads **PresentMon** into `server/presentmon/` for the real in-game FPS counter;
- registers the server to **start silently with Windows** (no terminal, no tray icon);
- starts the server immediately;
- opens `http://127.0.0.1:3030/` in your browser so you can confirm it works.

> The installer **does not download Ollama or Whisper.cpp** — this keeps first-time setup fast. The free local AI provider is set up on demand from **Settings → Xenon AI** when you switch to it: **Whisper** downloads in-app with a progress bar (the "Download Whisper" button), Ollama is installed from its official page (the "Install Ollama" button), and the chat model is downloaded from the same panel.

<!-- SCREENSHOT: output dell'installer con i passaggi Ollama/Whisper → docs/images/installer-local-ai.png -->

#### Step 2 — Add an iFrame widget in iCUE (once)

1. Open **Corsair iCUE**.
2. On your Xenon Edge dashboard, add an **iFrame** widget.
3. Paste one of the following **full `<iframe>` tags** and save:

| What you want to show | iFrame HTML to paste |
|---|---|
| Full dashboard (all panels) | `<iframe src="http://127.0.0.1:3030/" width="100%" height="100%" frameborder="0"></iframe>` |
| Media only | `<iframe src="http://127.0.0.1:3030/?panel=media" width="100%" height="100%" frameborder="0"></iframe>` |
| Microphone only | `<iframe src="http://127.0.0.1:3030/?panel=mic" width="100%" height="100%" frameborder="0"></iframe>` |
| Notes only | `<iframe src="http://127.0.0.1:3030/?panel=notes" width="100%" height="100%" frameborder="0"></iframe>` |
| Tasks only | `<iframe src="http://127.0.0.1:3030/?panel=tasks" width="100%" height="100%" frameborder="0"></iframe>` |
| System monitor only | `<iframe src="http://127.0.0.1:3030/?panel=system" width="100%" height="100%" frameborder="0"></iframe>` |
| Audio devices & volume only | `<iframe src="http://127.0.0.1:3030/?panel=audio" width="100%" height="100%" frameborder="0"></iframe>` |

Size **XL** is recommended for the full dashboard.

#### Background videos in iCUE

iCUE's embedded WebView can reject some MP4 files even when the same video plays correctly in Chrome. To avoid manual conversion, XenonEdge Hub handles this automatically:

- Upload **JPG, PNG, WebP, GIF, MP4 or WebM** files from Settings -> Background media.
- **MP3/audio files are not supported** because the background layer is visual only.
- When you upload an **MP4**, the server converts it to **WebM VP8 at 30 FPS** when FFmpeg is available.
- `INSTALL.bat` installs FFmpeg automatically through winget when possible.
- If you start the server manually and MP4 conversion is unavailable, install FFmpeg once with:

```powershell
winget install --id Gyan.FFmpeg.Essentials --exact --source winget --accept-package-agreements --accept-source-agreements
```

After installing FFmpeg, restart the server and upload the original MP4 again. Existing MP4 uploads are not converted retroactively. The upload limit is **200 MB**.

#### Every time you start your PC after that

> **Nothing.** The server starts silently in the background; iCUE remembers your layout. The widget is live before you even open iCUE.

To remove the startup entry, double-click **`UNINSTALL.bat`**.

## Requirements

- Windows 10 or 11 (x64)
- [Node.js 18.15 or newer](https://nodejs.org/) — installed automatically by `INSTALL.bat`
- [FFmpeg](https://ffmpeg.org/) — installed automatically by `INSTALL.bat` when winget is available; used for automatic MP4 → WebM background conversion and audio capture for wake-word detection
- [NirCmd](https://www.nirsoft.net/utils/nircmd.html) — bundled; used for screen capture (Xenon AI vision)
- [PresentMon](https://github.com/GameTechDev/PresentMon) — **downloaded automatically by `INSTALL.bat`** into `server/presentmon/` (and removed by `UNINSTALL.bat`); powers the real in-game FPS counter, including exclusive-fullscreen games. The startup task runs elevated, which PresentMon needs (ETW tracing). If the download is unavailable the FPS counter falls back to a DWM reading that only works for windowed/borderless games — everything else is unaffected.
- [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) — installed automatically by `INSTALL.bat` when winget is available; used for CPU temperature readings (the widget falls back gracefully when it is absent)
- [PawnIO](https://github.com/namazso/PawnIO) — installed automatically by `INSTALL.bat` when winget is available; required by some CPU sensors. Accept the administrator prompt from `INSTALL.bat` so the startup task can read protected hardware sensors.
- *(Optional, for local AI)* [Ollama](https://ollama.com) and [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) — **not** installed by `INSTALL.bat`; they are set up on demand from **Settings → Xenon AI** only when you switch to the free local AI provider. Whisper.cpp downloads in-app into `server/whisper/` with a progress bar, Ollama is installed from its official download page, and the chat model is downloaded from the same panel.
- *(Optional, for Remote Control)* [Sunshine](https://github.com/LizardByte/Sunshine) and [Tailscale](https://tailscale.com/) — **not** installed by `INSTALL.bat`; they are installed for you (via winget, official sources) on demand from **Settings → Controllo Remoto** only when you opt in. On the phone you use the free [Moonlight](https://moonlight-stream.org/) app. Needs a free Tailscale account and one UAC confirmation during setup.
- *(Optional)* `nvidia-smi` is auto-detected for NVIDIA GPU usage and temperature
- *(Optional, for Xenon AI)* A free **Gemini API key** from [Google AI Studio](https://aistudio.google.com) — enter it once in Settings → Xenon AI. Everything else works without it.

The bundled [`SoundVolumeView`](https://www.nirsoft.net/utils/sound_volume_view.html) by NirSoft handles audio device control and is shipped unmodified under its freeware license.

## Developer quick start

```powershell
git clone https://github.com/marcimastro98/XenonEdgeWidget.git
cd XenonEdgeWidget
npm start
```

Then open <http://127.0.0.1:3030/> in any browser, or paste a full `<iframe>` tag that points to the same URL into a Corsair iCUE **iFrame** widget.

You can also double-click `INSTALL.bat` for the full user-friendly setup. It asks for administrator permission so hardware sensor support and the Windows startup task can be configured correctly. Use `server/start.bat` only if Node.js is already installed and you want to start the server manually.

If you use `npm start` instead of `INSTALL.bat`, install FFmpeg yourself if you want MP4 backgrounds to be converted automatically for iCUE.

> The server listens **only** on `127.0.0.1:3030` and rejects requests whose `Host` header is not loopback, to prevent DNS-rebinding / CSRF abuse from public websites.

## HTTP API (loopback only)

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/` | Serve the widget HTML. |
| `GET`  | `/status` | Mic mute state. |
| `POST` | `/toggle` | Toggle mic mute. |
| `GET`  | `/audio` | Audio devices, default speaker / mic, volumes. |
| `POST` | `/volume/set` | `{ level: 0–100 }` set speaker volume. |
| `POST` | `/mic/volume` | `{ level: 0–100 }` set mic volume. |
| `POST` | `/speaker/set` | `{ id }` change default speaker. |
| `POST` | `/mic/set` | `{ id }` change default mic. |
| `POST` | `/speaker/mute` | Toggle speaker mute. |
| `POST` | `/audio/app/volume` | `{ id, level: 0–100 }` set volume for a single application audio session. |
| `POST` | `/audio/app/mute` | `{ id }` toggle mute for a single application audio session. |
| `GET`  | `/media` | Currently playing track. |
| `POST` | `/media/playpause`, `/media/next`, `/media/previous` | Transport. |
| `GET`  | `/system` | CPU, GPU, RAM, disks, temps. |
| `GET`  | `/network` | Ping, latency, bandwidth. |
| `GET`  | `/weather` | Current conditions, 3-day forecast, hourly forecast (cached 10 min, sourced from wttr.in). |
| `GET`  | `/windows` | List visible top-level windows. |
| `POST` | `/windows/focus` | `{ id }` bring a window to the foreground. |
| `GET` / `POST` | `/notes` | Read / save the notepad. |
| `GET` / `POST` | `/events` | Read / save calendar events. |
| `GET` / `POST` | `/tasks` | Read / save task list (max 100 tasks). |
| `GET` | `/api/timers` | List all active timers. |
| `POST` | `/api/timers` | Create a new countdown timer. Body: `{ label, duration_secs }`. |
| `PATCH` | `/api/timers/:id` | Control a timer. Body: `{ action: "pause" | "resume" | "reset" }`. |
| `DELETE` | `/api/timers/:id` | Delete a timer. |
| `POST` | `/api/ai` | Send a message to Gemini AI with full function-calling support. |
| `GET` | `/api/screenshot` | Capture a live screenshot (optional `?x=&y=&w=&h=` for multi-monitor). |
| `POST` | `/api/chime` | Play an audio chime. Body: `{ kind: "wake" | "deactivate" }`. |
| `POST` | `/api/volume/duck` | Duck master volume to 20 % for voice sessions. |
| `POST` | `/api/volume/restore` | Restore master volume after ducking. |
| `GET`  | `/sse` | Server-Sent Events stream: `status`, `media`, `system`, `audio`, `wake_word`, `timer_update`, `timer_done`, `stop_session`. |
| `POST` | `/lock` | Lock the workstation. |
| `GET`  | `/remote/status` | Remote Control: aggregated status (tools installed, Tailscale connection + IP, Sunshine responding, connected clients). Never returns secrets. |
| `POST` | `/remote/install` | Install a tool via winget. Body: `{ tool: "sunshine" \| "tailscale" }`. |
| `POST` | `/remote/tailscale/login` | Start the Tailscale account sign-in (opens the browser). |
| `POST` | `/remote/sunshine/configure` | Configure Sunshine with locally generated credentials. |
| `POST` | `/remote/pin` | Pair a phone. Body: `{ pin }`. |
| `POST` | `/remote/kill` | Kill-switch: disconnect all paired devices. |
| `POST` | `/remote/enable`, `/remote/disable` | Enable / disable the Remote Control feature. |
| `POST` | `/background` | Upload a background image or video (multipart/form-data, max 200 MB). Accepted: JPG, PNG, WebP, GIF, MP4, WebM. MP4 uploads are converted to WebM when FFmpeg is available. Returns `{ url, type, conversion }`. |
| `GET`  | `/uploads/<file>` | Serve a previously uploaded background file, including byte-range streaming for video playback. |

## File layout

```
XenonEdgeWidget/
├── INSTALL.bat                  ← One-click installer for normal users
├── UNINSTALL.bat                ← Removes startup entry and stops the server
├── package.json
├── README.md
├── LICENSE
│
├── docs/
│   └── images/                  ← Screenshots used in this README
│
├── server/                      ← Node.js web widget (port 3030)
│   ├── server.js                ← HTTP API server
│   ├── index.html               ← Full UI shell
│   ├── widget.html              ← Legacy single-file UI (embeddable)
│   ├── start.bat                ← Double-click launcher
│   ├── start-hidden.vbs         ← Hidden startup launcher (Task Scheduler)
│   ├── install.ps1              ← Installer logic
│   ├── uninstall.ps1            ← Uninstaller logic
│   ├── media.ps1                ← Now-playing via Windows SMTC
│   ├── gpu.ps1                  ← GPU usage / temperature (NVIDIA + WMI)
│   ├── network.ps1              ← Ping + adapter byte counters
│   ├── fpsmon.js                ← Real in-game FPS via PresentMon (optional)
│   ├── windows.ps1              ← Window enumeration / focus
│   ├── notes.txt                ← Notes data (auto-created, gitignored)
│   ├── events.json              ← Calendar data (auto-created, gitignored)
│   ├── tasks.json               ← Task tracker data (auto-created, gitignored)
│   ├── timers.json              ← Timer state (auto-created, gitignored)
│   ├── settings.json            ← User settings incl. Gemini key (auto-created, gitignored)
│   ├── uploads/                 ← User-uploaded backgrounds (auto-created, gitignored)
│   ├── js/                      ← Frontend JS modules (media, calendar, notes, …)
│   ├── components/              ← Per-panel CSS components
│   ├── styles/                  ← Global CSS + breakpoints
│   └── soundvolumeview-x64/
│       └── SoundVolumeView.exe  ← Audio device control (NirSoft, freeware)
│
└── widget/                      ← Native iCUE widget (Elgato Marketplace)
    ├── manifest.json
    ├── index.html               ← Widget entry point
    ├── translation.json         ← EN / IT strings
    ├── styles/main.css
    ├── modules/                 ← JS modules (sensors, media, calendar, …)
    ├── components/              ← HTML partial templates
    ├── common/plugins/          ← Official iCUE SDK plugin wrappers
    └── resources/icon.svg
```

## Security notes

- The server binds to `127.0.0.1` only and validates the `Host` and `Origin` headers — public websites cannot reach it via DNS rebinding.
- No CORS wildcards: everything is same-origin.
- Inputs to `/windows/focus`, `/shortcut`, `/notes`, `/events` are validated and capped.
- Bundled `SoundVolumeView.exe` is unmodified; you may verify it against [NirSoft's official download](https://www.nirsoft.net/utils/sound_volume_view.html).

## Troubleshooting

- **`node` not recognised** — install Node.js 18+ and reopen your terminal.
- **Port 3030 already in use** — close any other widget instance, or change the port in `server/server.js`.
- **No CPU temperature** — rerun `INSTALL.bat` and accept the administrator prompt so it can install LibreHardwareMonitor/PawnIO and register the Windows startup task with elevated sensor access.
- **Mic mute does nothing on first launch** — wait one or two seconds: the device cache is populated right after startup.

## Support

**Found a bug?** Open a [Bug Report](https://github.com/marcimastro98/XenonEdgeWidget/issues/new?template=bug_report.md) and include:
- your Windows version (Win 10 / Win 11);
- what you did and what happened instead;
- any error text visible in the window that appeared when you ran `INSTALL.bat`.

**Have an idea or suggestion?** Open a [Feature Request](https://github.com/marcimastro98/XenonEdgeWidget/issues/new?template=feature_request.md) — all feedback is welcome.

**If this widget saved you some time and you want to say thanks:**
[☕ Buy me a coffee via PayPal](https://www.paypal.me/MarcelloMastroeni) — no pressure, always appreciated.

## A note on AI assistance

This project was built with AI assistance throughout — architecture decisions, code generation, debugging, and documentation. That said, every feature was designed, tested, and iterated on hands-on: the ideas, the product direction, and every decision about what ships are mine. AI was a tool, not the author.

## License

[MIT](LICENSE). Includes [SoundVolumeView](https://www.nirsoft.net/utils/sound_volume_view.html) © Nir Sofer (freeware, redistributed unmodified).
