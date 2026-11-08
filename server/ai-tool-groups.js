'use strict';
// Bit's tools by group. Every chat turn used to carry every tool: past 128 the
// hub (and OpenAI) refuse the request, and each tool is paid for on every round.
// So a core goes on every turn, the rest waits in groups, and the model asks for
// a group with use_tools when a request needs it. The groups a conversation
// loaded ride back to the client and return with its next turn, in the order
// they were loaded, so the cached prefix (core first) holds from turn to turn.
// Claude Code and Codex reach the tools through MCP and keep the full list.

// Anthropic finds an earlier cache entry only up to 20 blocks back: a group
// larger than that would make the core be written to the cache again.
const GROUP_MAX = 20;
const TOOL_CAP = 128;

const GROUPS = Object.freeze({
  capture: {
    about: 'screenshots, reading text on screen, pinning a shot, blurring private data, picking a colour, measuring, drawing on screen, a bug report',
    tools: ['take_screenshot', 'read_screen_text', 'pin_screenshot', 'cover_private_data', 'pick_screen_color', 'measure_screen', 'draw_on_screen', 'make_bug_report'],
  },
  recording: {
    about: 'recording the screen, step guides, timelapses, instant replay, markers and clips, the gallery, transcripts and chapters, exporting or sending a capture',
    tools: ['record_steps', 'record_screen', 'record_timelapse', 'set_recording_options', 'save_replay', 'add_capture_marker', 'make_clips_from_marks', 'set_instant_replay', 'open_gallery', 'list_captures', 'transcribe_recording', 'save_recording_chapters', 'export_capture', 'send_capture_to_phone', 'copy_capture_to_folder'],
  },
  games: {
    about: 'game FPS and stutter, game sessions, the performance tile, benchmarks, power modes, the game companion, boosting or restoring performance',
    tools: ['get_game_performance', 'explain_stutter', 'get_game_session_stats', 'compare_game_sessions', 'manage_game_sessions', 'set_perf_tile', 'run_benchmark', 'set_power_mode', 'get_power_status', 'open_game_companion', 'optimize_performance', 'restore_performance'],
  },
  screen_widgets: {
    about: 'widgets on the PC screen (on the desktop, over games, attached to an app): place, move, group, edit, show or hide them, their shortcuts (one per widget too), their pages',
    tools: ['place_widget', 'attach_widget_to_app', 'remove_layer_widget', 'move_layer_widget', 'group_layer_widgets', 'list_layer_widgets', 'edit_layer_widgets', 'toggle_layer_widgets', 'set_overlay_shortcut', 'set_widget_key', 'switch_widget_page', 'manage_widget_pages'],
  },
  desktop: {
    about: 'the PC desktop and Xenon around it: wallpaper, screensaver, do not disturb, notifications, screen alerts, keyboard shortcuts, the Xenon menu, usage mode, the voice edge glow',
    tools: ['set_voice_edge_glow', 'set_usage_mode', 'open_xenon_menu', 'set_desktop_wallpaper', 'set_pc_screensaver', 'set_screen_alerts', 'set_do_not_disturb', 'set_notifications', 'set_key_shortcut', 'set_widget_function_key', 'list_key_shortcuts'],
  },
  lighting_effects: {
    about: 'RGB effects and animations, lights that react to events, the lighting bridge (a plain colour or lights off need no group)',
    tools: ['set_effect', 'set_event_effect', 'set_animation', 'set_lighting_bridge'],
  },
  // deck_action_catalog stays in the core: run_deck_action looks action types up in it.
  create: {
    about: 'making something new: a widget (or changing one of the user\'s), a readout in the top bar or the island, a theme or style, an animated background, a Deck profile, any other creation as a share code, the model creations use',
    tools: ['create_widget', 'my_widgets', 'sdk_reference', 'preset_reference', 'create_preset', 'create_dashboard_style', 'create_animated_background', 'configure_deck', 'set_creation_model'],
  },
});

