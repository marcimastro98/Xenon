'use strict';
// Which processes Performance Mode leaves alone, by bare lowercase name.

// The system's own. Same list as perf-priority.ps1, plus the names that live in
// the user's session and keep sound, input and the picture on screen going.
const SYSTEM = new Set([
  'explorer', 'csrss', 'winlogon', 'wininit', 'services', 'lsass', 'smss', 'dwm', 'system', 'registry',
  'fontdrvhost', 'sihost', 'ctfmon', 'searchhost', 'shellexperiencehost', 'startmenuexperiencehost',
  'textinputhost', 'runtimebroker', 'applicationframehost', 'audiodg', 'svchost', 'conhost', 'taskhostw',
]);

// Apps that fail out loud when they run late: voice, capture and overlays on top
// of the game. A broken call is a worse deal than the cores they would free. What
// they start stays with them: on macOS Discord's helpers have names of their own.
const LATENCY_APPS = new Set([
  'discord', 'discordcanary', 'discordptb', 'ts3client_win64', 'ts3client_win32', 'teamspeak', 'mumble',
  'voicemeeter', 'voicemeeter8', 'voicemeeter8x64', 'voicemeeterpro', 'voicemeeter_x64',
  'nvcontainer', 'nvdisplay.container', 'nvsphelper64', 'nvidia overlay', 'nvidia share', 'nvidia app',
  'amdow', 'amdrsserv', 'radeonsoftware', 'gamebar', 'gamebarftserver', 'gamebarpresencewriter',
  'gameoverlayui', 'gameoverlayui64', 'rtss', 'rtsshooksloader64', 'msiafterburner',
]);

// The desktop's own sound, windows, compositor and shell, just as sensitive. Every
// app on the desktop may have started from one of them, so only the process itself
// stays, and one of them in front hands nothing back.
const DESKTOP_SESSION = new Set([
  'pipewire', 'pipewire-pulse', 'wireplumber', 'pulseaudio', 'xorg', 'xwayland', 'gnome-shell', 'kwin_wayland', 'kwin_x11',
  'sway', 'hyprland', 'gamescope', 'gamescope-wl',
  'plasmashell', 'krunner', 'cinnamon', 'xfce4-panel', 'xfdesktop', 'mate-panel', 'budgie-panel', 'lxqt-panel',
  // Under Proton the game waits on this one, and it is not the game's child.
  'wineserver',
  'windowserver', 'coreaudiod', 'finder', 'dock',
]);

// The name as every table row carries it.
function processKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\.exe$/, '');
}

// One name, many apps: the web runtimes apps draw their windows with. WebView2 on
// Windows, and WebKit's helpers: on macOS launchd starts them, not the app, and on
// Linux /proc keeps the first 15 characters of a name.
const SHARED_RUNTIMES = new Set([
  'msedgewebview2',
  'webkitwebprocess', 'webkitwebproces', 'webkitnetworkprocess', 'webkitnetworkpr', 'webkitgpuprocess', 'webkitgpuproces',
]);
const isSharedRuntime = (key) => SHARED_RUNTIMES.has(key) || key.startsWith('com.apple.webkit.');

const isProtected = (key) => SYSTEM.has(key);
// Xenon's own processes, whichever way they were started: the shell, the helper,
// the capture engine.
const isOwnName = (key) => key.startsWith('xenon');
// Left alone together with everything they started.
const keepsItsTree = (key) => isOwnName(key) || LATENCY_APPS.has(key);
const leftAlone = (key) => SYSTEM.has(key) || DESKTOP_SESSION.has(key) || keepsItsTree(key);

module.exports = { processKey, isProtected, keepsItsTree, isSharedRuntime, leftAlone };
