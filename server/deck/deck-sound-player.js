'use strict';
// Plays a Deck soundboard clip on the PC itself, for a key's keyboard shortcut
// when no dashboard is there to play it (deck-shortcut-runner.js): "widgets
// only", or a dashboard that is closed. The dashboard plays clips with an
// <audio> element (js/deck.js); this is the same play / toggle / stop and
// per-clip volume with the system's own player, one process per clip, killed
// on stop. Nothing new is installed:
//   Windows  PowerShell + the system MediaPlayer (mp3, wav, m4a, aac, flac),
//            ffplay for the rest when it sits next to ffmpeg
//   macOS    afplay (same formats), ffplay for the rest
//   Linux    ffplay, pw-play, paplay, then aplay for a wav
// A format no player here can read answers `sound_format` (none installed) or
// `sound_failed`, so the key says so instead of staying silent.
//
// deps (injected):
//   platform               process.platform
//   resolveFile(raw)       → absolute path of an allowed, existing clip, or null
//   ffplay()               → path (or bare name) of ffplay, or '' when there is none
//   spawn(cmd, args, opts) child_process.spawn
//   graceMs                how long a silent player must run to count as playing
const path = require('path');

const MAX_CLIPS = 8;
const START_GRACE_MS = 400;     // a player still running by then is playing
const START_LIMIT_MS = 5000;    // MediaPlayer says "playing" itself; never wait longer
const SYSTEM_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac']);
const LINUX_EXTS = new Set(['.wav', '.ogg', '.oga', '.flac', '.opus', '.mp3']);

// The file and volume reach PowerShell as environment variables, never inside
// the script text, so no path can turn into code.
const PS_SCRIPT = [
  'Add-Type -AssemblyName PresentationCore',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$p.Volume = [double]$env:XENON_SOUND_VOLUME',
  '$p.Open([Uri]::new($env:XENON_SOUND_FILE))',
  '$t = 0',
  'while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 60) { Start-Sleep -Milliseconds 50; $t++ }',
  'if (-not $p.NaturalDuration.HasTimeSpan) { exit 3 }',
  '$p.Play()',
  '[Console]::Out.WriteLine("playing"); [Console]::Out.Flush()',
  'Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150)',
  '$p.Close()',
].join('\n');

// 0-100 like the dashboard (absent or invalid = full); '' must not become 0.
function volumeOf(action) {
  const raw = action && action.volume != null ? String(action.volume).trim() : '';
  const v = raw === '' ? NaN : Number(raw.replace(',', '.'));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v / 100 : 1;
}

// The players to try, in order, for one clip. Pure, so every OS is testable here.
function playersFor(platform, file, volume, ffplay) {
  const ext = path.extname(file).toLowerCase();
  const ff = ffplay ? [{ cmd: ffplay, args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume * 100)), file] }] : [];
  if (platform === 'win32') {
    const ps = { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      env: { XENON_SOUND_FILE: file, XENON_SOUND_VOLUME: String(volume) }, saysPlaying: true };
    return SYSTEM_EXTS.has(ext) ? [ps, ...ff] : ff;
  }
  if (platform === 'darwin') {
    const af = { cmd: '/usr/bin/afplay', args: ['-v', String(volume), file] };
    return SYSTEM_EXTS.has(ext) ? [af, ...ff] : ff;
  }
  const out = [...ff];
  if (LINUX_EXTS.has(ext)) {
    out.push({ cmd: 'pw-play', args: ['--volume', String(volume), file] });
    out.push({ cmd: 'paplay', args: ['--volume=' + Math.round(volume * 65536), file] });
  }
  if (ext === '.wav') out.push({ cmd: 'aplay', args: ['-q', file] });
  return out;
}

function createDeckSoundPlayer(deps) {
  const d = deps || {};
  const graceMs = Number.isFinite(d.graceMs) ? d.graceMs : START_GRACE_MS;
  const clips = new Map();   // absolute file → child
  let ffplayPath = null;

  const ffplay = async () => {
    if (ffplayPath === null) {
      try { ffplayPath = String((await d.ffplay()) || ''); } catch { ffplayPath = ''; }
    }
    return ffplayPath;
  };

  function kill(file) {
    const child = clips.get(file);
    if (!child) return false;
    clips.delete(file);
    try { child.kill(); } catch { /* already gone */ }
    return true;
  }

  // One player: resolves 'playing', 'missing' (not installed) or 'failed'.
  function start(file, player) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timer = null;
      const settle = (how) => { if (settled) return; settled = true; clearTimeout(timer); resolve(how); };
      try {
        child = d.spawn(player.cmd, player.args, {
          windowsHide: true, stdio: ['ignore', player.saysPlaying ? 'pipe' : 'ignore', 'ignore'],
          env: player.env ? Object.assign({}, process.env, player.env) : process.env,
        });
      } catch { settle('missing'); return; }
      child.on('error', (e) => { if (clips.get(file) === child) clips.delete(file); settle(e && e.code === 'ENOENT' ? 'missing' : 'failed'); });
      child.on('exit', (code) => {
        if (clips.get(file) === child) clips.delete(file);
        settle(code === 0 ? 'playing' : 'failed');   // a clip shorter than the grace ended fine
      });
      if (player.saysPlaying && child.stdout) child.stdout.once('data', () => settle('playing'));
      timer = setTimeout(() => settle(player.saysPlaying ? 'failed' : 'playing'), player.saysPlaying ? START_LIMIT_MS : graceMs);
      if (timer.unref) timer.unref();
      kill(file);
      if (clips.size >= MAX_CLIPS) kill(clips.keys().next().value);   // the oldest makes room
      clips.set(file, child);
    });
  }

  async function play(action) {
    const mode = action && action.mode ? action.mode : 'play';
    const file = await d.resolveFile(String((action && action.file) || '').trim());
    if (mode === 'stop') { if (file) kill(file); return { ok: true }; }
    if (!file) return { ok: false, error: 'not_found' };
    if (mode === 'toggle' && kill(file)) return { ok: true };
    const players = playersFor(d.platform, file, volumeOf(action), await ffplay());
    if (!players.length) return { ok: false, error: 'sound_format' };
    // A player that is missing, or cannot read this file, hands it to the next.
    let failed = false;
    for (const p of players) {
      const how = await start(file, p);
      if (how === 'playing') return { ok: true };
      kill(file);
      if (how === 'failed') failed = true;
    }
    return { ok: false, error: failed ? 'sound_failed' : 'sound_format' };
  }

  async function playing(raw) {
    const file = await d.resolveFile(String(raw || '').trim());
    return !!file && clips.has(file);
  }

  function stopAll() {
    for (const file of [...clips.keys()]) kill(file);
    return { ok: true };
  }

  return { play, playing, stopAll, stop: stopAll };
}

module.exports = { createDeckSoundPlayer, playersFor, volumeOf, MAX_CLIPS };