const GROUP_OF = new Map();
for (const [id, g] of Object.entries(GROUPS)) for (const name of g.tools) GROUP_OF.set(name, id);

const USE_TOOLS = Object.freeze({
  name: 'use_tools',
  description: 'Load more tools for this conversation, one group at a time, when the request needs one; the tools are there from your next step. Groups: '
    + Object.entries(GROUPS).map(([id, g]) => id + ' (' + g.about + ')').join('; ')
    + '. Anything else already has its tool.',
  parameters: { type: 'OBJECT', properties: { group: { type: 'STRING', enum: Object.keys(GROUPS) } }, required: ['group'] },
});

function cleanGroups(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((g) => typeof g === 'string' && Object.hasOwn(GROUPS, g)))];
}

// `all`: every tool this turn could offer. → { tools, call, groups }. `tools` is
// the list to send, one array changed in place, so a loop that reads it each
// round sees a group as soon as it is loaded.
function kit(all, wanted) {
  const byName = new Map(all.map((t) => [t.name, t]));
  const core = all.filter((t) => !GROUP_OF.has(t.name));
  const loaded = [];
  const tools = [];
  const rebuild = () => {
    const next = core.concat(USE_TOOLS);
    for (const id of loaded) for (const name of GROUPS[id].tools) if (byName.has(name)) next.push(byName.get(name));
    tools.splice(0, tools.length, ...next);
  };
  const size = (id) => GROUPS[id].tools.filter((n) => byName.has(n)).length;
  const load = (id) => {
    if (loaded.includes(id)) return false;
    loaded.push(id);
    // The oldest group goes first when the cap would be passed; the core never does.
    while (loaded.length > 1 && core.length + 1 + loaded.reduce((n, g) => n + size(g), 0) > TOOL_CAP) loaded.shift();
    rebuild();
    return true;
  };
  for (const id of cleanGroups(wanted)) load(id);
  if (!tools.length) rebuild();

  // `run` executes a real tool. use_tools is answered here; a tool of a group
  // not loaded yet (a model may know it from the instructions) still runs, and
  // its group comes along for the next step.
  async function call(name, args, run) {
    if (name !== USE_TOOLS.name) {
      if (GROUP_OF.has(name)) load(GROUP_OF.get(name));
      return run();
    }
    const id = args && args.group;
    if (typeof id !== 'string' || !Object.hasOwn(GROUPS, id)) {
      return { fnResult: { ok: false, error: 'unknown_group', groups: Object.keys(GROUPS) }, clientActions: [] };
    }
    const fresh = load(id);
    const names = GROUPS[id].tools.filter((n) => byName.has(n));
    return { fnResult: fresh ? { ok: true, group: id, tools: names } : { ok: true, group: id, already: true, tools: names }, clientActions: [] };
  }

  return { tools, call, groups: () => loaded.slice() };
}

// A provider loop's converted tool list that follows `list` (a kit's tools):
// converted again only when a group was loaded since the last round.
function follow(list, convert) {
  const src = Array.isArray(list) ? list : [];
  let at = -1;
  let out = [];
  return () => {
    if (src.length !== at) { out = convert(src); at = src.length; }
    return out;
  };
}

// Voice Live fixes its tools when the session opens: the core, then whole
// groups in this order while they fit.
function forLive(all) {
  const byName = new Map(all.map((t) => [t.name, t]));
  const out = all.filter((t) => !GROUP_OF.has(t.name));
  for (const g of Object.values(GROUPS)) {
    const extra = g.tools.filter((n) => byName.has(n)).map((n) => byName.get(n));
    if (out.length + extra.length <= TOOL_CAP) out.push(...extra);
  }
  return out.slice(0, TOOL_CAP);
}

module.exports = { GROUPS, GROUP_MAX, TOOL_CAP, USE_TOOLS, cleanGroups, kit, follow, forLive };
