'use strict';
// Runs the capabilities declared in js/capability-catalog.js and derives the
// surfaces that read the catalog:
//   probes()          what this machine can do, merged into /actions/catalog
//                     `capabilities` so the Deck editor hides the rest
//   aiFunctions()     Xenon AI function declarations (Gemini format; the other
//                     providers convert from it)
//   aiAction(n, a)    an AI call → the Deck action it stands for, which the
//                     caller runs through actions/registry.js like any key
//   run(action)       the effect, called by actions/registry.js AFTER
//                     validateAction — never directly from a route
//
// Effects are injected (deps) so every decision is testable without a game,
// a screen or an OS underneath.
const { CAPABILITIES } = require('../js/capability-catalog.js');
const perf = require('./perf.js');
const stutterWhy = require('./stutter-why.js');
const gameSessions = require('./game-sessions.js');
const perfHud = require('./perf-hud.js');
const benchmark = require('./benchmark.js');
const screenshot = require('./screenshot.js');
const screenText = require('./screen-text.js');
const screenPin = require('./screen-pin.js');
const screenCover = require('./screen-cover.js');
const screenInspect = require('./screen-inspect.js');
const screenDraw = require('./screen-draw.js');
const record = require('./record.js');
const timelapse = require('./timelapse.js');
const steps = require('./steps.js');
const recordOptions = require('./record-options.js');
const replay = require('./replay.js');
const captureMarker = require('./capture-marker.js');
const markClips = require('./mark-clips.js');
const gallery = require('./gallery.js');
const transcript = require('./transcript.js');
const exportCapture = require('./export.js');
const sendCapture = require('./send-capture.js');
const copyCapture = require('./copy-capture.js');
const bugReport = require('./bug-report.js');
const gameCompanion = require('./game-companion.js');
const layers = require('./layers.js');
const layerKey = require('./layer-key.js');
const layerPages = require('./layer-pages.js');
const layerAnchor = require('./layer-anchor.js');
const layerCaptures = require('./layer-captures.js');
const aiGlow = require('./ai-glow.js');
const usageMode = require('./usage-mode.js');
const xenonMenu = require('./xenon-menu.js');
const { refusedOverGame, OVER_EXCLUSIVE_HINT } = require('./over-screen.js');
const desktopScene = require('./desktop-scene.js');
const deckShortcut = require('./deck-shortcut.js');
const functionKey = require('./function-key.js');
const widgetKey = require('./widget-key.js');
const power = require('./power.js');
const notifications = require('./notifications.js');
const gameMode = require('./game-mode.js');
const energy = require('./energy.js');

const BY_TYPE = new Map(CAPABILITIES.map(c => [c.type, c]));
const BY_AI_NAME = new Map(CAPABILITIES.filter(c => c.capability.ai).map(c => [c.capability.ai.name, c]));

// Deck param kind → Gemini schema. Only kinds a capability actually uses are
// mapped; an unmapped kind is a catalog mistake and fails the test suite.
function aiParamSchema(param, description) {
  if (param.kind === 'select') return { type: 'STRING', enum: param.options.slice(), description };
  // 'hidden' has no Deck control (another picker or the voice sets it).
  if (param.kind === 'text' || param.kind === 'hidden') return { type: 'STRING', description };
  throw new Error(`capability param kind "${param.kind}" has no AI schema`);
}

// `available`: the probes() result. A capability this machine cannot do is left
// out, so the AI is never handed a function that can only fail.
function aiFunctions(available) {
  const can = available || {};
  return CAPABILITIES.filter(c => c.capability.ai && can[c.capability.requires] !== false).map((c) => {
    const { name, description, params = {} } = c.capability.ai;
    const properties = {};
    // A param without an AI description is for the Deck and the editor only.
    const forAi = c.params.filter(p => params[p.name]);
    for (const p of forAi) properties[p.name] = aiParamSchema(p, params[p.name]);
    const required = forAi.filter(p => !p.optional && p.kind !== 'select').map(p => p.name);
    return { name, description, parameters: { type: 'OBJECT', properties, ...(required.length ? { required } : {}) } };
  });
}

// The Deck action an AI call stands for, or null when the name is not a
// capability. Arguments are copied by the catalog's param names only; the
// registry's validateAction is still what decides what survives.
function aiAction(fnName, fnArgs) {
  const cap = BY_AI_NAME.get(fnName);
  if (!cap) return null;
  const args = fnArgs && typeof fnArgs === 'object' ? fnArgs : {};
  const action = { type: cap.type };
  const described = (cap.capability.ai.params) || {};
  for (const p of cap.params) if (described[p.name] && args[p.name] != null) action[p.name] = args[p.name];
  return action;
}

