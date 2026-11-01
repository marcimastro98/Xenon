'use strict';
// Start the Discord desktop app on this computer, or bring it to the front when
// it is already running, and open one conversation in it. Behind two buttons of
// the Discord widget: "Open Discord" on the overlay shown while the app is
// closed, and "Reply" on a mirrored DM or mention (asked for on Discord, Oct
// 2026: "I wanted to be able to respond to the notifications I receive from
// DMs"). Xenon cannot send the reply itself: Discord's local connection has no
// command that sends a message, and the account token would make Xenon a self
// bot, which Discord bans. So the button takes you to the conversation instead.
//
// Every launch is an argv array of fixed values: nothing the browser sends
// reaches a command line. The one value that comes from outside, the channel
// id, only ever travels over Discord's own connection, as a checked snowflake.
//
// One launch per platform, tried in order until one works:
// - Windows: the discord:// link through the shell's protocol handler, which
//   every Discord install registers. It starts the app, or focuses the window
//   of the one already running (the way this route has always worked).
// - macOS: `open -a Discord` starts or activates the app bundle; the link is
//   the fallback for a renamed or relocated bundle.
// - Linux: the binary first. `xdg-open discord://` only works where the install
//   registered the scheme (Flatpak does; the .deb's desktop entry does not),
//   and on a desktop xdg-open does not recognise it can hand an unknown scheme
//   to the web browser, which would open a tab saying it cannot open the link.
//   Running the binary of an app that is already open hands over to that
//   instance, which comes to the front: Discord is single-instance everywhere.
//   Flatpak and Snap installs have no binary in PATH, so they have a line each.

const { runPlan } = require('./spotify-launch');

// The discord:// link through the shell's protocol handler. A fixed string.
const WIN_PROTOCOL_ARGS = ['-NoProfile', '-NonInteractive', '-Command',
  "try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='discord://';UseShellExecute=$true})}catch{exit 1}"];

// How long an opener that has not exited counts as "it worked". The Linux
// launchers (flatpak, snap, a forwarding second instance) exit at once when
// they fail, so a short wait is enough to tell, and keeps the button quick.
const SETTLE_MS = 2000;

// Pure: what to run on `platform`, in order. `direct` means the command IS
// Discord (success = it started); otherwise it is an opener whose exit code
// says whether it worked.
function launchPlans(platform) {
  if (platform === 'win32') {
    return [{ cmd: 'powershell.exe', args: WIN_PROTOCOL_ARGS, direct: false, minimized: false }];
  }
  if (platform === 'darwin') {
    return [
      { cmd: '/usr/bin/open', args: ['-a', 'Discord'], direct: false, minimized: false },
      { cmd: '/usr/bin/open', args: ['discord://'], direct: false, minimized: false },
    ];
  }
  return [
    { cmd: 'discord', args: [], direct: true, minimized: false },
    { cmd: 'flatpak', args: ['run', 'com.discordapp.Discord'], direct: false, minimized: false },
    { cmd: 'snap', args: ['run', 'discord'], direct: false, minimized: false },
    { cmd: 'xdg-open', args: ['discord://'], direct: false, minimized: false },
  ];
}

// Try each plan until one starts. Resolves { ok } or { ok: false, error }; never
// rejects. `run` is runPlan, injectable for the tests.
async function launchWith(plans, run) {
  for (const plan of plans) {
    const r = await run(plan);
    if (r && r.ok) return { ok: true };
  }
  return { ok: false, error: 'launch_failed' };
}

function launchDiscord(platform = process.platform, run = (plan) => runPlan(plan, undefined, SETTLE_MS)) {
  return launchWith(launchPlans(platform), run);
}

// A Discord snowflake, the same rule discord-rpc.js applies to every id it
// sends. Restated rather than imported so this module stays loadable without
// the RPC client in the tests.
function isSnowflake(s) { return typeof s === 'string' && /^\d{5,25}$/.test(s.trim()); }

// The errors discord-rpc.js raises while the app is not answering YET: no pipe,
// a pipe that closed mid-handshake, a handshake that timed out. `not_connected`
// is not one of them: it means no linked account, which waiting does not fix.
const STARTING = new Set(['discord_not_running', 'discord_closed', 'discord_timeout', 'discord_pipe_busy']);
const SELECT_RETRIES = 4;
const SELECT_RETRY_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open one conversation: bring Discord forward, then ask it to show the channel.
// In that order because the launch must not be what decides the view: with the
// app already running it only focuses it, and the selection that follows is
// what lands on the right chat. With the app closed, the local connection only
// answers once it has started, so the selection is retried for a few seconds.
//
// deps.launch()          → { ok }   (launchDiscord)
// deps.select(channelId) → { ok, error? } (discord-rpc openTextChannel)
//
// Answers { ok, selected } where `selected` false means Discord came up but did
// not open the chat, so the widget can say "find it there" instead of claiming
// a result it did not get. ok:false only when nothing at all happened.
async function openConversation(channelId, deps, opts = {}) {
  const id = String(channelId == null ? '' : channelId).trim();
  if (!isSnowflake(id)) return { ok: false, error: 'bad_channel' };
  const retries = Number.isInteger(opts.retries) ? opts.retries : SELECT_RETRIES;
  const wait = typeof opts.sleep === 'function' ? opts.sleep : sleep;
  const retryMs = Number.isFinite(opts.retryMs) ? opts.retryMs : SELECT_RETRY_MS;

  let launched = { ok: false };
  try { launched = (await deps.launch()) || { ok: false }; } catch { launched = { ok: false }; }

  let selected = false;
  let error = '';
  for (let attempt = 0; attempt <= retries && !selected; attempt++) {
    if (attempt > 0) await wait(retryMs);
    try {
      const r = await deps.select(id);
      selected = !!(r && r.ok);
      error = selected ? '' : String((r && r.error) || 'select_failed');
    } catch (e) {
      error = String((e && e.message) || 'select_failed');
    }
    // Only a Discord that is still starting is worth waiting for. Anything else
    // (the account not linked, a refused command) will not change in ten seconds.
    if (!selected && !STARTING.has(error)) break;
  }

  if (!launched.ok && !selected) return { ok: false, error: error || 'launch_failed' };
  return selected ? { ok: true, selected: true } : { ok: true, selected: false, error };
}

module.exports = {
  launchDiscord,
  openConversation,
  // The parts below take their inputs, for the tests.
  launchPlans, launchWith, isSnowflake,
};
