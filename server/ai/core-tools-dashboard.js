// The tools the assistant always has for the dashboard itself: its panels, Performance Mode,
// timers, opening programs and finding files.

function dashboardAiFunctions() {
  return [
        // ── Dashboard UI ──
        { name: 'open_weather_panel', description: 'Open the weather details panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_settings', description: 'Open Xenon, the one place that holds Settings and the Xenon menu, on a page: screens (the screens, what each shows, its widgets), now (quick actions), capture, keys (shortcuts and macros), or a page of Settings (lock is the lock screen and Ambient, ai is Bit). Without a page it opens where it was.', parameters: { type: 'OBJECT', properties: { page: { type: 'STRING', enum: ['screens', 'now', 'capture', 'keys', 'general', 'appearance', 'island', 'background', 'notifications', 'lock', 'ai', 'bit', 'weather', 'stocks', 'calendar', 'slideshow', 'claude', 'lighting', 'smarthome', 'unifi', 'spotify', 'streaming', 'browser', 'search', 'secondscreen', 'phone', 'remote', 'performance', 'sdk', 'support', 'about'] } } } },
        { name: 'open_app_switcher', description: 'Open the app switcher panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_whats_new', description: "Open What's New: the full-screen sheets of the version running now. Use when the user asks what changed, what is new, or to see the news of this version again.", parameters: { type: 'object', properties: {} } },
        { name: 'open_store_entry', description: "Open one creation in the Store by its entry id. Use when the user wants to see something Bit told them about: the conversation memory gives the entry id. It only opens the page; installing and buying stay with the user there.", parameters: { type: 'OBJECT', properties: { entryId: { type: 'STRING', description: 'The Store entry id' } }, required: ['entryId'] } },
        { name: 'open_sparks_shop', description: "Open the Store's Sparks tab: where Sparks (Xenon's credits) are bought, with what they are for. Use when the user wants to buy or top up Sparks, or asks where to get them.", parameters: { type: 'OBJECT', properties: {} } },
        { name: 'start_ambient_mode', description: 'Open the Ambient/screensaver mode (fullscreen scene with clock, media, weather: the old focus lock screen)', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'stop_ambient_mode', description: 'Close the Ambient/screensaver mode if it is showing', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'change_theme', description: 'Change the dashboard color theme (xenon, ocean, ember, violet, mono)', parameters: { type: 'OBJECT', properties: { preset: { type: 'STRING', description: 'Theme name' } }, required: ['preset'] } },
        { name: 'close_ai_panel', description: 'Close the Xenon AI chat panel', parameters: { type: 'OBJECT', properties: {} } },
        // ── Performance Mode ──
        { name: 'optimize_performance', description: 'Open Performance Mode optimization (shows the confirmation sheet listing what will be done). Use when the user asks to optimize performance, free up resources, or boost the PC for gaming/work. It never applies anything without the user confirming on the sheet.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'restore_performance', description: 'Undo Performance Mode: restore the previous power plan, resume animations, put back the apps moved out of the game\'s way, and reopen any apps that were closed. Use when the user asks to restore performance settings or undo the optimization.', parameters: { type: 'OBJECT', properties: {} } },
        // ── Timers ──
        { name: 'start_timer', description: 'Start a new countdown timer ("set a timer for 5 minutes", "remind me in 30 seconds") or a stopwatch that counts up ("start a stopwatch", with kind stopwatch and no duration).', parameters: { type: 'OBJECT', properties: {
          label: { type: 'STRING', description: 'Short label for the timer, e.g. "Pasta", "Break", "Meeting"' },
          kind: { type: 'STRING', description: 'countdown (default) or stopwatch' },
          duration_secs: { type: 'NUMBER', description: 'Countdown length in seconds (e.g. 300 for 5 minutes, 3600 for 1 hour). Not for a stopwatch.' },
          chime_every_secs: { type: 'NUMBER', description: 'Stopwatch only: sound a chime every N seconds (e.g. 60). Leave out for none.' },
        } } },
        { name: 'control_timer', description: 'Pause, resume, restart or stop a timer or stopwatch already on the Timers tile. "stop" puts it back to its start and holds it there; to remove it use delete_timer. With no timer named it acts on the only one there is, or the newest one that is running (pause) or paused (resume); when that is unclear the reply lists the labels to ask about.', parameters: { type: 'OBJECT', properties: {
          action: { type: 'STRING', description: 'pause, resume, reset (from the start, counting) or stop' },
          timer: { type: 'STRING', description: 'Its label as the user says it, or its id from list_timers. Leave out when there is one timer.' },
        }, required: ['action'] } },
        { name: 'list_timers', description: 'List all active timers and stopwatches: a countdown reports remaining_secs, a stopwatch reports elapsed_secs', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'delete_timer', description: 'Delete a timer by its id', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Timer id to delete' },
        }, required: ['id'] } },
        // ── System launcher ──
        { name: 'open_application', description: 'Open an app, website, or file on the user\'s PC. For well-known apps use their plain name (spotify, chrome, notepad, obs, vlc…). For Steam use exactly "steam", for Discord use "discord". Full URLs (https://…) and absolute file paths also work.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name (e.g. "spotify", "steam", "discord"), full URL, or absolute file path' },
        }, required: ['target'] } },
        { name: 'close_application', description: 'Close / terminate a running application on the user\'s Windows PC. Use the plain app name (e.g. "spotify", "chrome", "notepad", "discord", "steam", "obs", "vlc"). Works for any process.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name to close, e.g. "spotify", "chrome", "discord"' },
        }, required: ['target'] } },
        // ── Local file search ──
        { name: 'search_files', description: 'Search files on the user\'s PC by name and (where Windows indexed it) content: all local, nothing leaves the machine. The query understands natural filters in EN/IT: kind ("photos"/"foto", "documents"), extensions ("pdf", "excel"), dates ("last month", "dicembre 2024", "ieri"), sizes ("more than 100 mb", "grandi"). Use for "find my rental contract", "cerca le foto di dicembre", "il pdf della fattura". Returns top results each with an id: to open one, call open_search_result with that id.', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'The search phrase, in the user\'s own words (e.g. "contratto affitto pdf", "foto di dicembre")' },
        }, required: ['query'] } },
        { name: 'open_search_result', description: 'Open one result returned by search_files, by its id (default app for files, Explorer for folders). Executable/script files are refused for safety: pass reveal:true to show the file selected in its folder instead, which runs nothing.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'The result id from search_files' },
          reveal: { type: 'BOOLEAN', description: 'true to reveal the file in Explorer instead of opening it' },
        }, required: ['id'] } },
        { name: 'phone_lookup', description: 'Look somebody up in the phonebook of the phone paired to this PC over Bluetooth, and read the recent call log. READ-ONLY. Use it before phone_call or phone_message so the number comes from the user\'s own contacts instead of being guessed. Also answers "who called me?", "chi mi ha chiamato ieri", "che numero ha mio padre".', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'Part of a contact name to search for. Omit to get the recent call log instead.' },
        }, required: [] } },
        { name: 'phone_call', description: 'Place a real phone call through the paired phone. Use for "chiama Marco", "call mum". Prefer a name and let this resolve it against the phonebook; pass a raw number only when the user dictated one. The call is real and costs the user money, so never call somebody the user did not name.', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'The contact to call, as the user said it. Resolved against the phonebook.' },
          number: { type: 'STRING', description: 'A literal number, only when the user dictated one rather than a name.' },
        }, required: [] } },
        { name: 'phone_message', description: 'Send a text message through the paired phone. Use for "manda un messaggio a Marco", "text mum that I am late". The recipient MUST be a contact in the phonebook: a raw number is refused, because a text cannot be recalled and a wrong number reaches a stranger permanently. Read the message back to the user in your reply so they can see what was sent.', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'The contact to write to. Must match somebody in the phonebook.' },
          text: { type: 'STRING', description: 'The message, in the user\'s own words.' },
        }, required: ['name', 'text'] } },
        { name: 'disk_insights', description: 'Read a live, local disk-space analysis: volume capacity/free space, indexed usage, safe-to-clean categories (temp, browser/package caches, build output, old installers, Recycle Bin), the biggest folders/files, verified duplicate waste, and Xenon\'s risk-ranked cleanup plan with a why/effect/action explanation. READ-ONLY: you can explain and recommend, but deletion happens only when the user taps the confirmation in the disk widget, you have no delete capability. Use for "what is eating my disk", "cosa occupa spazio", "posso liberare spazio?".', parameters: { type: 'OBJECT', properties: {
          rootIndex: { type: 'INTEGER', description: 'Optional index of the configured disk/folder root to analyze. Omit for the first root.' },
        } } },
  ];
}

module.exports = { dashboardAiFunctions };