function createCapabilities(deps) {
  const d = deps || {};

  // One engine feature (capture-host.js FEATURES); a host without `has` can do them all.
  function captureCan(feature) {
    if (!screenshot.available(d.capture)) return false;
    return typeof d.capture.host.has !== 'function' || d.capture.host.has(feature);
  }

  function probes() {
    return {
      frameStats: perf.frameStatsAvailable(d.fps),
      // The Game performance tile shows CPU/GPU on every OS, frame stats or not.
      perfTile: true,
      // What a widget's rule can ask on this machine.
      situationCall: !!(d.situations && d.situations.call()),
      situationFront: !!(d.situations && d.situations.front()),
      gameSessions: gameSessions.available(d.fps),
      benchmark: benchmark.available(d.fps),
      powerStatus: power.readable(d.power),
      powerMode: power.settable(d.power),
      notifications: !!d.notifications,
      notificationOpen: !!(d.notificationOpen && d.notificationOpen.available()),
      // The setting exists everywhere; detection itself degrades per OS (gamedetect.js).
      gameMode: !!d.settingKeys,
      sensorHistory: !!d.settingKeys,
      energyUsage: !!(d.energy && typeof d.energy.summary === 'function'),
      perfMode: typeof d.handToDashboard === 'function',
      // Linux engines that found no screenshot tool can still trim and thumb.
      capture: captureCan('screenshot'),
      // A Linux desktop can shoot the screen with no tool to pick an area.
      captureRegion: captureCan('region'),
      captureVideo: captureCan('record'),
      // fps, size and quality; the timer pill is its own probe (Windows only).
      captureTuning: captureCan('tuning'),
      captureBadge: captureCan('badge'),
      captureLapse: captureCan('lapse'),
      // What the Xenon menu offers beside Registra.
      captureSound: captureCan('sound'),
      captureMic: captureCan('mic'),
      captureWebcam: captureCan('webcam'),
      captureReplay: captureCan('replay'),
      captureOcr: captureCan('ocr'),
      captureInspect: captureCan('inspect'),
      // The ruler is its own probe: an engine can pick colours without one.
      captureMeasure: captureCan('measure'),
      captureDraw: screenDraw.canDraw(d),
      captureSteps: captureCan('steps'),
      captureCover: captureCan('cover'),
      captureExport: captureCan('export'),
      captureTrim: captureCan('trim'),
      captureSpeech: captureCan('speech'),
      capturePick: captureCan('pick_folder'),
      layers: layers.available(d.layersHost),
      layerAnchor: layerAnchor.available(d.layersHost),
      aiGlow: aiGlow.available(d.layersHost),
      usageMode: usageMode.available(d.layersHost),
      xenonMenu: xenonMenu.available(d.menu),
      // A controller can open the Xenon menu (View + Menu held, layers/pad.rs).
      menuPad: !!(d.layersHost && typeof d.layersHost.pads === 'function' && d.layersHost.pads()),
      // The shell can keep widget windows out of screenshots and recordings.
      layersCaptures: layerCaptures.available(d.layersHost),
      scene: desktopScene.available(d.layersHost),
      widgetPages: layerPages.hasPages(d.layers),
      gameCompanion: !!d.companion,
      shortcuts: typeof d.shortcutsAvailable === 'function' ? !!d.shortcutsAvailable() : false,
    };
  }

  const layerDeps = () => ({
    host: d.layersHost, layers: d.layers, edit: d.layersEdit, heldBy: d.deck && d.deck.heldBy,
    deck: d.deck && d.deck.configs ? { configs: d.deck.configs, choices: layerKey.choices } : null,
  });

  // A change to where widgets sit is one step of "Undo", however many writes it takes.
  const stepDeps = () => {
    const base = layerDeps();
    if (!base.layers || !base.edit || !base.edit.step) return base;
    let taken = false;
    const update = (change) => base.layers.update((cur) => {
      const res = change(cur);
      if (!taken && res && res.layers && !res.error) {
        taken = true;
        base.edit.step(cur);
      }
      return res;
    });
    return { ...base, layers: { ...base.layers, update } };
  };

  async function run(action) {
    const cap = action && BY_TYPE.get(action.type);
    if (!cap) return { ok: false, error: 'unsupported' };
    if (probes()[cap.capability.requires] === false) return { ok: false, error: 'unavailable' };
    if (refusedOverGame(d, action)) return { ok: false, error: 'over_exclusive', hint: OVER_EXCLUSIVE_HINT };
    switch (action.type) {
      case 'perfStats': return perf.readStats(d.fps);
      case 'stutterWhy': return stutterWhy.run(d);
      case 'gameSessions': return gameSessions.listSessions(d, action);
      case 'gameSessionsCompare': return gameSessions.compare(d, action);
      case 'gameSessionsSet': return gameSessions.manage(d, action);
      case 'perfHud': return perfHud.run(d, action);
      case 'benchmark': return benchmark.run(d, action);
      case 'powerMode': return power.setMode(d, action);
      case 'powerStatus': return power.status(d);
      case 'screenshot': return screenshot.run(d, action);
      case 'screenText': return screenText.run(d, action);
      case 'screenPin': return screenPin.run(d, action);
      case 'screenCover': return screenCover.run(d, action);
      case 'screenColor': return screenInspect.color(d, action);
      case 'screenMeasure': return screenInspect.measure(d, action);
      case 'screenDraw': return screenDraw.run(d, action);
      case 'record': return record.run(d, action);
      case 'timelapse': return timelapse.run(d, action);
      case 'steps': return steps.run(d, action);
      case 'recordingOptions': return recordOptions.run(d, action);
      case 'replay': return replay.run(d, action);
      case 'replayOptions': return replay.options(d, action);
      case 'captureMarker': return captureMarker.run(d, action);
      case 'markClips': return markClips.run(d, action);
      case 'gallery': return gallery.open(d, action);
      case 'galleryList': return gallery.list(d, action);
      case 'transcript': return transcript.read(d, action);
      case 'transcriptChapters': return transcript.chapters(d, action);
      case 'exportCapture': return exportCapture.run(d, action);
      case 'sendCapture': return sendCapture.run(d, action);
      case 'copyCapture': return copyCapture.run(d, action);
      case 'bugReport': return bugReport.run(d, action);
      case 'gameCompanion': return gameCompanion.open(d);
      case 'layerPlace': return layers.place(stepDeps(), action);
      case 'layerKey': return layerKey.place(stepDeps(), action);
      case 'layerRemove': return layers.remove(stepDeps(), action);
      case 'layerMove': return layers.move(stepDeps(), action);
      case 'layersEdit': return layers.edit(layerDeps(), action);
      case 'layersUndo': return layers.undoEdit(layerDeps(), action);
      case 'layerGroup': return layers.group(stepDeps(), action);
      // `attach`: edit mode offers "Attach to an app" only where the shell follows one;
      // `desks`: "Show on a desktop" for a page, only where the shell says which desktop is shown.
      case 'layerList': {
        const res = await layers.list(layerDeps(), action);
        return res && res.ok ? { ...res, attach: layerAnchor.available(d.layersHost), desks: layerPages.desks(d.layersHost) } : res;
      }
      case 'layersToggle': return layers.toggle(layerDeps(), action);
      case 'layersShortcut': return layers.shortcut(layerDeps(), action);
      case 'layersCaptures': return layerCaptures.run(layerDeps(), action);
      case 'layerWidgetKey': return widgetKey.setWidgetKey(stepDeps(), action);
      case 'layerAnchor': return layerAnchor.run({ ...stepDeps(), windows: d.windows }, action);
      case 'layerPage': return layerPages.switchPage(layerDeps(), action);
      case 'layerPageEdit': return layerPages.editPages(stepDeps(), action);
      case 'aiEdgeGlow': return aiGlow.setScreens({ settings: d.settings }, action);
      case 'xenonMenu': return xenonMenu.run(d, action);
      case 'xenonScreen': return xenonMenu.openScreen(d, action);
      case 'usageMode': return usageMode.setMode({ host: d.layersHost, settings: d.settings }, action);
      case 'desktopWallpaper': return desktopScene.setWallpaper({ host: d.layersHost, settings: d.settings }, action);
      case 'desktopSaver': return desktopScene.setSaver({ host: d.layersHost, settings: d.settings }, action);
      case 'desktopScene': return desktopScene.setScene({ host: d.layersHost, settings: d.settings }, action);
      case 'desktopScreens': return desktopScene.setScreens({ host: d.layersHost, settings: d.settings }, action);
      case 'screenAlerts': return usageMode.setScreenAlerts({ host: d.layersHost, settings: d.settings }, action);
      case 'dnd': return notifications.setQuiet(d, action);
      case 'notifications': return notifications.setSwitches(d, action);
      case 'notificationOpen': return notifications.openApp(d, action);
      case 'gameMode': return gameMode.setGameMode(d, action);
      case 'gameIgnore': return gameMode.editIgnore(d, action);
      case 'sensorHistory': return gameMode.setSensorHistory(d, action);
      case 'energyUsage': return energy.usage(d);
      case 'perfMode': return gameMode.perfMode(d, action);
      case 'deckShortcut': return deckShortcut.setShortcut({ deck: d.deck }, action);
      case 'functionKey': return functionKey.setKey({ deck: d.deck }, action);
      case 'widgetHandlerKey': return widgetKey.setHandlerKey({ deck: d.deck, heldBy: d.deck && d.deck.heldBy, sdkHandlers: d.sdkHandlers }, action);
      case 'deckShortcutList': return deckShortcut.listShortcuts({ deck: d.deck });
      default: return { ok: false, error: 'unsupported' };
    }
  }

  const seedKeys = () => functionKey.seedKeys({ deck: d.deck, probes });

  return { probes, run, seedKeys };
}

module.exports = { createCapabilities, aiFunctions, aiAction };
