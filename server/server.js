const http = require('http');
const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let isMuted = false;
let cachedSpeakerId   = null; // full CLI ID — for SetDefault
let cachedSpeakerName = null; // short endpoint name — for SetVolume/ToggleMute
let cachedMicId       = null;
let cachedMicLabel    = null; // friendly name (F.NAME) used to match DirectShow devices
let _lastSpeakerVolume = 50;  // updated by getAudioInfo — used for duck/restore
let _duckActive        = false;
let _duckSavedVolume   = null;
let _aiFocusedScreen   = null; // last monitor the AI captured — its "focus" for follow-ups

const SVV = path.join(__dirname, 'soundvolumeview-x64', 'SoundVolumeView.exe');
const MEDIA_SCRIPT = path.join(__dirname, 'media.ps1');
const CPU_TEMP_SCRIPT = path.join(__dirname, 'cpu-temp.ps1');
const GPU_SCRIPT = path.join(__dirname, 'gpu.ps1');
const NETWORK_SCRIPT = path.join(__dirname, 'network.ps1');
const WINDOWS_SCRIPT = path.join(__dirname, 'windows.ps1');
const NOTES_FILE = path.join(__dirname, 'notes.txt');
const EVENTS_FILE = path.join(__dirname, 'events.json');
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const TASKS_MAX = 100;
const TIMERS_FILE = path.join(__dirname, 'timers.json');
const TIMERS_MAX = 20;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKGROUND_MAX_BYTES = 200 * 1024 * 1024;
const BACKGROUND_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const BACKGROUND_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);
const BACKGROUND_EXT_BY_MIME = new Map([...BACKGROUND_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

// CSV column indices for SoundVolumeView /scomma (no header row)
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, WINDOW_TITLE: 21 };

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON output');
  return JSON.parse(stdout.slice(start, end + 1));
}

function powerShellUtf8Command(command) {
  return `$utf8NoBom = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $utf8NoBom; $OutputEncoding = $utf8NoBom; ${command}`;
}

function runPowerShellScript(script, args = [], timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let resolvedEarly = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Resolve the promise as soon as we have valid JSON, but DO NOT kill the
    // PowerShell process — let it exit on its own so WinRT/COM handles (SMTC
    // session, thumbnail stream, DataReader, …) get released cleanly. Killing
    // mid-flight is what leaks broker handles and eventually wedges Windows
    // shutdown.
    const finishOk = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const finishErr = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill();
      reject(err);
    };

    const resolveIfJsonReady = () => {
      if (resolvedEarly) return;
      if (!stdout.trimEnd().endsWith('}')) return;
      try {
        const value = parseJsonOutput(stdout);
        resolvedEarly = true;
        finishOk(value);
      } catch { }
    };

    const timer = setTimeout(() => {
      try { finishOk(parseJsonOutput(stdout)); }
      catch { finishErr(new Error(stderr || `PowerShell timeout: ${path.basename(script)}`)); }
    }, timeout);

    child.stdout.on('data', chunk => { stdout += chunk; resolveIfJsonReady(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', e => finishErr(e));
    child.on('close', code => {
      if (settled) return;
      try { finishOk(parseJsonOutput(stdout)); }
      catch (e) { finishErr(new Error(stderr || e.message || `PowerShell exited with ${code}`)); }
    });
  });
}

function runPowerShellCommand(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powerShellUtf8Command(command)], {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      try { resolve(parseJsonOutput(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

function cpuSnapshot() {
  return os.cpus().map(cpu => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

let lastCpu = cpuSnapshot();
let cachedCpuUsage = 0;
// Continuous CPU sampler — avoids 0% sampling artifacts when /system is polled less often than CPU times update.
setInterval(() => {
  const now = cpuSnapshot();
  let idle = 0, total = 0;
  now.forEach((cpu, i) => {
    idle  += cpu.idle  - lastCpu[i].idle;
    total += cpu.total - lastCpu[i].total;
  });
  lastCpu = now;
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(100 - (idle / total * 100))));
    cachedCpuUsage = pct;
  }
}, 1500).unref();
let gpuCache = { gpu: null, gpuName: null, gpuTemp: null, updatedAt: 0 };
let cpuTempCache = { cpuTemp: null, updatedAt: 0 };
let mediaCache = { data: null, updatedAt: 0 };
let weatherCache = { data: null, updatedAt: 0, cacheKey: '' };
let gpuPending = null;
let cpuTempPending = null;
let mediaPending = null;
let weatherPending = null;
// STT via ffmpeg — WASAPI preferred (fast init), dshow fallback
let _sttDeviceReady = false;
let _sttUseWasapi   = false;
let _sttDshowDevice = null;
const _sttDeviceWaiters = [];
const _sttPending = new Map(); // id → { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved }

// ── Server-side wake word (ffmpeg VAD + Gemini keyword spotting) ────────────
// Records 3-second clips from the same mic as STT. Calculates RMS to skip
// silence without any Gemini call. Only asks Gemini when voice energy is
// detected — uses minimal quota (well within the free tier).
let _wakeLoopActive = false;
let _wakeCurrentKey = '';
let _wakeClipProc   = null; // killed when STT starts to avoid mic conflict

const WAKE_CLIP_SECS   = 1.5; // shorter clip = faster wake detection (overlap buffer still catches "Hey Xenon or Xenon")
const WAKE_ENERGY_MIN  = 600; // RMS floor — just above typical background noise (~547)
const STT_SPEECH_MIN   = 500; // whole-clip RMS floor for STT — below this we treat the clip as silence (no transcription)
const WAKE_COOLDOWN_MS = 4500;
const WAKE_GAP_MS      = 600;

// Adaptive backoff: in a quiet room every "Hey Xenon" is checked immediately, but
// when loud audio (TV, music, conversations) keeps tripping the RMS gate without a
// match, we progressively space out the Gemini transcription calls so a noisy room
// can't burn through the free-tier quota. A moment of real silence resets it.
function _wakeMinGapForStreak(streak) {
  if (streak <= 1) return 0;      // responsive: first attempts checked at once
  if (streak <= 3) return 2000;
  if (streak <= 6) return 4000;
  return 8000;                    // sustained noise → at most ~1 call / 8 s
}

function _wakeKillClip() {
  if (_wakeClipProc) { try { _wakeClipProc.kill(); } catch {} _wakeClipProc = null; }
}

function _wakeRms(wavBuf) {
  if (!wavBuf || wavBuf.length <= 44) return 0;
  const pcm = wavBuf.slice(44);
  // Previously capped at 32768 bytes (only first ~1 s of a 3 s clip) — if the user
  // spoke in the 2nd or 3rd second the RMS came from silence and the clip was skipped.
  // Now we scan the full buffer for correct energy measurement.
  const n = pcm.length - (pcm.length % 2);
  let sum = 0;
  for (let i = 0; i < n; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (n / 2));
}

function _wakeRecordClip() {
  return new Promise((resolve, reject) => {
    const ff = getFfmpegPath();
    const inputArgs = _sttUseWasapi
      ? ['-f', 'wasapi', '-i', 'default']
      : ['-f', 'dshow', '-i', `audio=${_sttDshowDevice}`];
    const proc = spawn(ff, [
      '-hide_banner', '-loglevel', 'quiet',
      ...inputArgs,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      '-t', String(WAKE_CLIP_SECS), '-f', 'wav', 'pipe:1',
    ], { windowsHide: true });
    _wakeClipProc = proc;
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', () => {
      _wakeClipProc = null;
      const buf = Buffer.concat(chunks);
      if (buf.length > 44) resolve(buf); else reject(new Error('wake clip empty'));
    });
    proc.on('error', e => { _wakeClipProc = null; reject(e); });
  });
}

// Detects the "xenon" wake word inside a transcript. Matching is done in code
// (not by Gemini) because the model reliably transcribes audio but does not
// reliably follow a "WAKE: YES/NO" output format. Covers common phonetic
// spellings across languages (xenon, ksenon, senon, zenon, dzenon, xeno…).
function _isStopCommand(text) {
  if (!text) return false;
  const t = text.toLowerCase().replace(/[.,!?;:]/g, '').trim();
  if (t.split(/\s+/).length > 3) return false;
  return /\b(stop|basta|ferma|fermati|fermo|fermate|esci|chiudi|chiuditi|spegniti|spegni|zitto|taci|quit|exit|close|cancel|cancella)\b/.test(t);
}

function _matchesWakeWord(transcript) {
  if (!transcript) return false;
  const t = transcript.toLowerCase();
  // Accept common phonetic spellings across languages and accents.
  // Uses substring search so prefixes like "e" in "eksenon" don't block the match.
  return /x[eé]?non|ks[eé]?non|eks[eé]?non|s[eé]?non|z[eé]?non|dz[eé]?non|gz[eé]?non|cs[eé]?non/.test(t) ||
         /\bxeno\b|\bzeno\b/.test(t);
}

function _wakeAskGemini(geminiKey, wavBuf) {
  // Ask Gemini to transcribe. Hint at the expected wake word so it renders
  // phonetic variants (eksenon, ksenon, zenon…) faithfully rather than mapping
  // them to unrelated known words (e.g. Italian "sano").
  const prompt =
    'Transcribe the speech in this audio clip. ' +
    'The speaker may say the word "xenon" (a noble gas; may be pronounced as "kse-non", "ze-non", "ek-se-non", "se-non", or similar across accents). ' +
    'Write the transcription phonetically if the pronunciation is unclear. ' +
    'Reply with only the transcription text and nothing else. ' +
    'If there is no speech, reply with "(silence)".';
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'audio/wav', data: wavBuf.toString('base64') } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 120,
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 }, // disable thinking → faster transcription
    },
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        process.stdout.write(`[Wake] Gemini HTTP ${res.statusCode}\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            process.stdout.write(`[Wake] Gemini error: ${parsed.error.message || JSON.stringify(parsed.error).slice(0, 120)}\n`);
            resolve(false);
            return;
          }
          const transcript = (parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
          const matched = _matchesWakeWord(transcript);
          process.stdout.write(`[Wake] heard: "${transcript || '(nothing)'}" → ${matched ? 'MATCH' : 'no'}\n`);
          resolve({ matched, transcript });
        } catch (e) {
          process.stdout.write(`[Wake] Gemini parse error: ${e.message} — raw: ${d.slice(0, 120)}\n`);
          resolve({ matched: false, transcript: '' });
        }
      });
    });
    req.on('error', e => { process.stdout.write(`[Wake] Gemini req error: ${e.message}\n`); resolve({ matched: false, transcript: '' }); });
    req.on('timeout', () => { process.stdout.write('[Wake] Gemini req timeout\n'); req.destroy(); resolve({ matched: false, transcript: '' }); });
    req.write(body);
    req.end();
  });
}

async function _wakeLoop(key) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  process.stdout.write('[Wake] Gemini wake word detector started\n');
  let clipErrors   = 0;
  let clipCount    = 0;
  let cooldownUntil = 0; // ms timestamp — skip Gemini calls during cooldown
  let prevPcm      = null; // PCM (header-stripped) of the previous clip, for overlap
  let lastGeminiAt = 0;  // ms timestamp of the last wake transcription call
  let nonMatchStreak = 0; // consecutive noisy clips with no wake/stop match

  while (_wakeLoopActive && _wakeCurrentKey === key) {
    try {
      if (!_sttDeviceReady) { await sleep(1500); continue; }
      if (_sttPending.size > 0) { prevPcm = null; await sleep(500); continue; }

      const wav = await _wakeRecordClip(); // blocking record (WAKE_CLIP_SECS)
      if (!_wakeLoopActive) break;

      clipErrors = 0;
      clipCount++;
      if (clipCount % 10 === 0) process.stdout.write(`[Wake] Alive (${clipCount} clips)\n`);

      const rms = _wakeRms(wav);
      const curPcm = wav.length > 44 ? wav.slice(44) : Buffer.alloc(0);

      // Real silence: reset the backoff so the next spoken wake word is instant.
      if (rms < WAKE_ENERGY_MIN) { nonMatchStreak = 0; prevPcm = curPcm; continue; }
      // In the post-match cooldown window we never call Gemini.
      if (Date.now() < cooldownUntil) { prevPcm = curPcm; continue; }
      // Adaptive backoff: under sustained noise, throttle the transcription calls.
      const minGap = _wakeMinGapForStreak(nonMatchStreak);
      if (minGap > 0 && Date.now() - lastGeminiAt < minGap) { prevPcm = curPcm; continue; }

      // Analyze the previous clip + current clip together so a wake word spoken
      // across a clip boundary ("hey xe" | "non") is never split and missed.
      const analyzeWav = prevPcm && prevPcm.length
        ? pcmToWav(Buffer.concat([prevPcm, curPcm]), 16000, 1, 16)
        : wav;
      prevPcm = curPcm;
      lastGeminiAt = Date.now();

      process.stdout.write(`[Wake] Voice detected RMS=${rms.toFixed(0)}, asking Gemini…\n`);

      // Fire-and-forget: don't await Gemini — start next clip recording immediately
      // so no audio gap occurs while waiting for the API response.
      _wakeAskGemini(key, analyzeWav).then(result => {
        const detected   = result && result.matched;
        const transcript = (result && result.transcript) || '';
        if (detected && _wakeLoopActive && Date.now() >= cooldownUntil) {
          process.stdout.write('[Wake] WAKE WORD DETECTED\n');
          nonMatchStreak = 0;
          broadcastSSE('wake_word', { ts: Date.now() });
          cooldownUntil = Date.now() + WAKE_COOLDOWN_MS;
        } else if (!detected && _isStopCommand(transcript)) {
          // User said a dismissal word ("stop", "basta"…) — close any active session.
          nonMatchStreak = 0;
          process.stdout.write(`[Wake] Stop command detected: "${transcript}"\n`);
          broadcastSSE('stop_session', {});
        } else {
          nonMatchStreak++;
        }
      }).catch(() => {});

    } catch (e) {
      if (_wakeLoopActive) {
        clipErrors++;
        if (clipErrors === 1 || clipErrors % 10 === 0) {
          process.stdout.write(`[Wake] clip error (${clipErrors}x): ${e.message}\n`);
        }
        await sleep(1000);
      }
    }
  }
  process.stdout.write('[Wake] Detector stopped\n');
}

function startServerWakeWord(geminiKey) {
  if (!geminiKey) return;
  if (_wakeLoopActive && _wakeCurrentKey === geminiKey) return;
  stopServerWakeWord();
  _wakeLoopActive = true;
  _wakeCurrentKey = geminiKey;
  _wakeLoop(geminiKey);
}

function stopServerWakeWord() {
  _wakeLoopActive = false;
  _wakeCurrentKey = '';
  _wakeKillClip();
}

let mediaPreferredSource = '';
const MEDIA_CACHE_MS = 1200;
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const WEATHER_LANGS = new Set(['it', 'en', 'ko', 'ja', 'zh']);
const artworkCache = new Map();
const weatherLocationCache = new Map();

function sanitizeMediaSourcePreference(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

function setMediaPreferredSource(value) {
  const next = sanitizeMediaSourcePreference(value);
  if (next !== mediaPreferredSource) {
    mediaPreferredSource = next;
    mediaCache.updatedAt = 0;
  }
  return mediaPreferredSource;
}

function mediaScriptArgs(action) {
  const args = [action];
  if (mediaPreferredSource) args.push(mediaPreferredSource);
  return args;
}

function makeCsvPath() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `xenonedge-svv-${stamp}.csv`);
}

function readSoundVolumeRows() {
  return new Promise((resolve, reject) => {
    const csv = makeCsvPath();
    execFile(SVV, ['/scomma', csv, '/AvoidPrompts'], err => {
      if (err) return reject(err);
      setTimeout(() => {
        try {
          const rows = fs.readFileSync(csv, 'latin1')
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(parseCsvLine);
          fs.unlink(csv, () => {});
          resolve(rows);
        } catch (e) {
          fs.unlink(csv, () => {});
          reject(e);
        }
      }, 250);
    });
  });
}

function fetchJson(url, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'XenonEdgeWidget/1.0' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Artwork lookup timeout')); });
    req.on('error', reject);
  });
}

async function hydrateArtwork(data) {
  if (!data || !data.active || data.thumbnail) return data;
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  if (!title || !artist) return data;

  const key = `${artist}::${title}`.toLowerCase();
  if (artworkCache.has(key)) {
    data.thumbnail = artworkCache.get(key);
    return data;
  }

  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const result = await fetchJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, 2500);
    const art = result && result.results && result.results[0] && result.results[0].artworkUrl100;
    const bigArt = art ? art.replace('100x100bb', '600x600bb') : null;
    // LRU eviction: cap cache at 200 entries to prevent unbounded growth.
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, bigArt);
    data.thumbnail = bigArt;
  } catch {
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, null);
  }

  return data;
}

function firstWeatherValue(value) {
  if (Array.isArray(value) && value[0] && typeof value[0].value === 'string') return value[0].value;
  return '';
}

function normalizeWeatherCode(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : 'auto';
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function resolveWeatherLocation(value) {
  const location = normalizeWeatherLocation(value);
  if (location.mode === 'manual' && location.city) return location;
  return { mode: 'auto', city: '' };
}

function normalizeWeatherCityKey(value) {
  return sanitizeWeatherCity(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pickWeatherLocationResult(results, requestedCity) {
  if (!Array.isArray(results) || !results.length) return null;
  const requestedKey = normalizeWeatherCityKey(requestedCity);
  return results.find(item => normalizeWeatherCityKey(item && item.name) === requestedKey)
    || results.find(item => requestedKey.startsWith(normalizeWeatherCityKey(item && item.name)))
    || results.find(item => normalizeWeatherCityKey(item && item.name).startsWith(requestedKey))
    || results[0];
}

function splitWeatherDisplayLocation(value) {
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
  return {
    location: parts[0] || '',
    region: parts[1] || '',
    country: parts.slice(2).join(', '),
  };
}

async function resolveManualWeatherPlace(city, lang) {
  const requestedCity = sanitizeWeatherCity(city);
  if (!requestedCity) return { placePath: '', resolvedCity: '' };

  const cacheKey = `${lang}|${requestedCity.toLowerCase()}`;
  const cached = weatherLocationCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_CACHE_MS) return cached.value;

  let value = {
    placePath: `/${encodeURIComponent(requestedCity)}`,
    resolvedCity: requestedCity,
  };

  try {
    const query = encodeURIComponent(requestedCity);
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=10&language=${lang}&format=json`, 3000);
    const match = pickWeatherLocationResult(geo && geo.results, requestedCity);
    const latitude = Number(match && match.latitude);
    const longitude = Number(match && match.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      value = {
        placePath: `/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
        resolvedCity: [match.name, match.admin1, match.country].filter(Boolean).join(', ') || requestedCity,
      };
    }
  } catch {
    // Fall back to the raw city name when geocoding is unavailable.
  }

  weatherLocationCache.set(cacheKey, { value, updatedAt: Date.now() });
  return value;
}

function weatherDescription(item, lang) {
  if (!item) return '';
  return firstWeatherValue(item[`lang_${lang}`]) || firstWeatherValue(item.weatherDesc) || '';
}

function normalizeWeatherHour(hour, lang, date) {
  const rawTime = String(hour && hour.time || '0').padStart(4, '0');
  const time = `${rawTime.slice(0, -2).padStart(2, '0')}:${rawTime.slice(-2)}`;
  const tempC = Number(hour && hour.tempC);
  const feelsC = Number(hour && hour.FeelsLikeC);
  const rain = Number(hour && hour.chanceofrain);
  const windKph = Number(hour && hour.windspeedKmph);
  return {
    date,
    time,
    code: normalizeWeatherCode(hour && hour.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    rain: Number.isFinite(rain) ? Math.round(rain) : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    condition: weatherDescription(hour, lang),
  };
}

function normalizeWeatherDay(day, lang) {
  const astronomy = day && day.astronomy && day.astronomy[0] || {};
  const noon = day && Array.isArray(day.hourly) ? (day.hourly.find(h => String(h.time) === '1200') || day.hourly[0]) : null;
  return {
    date: String(day && day.date || ''),
    code: normalizeWeatherCode(noon && noon.weatherCode),
    minC: Number.isFinite(Number(day && day.mintempC)) ? Math.round(Number(day.mintempC)) : null,
    maxC: Number.isFinite(Number(day && day.maxtempC)) ? Math.round(Number(day.maxtempC)) : null,
    avgC: Number.isFinite(Number(day && day.avgtempC)) ? Math.round(Number(day.avgtempC)) : null,
    uv: Number.isFinite(Number(day && day.uvIndex)) ? Number(day.uvIndex) : null,
    sunHour: Number.isFinite(Number(day && day.sunHour)) ? Number(day.sunHour) : null,
    sunrise: String(astronomy.sunrise || ''),
    sunset: String(astronomy.sunset || ''),
    moonPhase: String(astronomy.moon_phase || ''),
    condition: weatherDescription(noon, lang),
  };
}

function normalizeWeather(raw, lang) {
  const current = raw && raw.current_condition && raw.current_condition[0] || {};
  const area = raw && raw.nearest_area && raw.nearest_area[0] || {};
  const tempC = Number(current.temp_C);
  const feelsC = Number(current.FeelsLikeC);
  const humidity = Number(current.humidity);
  const windKph = Number(current.windspeedKmph);
  const pressure = Number(current.pressure);
  const visibility = Number(current.visibility);
  const uv = Number(current.uvIndex);
  const cloudCover = Number(current.cloudcover);
  const precipMM = Number(current.precipMM);
  const lat = Number(area.latitude);
  const lon = Number(area.longitude);
  const condition = weatherDescription(current, lang);
  const location = firstWeatherValue(area.areaName) || firstWeatherValue(area.region) || firstWeatherValue(area.country) || '';
  const region = firstWeatherValue(area.region);
  const country = firstWeatherValue(area.country);
  const days = Array.isArray(raw && raw.weather) ? raw.weather : [];
  const nowHour = new Date().getHours();
  const hourly = days.flatMap(day => (Array.isArray(day.hourly) ? day.hourly : [])
    .map(hour => normalizeWeatherHour(hour, lang, String(day.date || ''))))
    .filter(hour => !hour.date || hour.date !== days[0]?.date || Number(hour.time.slice(0, 2)) >= nowHour)
    .slice(0, 8);
  const todayAstro = days[0] && days[0].astronomy && days[0].astronomy[0] || {};

  return {
    ok: Number.isFinite(tempC),
    code: normalizeWeatherCode(current.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    humidity: Number.isFinite(humidity) ? humidity : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    windDir: String(current.winddir16Point || ''),
    pressure: Number.isFinite(pressure) ? pressure : null,
    visibility: Number.isFinite(visibility) ? visibility : null,
    uv: Number.isFinite(uv) ? uv : null,
    cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
    precipMM: Number.isFinite(precipMM) ? precipMM : null,
    condition,
    location,
    region,
    country,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    sunrise: String(todayAstro.sunrise || ''),
    sunset: String(todayAstro.sunset || ''),
    hourly,
    forecast: days.slice(0, 3).map(day => normalizeWeatherDay(day, lang)),
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null,
  };
}

async function getWeather(lang = 'it', requestedLocation = null) {
  const safeLang = WEATHER_LANGS.has(lang) ? lang : 'it';
  const settings = await readHubSettings().catch(() => null);
  const hasRequestLocation = requestedLocation && (requestedLocation.mode !== undefined || requestedLocation.city !== undefined);
  const location = resolveWeatherLocation(hasRequestLocation ? requestedLocation : settings && settings.weather);
  const cacheKey = `${safeLang}|${location.mode}|${location.city.toLowerCase()}`;
  const age = Date.now() - weatherCache.updatedAt;
  if (weatherCache.data && weatherCache.cacheKey === cacheKey && age < WEATHER_CACHE_MS) return weatherCache.data;
  if (weatherPending && weatherPending.cacheKey === cacheKey) return weatherPending.promise;

  const manualPlace = location.mode === 'manual'
    ? await resolveManualWeatherPlace(location.city, safeLang)
    : { placePath: '', resolvedCity: '' };
  const placePath = manualPlace.placePath;

  const promise = fetchJson(`https://wttr.in${placePath}?format=j1&lang=${safeLang}`, 3500)
    .then(async raw => {
      const data = normalizeWeather(raw, safeLang);
      data.locationMode = location.mode;
      data.requestedCity = location.city;
      data.resolvedCity = manualPlace.resolvedCity;
      if (location.mode === 'manual' && manualPlace.resolvedCity) {
        const displayLocation = splitWeatherDisplayLocation(manualPlace.resolvedCity);
        data.location = displayLocation.location || data.location;
        data.region = displayLocation.region || '';
        data.country = displayLocation.country || '';
      }
      if (data.lat !== null && data.lon !== null) {
        try {
          const aqiRaw = await fetchJson(
            `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${data.lat}&longitude=${data.lon}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide`,
            4000
          );
          const cur = aqiRaw && aqiRaw.current || {};
          data.aqi  = Number.isFinite(Number(cur.european_aqi))     ? Math.round(Number(cur.european_aqi))           : null;
          data.pm25 = Number.isFinite(Number(cur.pm2_5))            ? Math.round(Number(cur.pm2_5) * 10) / 10        : null;
          data.pm10 = Number.isFinite(Number(cur.pm10))             ? Math.round(Number(cur.pm10))                   : null;
          data.no2  = Number.isFinite(Number(cur.nitrogen_dioxide)) ? Math.round(Number(cur.nitrogen_dioxide) * 10) / 10 : null;
        } catch { }
      }
      weatherCache = { data, updatedAt: Date.now(), cacheKey };
      return data;
    })
    .catch(e => {
      if (weatherCache.data && weatherCache.cacheKey === cacheKey) return { ...weatherCache.data, stale: true };
      throw e;
    })
    .finally(() => {
      if (weatherPending && weatherPending.cacheKey === cacheKey) weatherPending = null;
    });

  weatherPending = { cacheKey, promise };
  return promise;
}

function splitMediaTitle(rawTitle, appName) {
  const title = (rawTitle || '').trim();
  if (!title) return { title: '', artist: '' };
  if (/spotify/i.test(appName) && title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts.length >= 2) {
      return { artist: parts.shift().trim(), title: parts.join(' - ').trim() };
    }
  }
  return { title, artist: '' };
}

function displayAppName(name) {
  if (/spotify/i.test(name || '')) return 'Spotify';
  if (/chrome|edge|firefox|brave|opera|youtube/i.test(name || '')) return 'YouTube';
  if (/zunemusic|zunevideo|microsoftmediaplayer|windowsmediaplayer/i.test(name || '')) return 'Lettore Multimediale';
  if (!name) return 'Media';
  // Strip Windows package format: Publisher.Name_hash!AppId → Name
  const pkg = (name || '').match(/^(?:[^.]+\.)+([^._!]+)[_!]/);
  if (pkg) return pkg[1];
  return name;
}

function liveMediaSnapshot(data, ageMs) {
  if (!data) return data;
  const snapshot = { ...data };
  if (snapshot.playbackStatus === 'Playing' && snapshot.duration) {
    const position = Number(snapshot.position) || 0;
    const duration = Number(snapshot.duration) || 0;
    snapshot.position = Math.min(duration, position + Math.floor(ageMs / 1000));
  }
  return snapshot;
}

function getCpuUsage() {
  return cachedCpuUsage;
}

function getCpuName() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0].model) {
      return cpus[0].model.replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU\s+@.*$/g, '').trim();
    }
  } catch { }
  return null;
}

async function getCpuTemp() {
  const age = Date.now() - cpuTempCache.updatedAt;
  if (age < 5000) return cpuTempCache.cpuTemp;
  if (cpuTempPending) return cpuTempPending;

  cpuTempPending = (async () => {
    try {
      const data = await runPowerShellScript(CPU_TEMP_SCRIPT, [], 10000);
      cpuTempCache = {
        cpuTemp: data.cpuTemp === null || data.cpuTemp === undefined ? null : Number(data.cpuTemp),
        updatedAt: Date.now(),
      };
    } catch {
      cpuTempCache.updatedAt = Date.now();
    }
    cpuTempPending = null;
    return cpuTempCache.cpuTemp;
  })();

  return cpuTempPending;
}

async function getGpuInfo() {
  const age = Date.now() - gpuCache.updatedAt;
  if (age < 5000) return gpuCache;
  if (gpuPending) return gpuPending;
  gpuPending = (async () => {
  try {
    const data = await runPowerShellScript(GPU_SCRIPT, [], 12000);
    gpuCache = {
      gpu: data.gpu === null || data.gpu === undefined ? gpuCache.gpu : data.gpu,
      gpuName: data.gpuName || gpuCache.gpuName || null,
      gpuTemp: (data.gpuTemp === null || data.gpuTemp === undefined) ? gpuCache.gpuTemp : data.gpuTemp,
      updatedAt: Date.now(),
    };
  } catch {
    gpuCache.updatedAt = Date.now();
  }
  gpuPending = null;
  return gpuCache;
  })();
  return gpuPending;
}

let diskDetailsCache = { data: null, updatedAt: 0 };
async function getDiskDetails() {
  if (diskDetailsCache.data && Date.now() - diskDetailsCache.updatedAt < 60000) return diskDetailsCache.data;
  const command = `
    $ErrorActionPreference = 'Stop'
    try {
      $volumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DriveLetter + ':')
          label = ([string]$_.FileSystemLabel).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.DriveType).Trim()
        }
      })
    } catch {
      $volumes = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DeviceID } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DeviceID).Trim()
          label = ([string]$_.VolumeName).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.Description).Trim()
        }
      })
    }
    [pscustomobject]@{ volumes = $volumes } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    const map = {};
    const volumes = Array.isArray(data.volumes) ? data.volumes : (data.volumes ? [data.volumes] : []);
    volumes.forEach(volume => {
      if (volume && volume.drive) map[String(volume.drive).toUpperCase()] = volume;
    });
    diskDetailsCache = { data: map, updatedAt: Date.now() };
    return map;
  } catch {
    diskDetailsCache = { data: {}, updatedAt: Date.now() };
    return {};
  }
}

async function getAllDisksInfo() {
  const drives = [];
  const details = await getDiskDetails();
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of letters) {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bfree) * Number(s.bsize);
        if (total > 0) {
          const drive = letter + ':';
          const detail = details[drive.toUpperCase()] || {};
          drives.push({
            drive,
            total,
            used: total - free,
            free,
            percent: Math.round(((total - free) / total) * 100),
            label: detail.label || '',
            fileSystem: detail.fileSystem || '',
            driveType: detail.driveType || '',
          });
        }
      }
    } catch { }
  }
  return drives.length ? drives : null;
}

let ramInfoCache = null;
async function getRamInfo() {
  if (ramInfoCache) return ramInfoCache;
  const command = `
    $types = @{ 20='DDR'; 21='DDR2'; 22='DDR2 FB'; 24='DDR3'; 26='DDR4'; 34='DDR5' }
    $modules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object {
      $smbios = 0
      try { $smbios = [int]$_.SMBIOSMemoryType } catch { }
      $type = $types[$smbios]
      $speed = 0
      if ($_.ConfiguredClockSpeed) { $speed = [int]$_.ConfiguredClockSpeed }
      elseif ($_.Speed) { $speed = [int]$_.Speed }
      [pscustomobject]@{
        type = $type
        speed = $speed
        capacity = [uint64]$_.Capacity
        manufacturer = ([string]$_.Manufacturer).Trim()
        partNumber = ([string]$_.PartNumber).Trim()
      }
    })
    if ($modules.Count -eq 0) {
      [pscustomobject]@{ ram = $null } | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
    $type = ($modules | Where-Object { $_.type } | Select-Object -First 1 -ExpandProperty type)
    $speed = ($modules | Measure-Object -Property speed -Maximum).Maximum
    $total = ($modules | Measure-Object -Property capacity -Sum).Sum
    $moduleCount = $modules.Count
    $moduleGb = if ($moduleCount -gt 0 -and $total) { [Math]::Round(($total / $moduleCount) / 1GB, 0) } else { 0 }
    $manufacturer = ($modules | Where-Object { $_.manufacturer -and $_.manufacturer -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty manufacturer)
    $partNumber = ($modules | Where-Object { $_.partNumber -and $_.partNumber -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty partNumber)
    $labelParts = @()
    if ($type) { $labelParts += $type }
    if ($speed) { $labelParts += (([int]$speed).ToString() + ' MHz') }
    $layout = if ($moduleCount -gt 0 -and $moduleGb -gt 0) { $moduleCount.ToString() + 'x' + $moduleGb.ToString() + ' GB' } else { $null }
    $detailParts = @()
    if ($labelParts.Count -gt 0) { $detailParts += ($labelParts -join ' ') }
    if ($layout) { $detailParts += $layout }
    $nameParts = @()
    if ($manufacturer) { $nameParts += $manufacturer }
    if ($partNumber) { $nameParts += $partNumber }
    [pscustomobject]@{
      ram = [pscustomobject]@{
        name = ($labelParts -join ' ')
        detail = ($detailParts -join ' - ')
        moduleName = ($nameParts -join ' ')
        modules = $moduleCount
        speed = $speed
        type = $type
      }
    } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    ramInfoCache = data.ram || null;
  } catch {
    ramInfoCache = null;
  }
  return ramInfoCache;
}

async function getSystemInfo() {
  const [gpu, disks, ramInfo, cpuTemp] = await Promise.all([getGpuInfo(), getAllDisksInfo(), getRamInfo(), getCpuTemp()]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    now: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: getCpuUsage(),
    cpuTemp,
    cpuName: getCpuName(),
    memory: {
      used: usedMem,
      total: totalMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    ramName: ramInfo && ramInfo.name ? ramInfo.name : null,
    ramDetail: ramInfo,
    gpu: gpu.gpu,
    gpuName: gpu.gpuName,
    gpuTemp: gpu.gpuTemp,
    disks,
  };
}

// --- Network info: bandwidth requires a delta between two readings ---
let _netPrev = null; // { rx, tx, t }
async function getNetworkInfo() {
  const data = await runPowerShellScript(NETWORK_SCRIPT, [], 8000);
  const now = Date.now();
  const rx = Number(data.rxBytes) || 0;
  const tx = Number(data.txBytes) || 0;

  let downBps = null, upBps = null;
  if (_netPrev && now > _netPrev.t) {
    const dt = (now - _netPrev.t) / 1000; // seconds
    const dRx = rx - _netPrev.rx;
    const dTx = tx - _netPrev.tx;
    if (dt > 0 && dRx >= 0 && dTx >= 0) {
      downBps = Math.round(dRx / dt);
      upBps   = Math.round(dTx / dt);
    }
  }
  _netPrev = { rx, tx, t: now };

  return {
    ping: data.ping ?? null,
    latency: data.latency ?? null,
    fps: data.fps ?? null,
    gpuLatency: data.gpuLatency ?? null,
    downloadBps: downBps,
    uploadBps: upBps,
  };
}

async function getMediaInfo(force = false) {
  const age = Date.now() - mediaCache.updatedAt;
  if (!force && mediaCache.data && age < MEDIA_CACHE_MS) return liveMediaSnapshot(mediaCache.data, age);
  if (mediaPending) return mediaPending;
  mediaPending = (async () => {
  try {
    const data = await runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs('info'), 12000);
    const hydrated = await hydrateArtwork(data);
    mediaCache = { data: hydrated, updatedAt: Date.now() };
    mediaPending = null;
    return hydrated;
  } catch (e) {
    if (mediaCache.data) {
      mediaPending = null;
      return mediaCache.data;
    }
    const fallback = await getMediaFallback(e.message);
    const hydratedFallback = await hydrateArtwork(fallback);
    mediaCache = { data: hydratedFallback, updatedAt: Date.now() };
    mediaPending = null;
    return hydratedFallback;
  }
  })();
  return mediaPending;
}

function getMediaFallback(error) {
  return new Promise(resolve => {
    readSoundVolumeRows().then(rows => {
        try {
          const app = rows.find(f =>
            f[F.TYPE] === 'Application' &&
            f[F.DIR] === 'Render' &&
            f[F.STATE] === 'Active' &&
            f[F.NAME] &&
            !/windows|system sounds|operating system/i.test(`${f[F.NAME]} ${f[F.WINDOW_TITLE] || ''}`) &&
            (f[F.WINDOW_TITLE] || /spotify|chrome|edge|firefox|browser|youtube/i.test(f[F.NAME]))
          );

          if (!app) {
            resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
            return;
          }

          const appName = displayAppName(app[F.NAME]);
          const rawTitle = app[F.WINDOW_TITLE] || app[F.NAME] || 'Media attivo';
          const split = splitMediaTitle(rawTitle, appName);

          resolve({
            active: true,
            app: appName,
            source: appName,
            title: split.title || rawTitle,
            artist: split.artist || '',
            album: '',
            playbackStatus: 'Unknown',
            thumbnail: null,
            position: 0,
            duration: 0,
            fallback: true,
            error,
          });
        } catch {
          resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
        }
      }).catch(() => {
        resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
      });
    });
}

async function mediaAction(action) {
  const data = await runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs(action), 5000);
  mediaCache.updatedAt = 0;
  return data;
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function getAudioInfo() {
  return new Promise((resolve, reject) => {
    readSoundVolumeRows().then(rows => {
        try {
          rows = rows.filter(f => f[F.TYPE] === 'Device' && f[F.STATE] === 'Active');

          const speakers = rows.filter(f => f[F.DIR] === 'Render');
          const mics     = rows.filter(f => f[F.DIR] === 'Capture');

          const defSpk = speakers.find(f => f[F.DEFAULT] === 'Render') || speakers[0];
          const defMic = mics.find(f => f[F.DEFAULT] === 'Capture')    || mics[0];

          if (defSpk) { cachedSpeakerId = defSpk[F.CLI_ID]; cachedSpeakerName = defSpk[F.NAME]; _lastSpeakerVolume = parseInt(defSpk[F.VOL_PCT]) || _lastSpeakerVolume; }
          if (defMic) { cachedMicId = defMic[F.CLI_ID]; cachedMicLabel = defMic[F.NAME]; }

          const toDevice = (f, isDefault) => ({
            name:      f[F.DEVICE_NAME],
            label:     f[F.NAME],
            id:        f[F.CLI_ID],
            isDefault,
            volume:    parseInt(f[F.VOL_PCT]) || 0,
            muted:     f[F.MUTED] === 'Yes',
          });

          resolve({
            speaker:  defSpk ? toDevice(defSpk, true)  : null,
            mic:      defMic ? toDevice(defMic, true)   : null,
            speakers: speakers.map(f => toDevice(f, f === defSpk)),
            mics:     mics.map(f => toDevice(f, f === defMic)),
          });
        } catch (e) { reject(e); }
    }).catch(reject);
  });
}

function setMicMute(mute) {
  const action = mute ? '/Mute' : '/Unmute';
  // Use the cached mic CLI ID (resolved from SoundVolumeView output) so the call works
  // regardless of the Windows display language. Falls back silently if the cache is empty.
  if (cachedMicId) {
    execFile(SVV, [action, cachedMicId], err => { if (err) console.error(err.message); });
  } else if (cachedSpeakerName) {
    // Last-resort: try the generic 'DefaultCaptureDevice' selector understood by SVV
    execFile(SVV, [action, 'DefaultCaptureDevice'], err => { if (err) console.error(err.message); });
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
  });
}

function readBodyBuffer(req, maxBytes = BACKGROUND_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBackground(req, body) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary');

  const boundaryText = match[1] || match[2];
  const boundary = Buffer.from(`--${boundaryText}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextBoundaryPrefix = Buffer.from(`\r\n--${boundaryText}`);
  let offset = body.indexOf(boundary);

  while (offset !== -1) {
    let partStart = offset + boundary.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;

    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd === -1) break;
    const headers = body.slice(partStart, headerEnd).toString('latin1');
    const dataStart = headerEnd + separator.length;
    const dataEnd = body.indexOf(nextBoundaryPrefix, dataStart);
    if (dataEnd === -1) break;

    const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i);
    const name = disposition && disposition[1].match(/name="([^"]+)"/i);
    const filename = disposition && disposition[1].match(/filename="([^"]*)"/i);
    if (name && name[1] === 'background' && filename && filename[1]) {
      const typeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
      return {
        originalName: path.basename(filename[1]).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 120) || 'background',
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data: body.slice(dataStart, dataEnd),
      };
    }
    offset = body.indexOf(boundary, dataEnd);
  }
  throw new Error('Missing background file');
}

function cleanupOldBackgrounds(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('background-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

// ── Screen enumeration + capture (shared by /api/screens, /api/screenshot,
//    and the AI capture_screen function) ───────────────────────────────────
async function listScreens() {
  const psScript = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }';
  try {
    const stdout = await new Promise((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { maxBuffer: 64 * 1024, windowsHide: true },
        (err, out) => err ? reject(err) : resolve(out)
      )
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
      const [x, y, w, h, primary, dev] = line.trim().split('|');
      const label = (dev || '').replace(/^\\\\.\\/, '').trim() || `DISPLAY${i + 1}`;
      return { index: i, x: parseInt(x) || 0, y: parseInt(y) || 0, width: parseInt(w) || 1920, height: parseInt(h) || 1080, primary: primary === 'True', name: label };
    });
  } catch {
    return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }];
  }
}

// Capture a screenshot; `monitor` is an optional {x,y,width,height} region.
// Returns base64 JPEG.
async function captureScreenshot(monitor) {
  const tmpPath = path.join(os.tmpdir(), `xenon_ss_${Date.now()}.jpg`);
  try {
    const ffmpeg = getFfmpegPath();
    const ffmpegArgs = ['-y', '-f', 'gdigrab', '-framerate', '1'];
    if (monitor && monitor.width > 0 && monitor.height > 0) {
      ffmpegArgs.push('-offset_x', String(monitor.x), '-offset_y', String(monitor.y), '-video_size', `${monitor.width}x${monitor.height}`);
    }
    ffmpegArgs.push('-i', 'desktop', '-vframes', '1', '-q:v', '3', '-vf', 'scale=\'min(1920,iw)\':-2', tmpPath);
    await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
    const imgBuffer = await fs.promises.readFile(tmpPath);
    return imgBuffer.toString('base64');
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// ── Server-side audio output (voice + chimes) ──────────────────────────────
// Plays through the system default device so audio works regardless of which
// window has focus (the browser WebView blocks autoplay without a user gesture).
let _speakProc = null;
let _speakGenToken = 0; // incremented on each stopServerSpeak to abort in-flight generation

// Lazy-load msedge-tts (natural Microsoft neural voices, ~1-2s latency).
let _MsEdgeTTS = null;
let _EDGE_OUTPUT = null;
function _loadEdgeTTS() {
  if (_MsEdgeTTS) return true;
  try {
    const m = require('msedge-tts');
    _MsEdgeTTS = m.MsEdgeTTS;
    _EDGE_OUTPUT = m.OUTPUT_FORMAT;
    return true;
  } catch { return false; }
}

// Male neural voices — one per UI language.
const EDGE_TTS_VOICES = {
  it: 'it-IT-DiegoNeural',
  en: 'en-US-GuyNeural',
  ko: 'ko-KR-InJoonNeural',
  ja: 'ja-JP-KeitaNeural',
  zh: 'zh-CN-YunxiNeural',
  de: 'de-DE-ConradNeural',
  fr: 'fr-FR-HenriNeural',
  es: 'es-ES-AlvaroNeural',
};

function stopServerSpeak() {
  _speakGenToken++;
  if (_speakProc) { try { _speakProc.kill(); } catch {} _speakProc = null; }
}

// Gemini native TTS (prebuilt neural voice). Returns a Promise<Buffer> with WAV
// audio, or rejects on error (quota, offline, no audio). Voice names are
// language-agnostic — the model speaks whatever language the text is in.
function _geminiTtsToWav(text, apiKey, voice = 'Charon') {
  return new Promise((resolve, reject) => {
    const safeVoice = String(voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: String(text || '').slice(0, 1000) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice } } },
      },
    });
    const t0 = Date.now();
    const ttsReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'XenonEdgeWidget/2.0' },
    }, (ttsRes) => {
      let d = '';
      ttsRes.on('data', c => { d += c; });
      ttsRes.on('end', () => {
        process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini tts error'));
          const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (!part || !part.data) return reject(new Error('no audio data'));
          const pcmBytes = Buffer.from(part.data, 'base64');
          const rateMatch = String(part.mimeType || '').match(/rate=(\d+)/);
          const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
          resolve(pcmToWav(pcmBytes, sampleRate));
        } catch (e) { reject(e); }
      });
    });
    ttsReq.on('error', reject);
    ttsReq.setTimeout(20000, () => { ttsReq.destroy(); reject(new Error('gemini tts timeout')); });
    ttsReq.write(payload);
    ttsReq.end();
  });
}

// Play a WAV file via Windows SoundPlayer (synchronous, focus-independent).
// Resolves when playback finishes or is cancelled. Honours the cancel token.
function _playWavFile(wavPath, myToken) {
  return new Promise((resolve) => {
    if (_speakGenToken !== myToken) { fs.promises.unlink(wavPath).catch(() => {}); return resolve(); }
    const ps = `(New-Object System.Media.SoundPlayer -ArgumentList '${wavPath}').PlaySync();` +
               `try { Remove-Item -LiteralPath '${wavPath}' -Force -EA SilentlyContinue } catch {}`;
    const psProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    _speakProc = psProc;
    const done = () => { if (_speakProc === psProc) _speakProc = null; resolve(); };
    psProc.on('exit', done);
    psProc.on('error', done);
  });
}

// Speak text server-side with a fallback chain:
//   1. Microsoft Edge neural voice (primary — natural & fast, ~1-2s)
//   2. Windows SAPI (last resort — always available, robotic)
// Gemini native TTS was dropped from the default path: the preview model is far
// too slow (5-15s, frequently times out), which made replies inaudible/late.
// The `apiKey` arg is kept for signature compatibility but is no longer used here.
// Playback is always server-side so it works regardless of window focus or
// WebView audio quirks. Resolves when speech finishes (or is stopped).
function speakOnServer(text, langPrefix, apiKey) {
  return new Promise(async (resolve) => {
    stopServerSpeak();
    const myToken = _speakGenToken;
    const lp = /^[a-z]{2}$/i.test(langPrefix || '') ? langPrefix.toLowerCase() : 'en';
    const clean = String(text || '').slice(0, 2000);

    // ── 1. Microsoft Edge TTS neural voice (primary) ──────────────
    // msedge-tts v2.x only exposes MP3/WebM; we pipe MP3 through the bundled
    // ffmpeg to produce a WAV that SoundPlayer can play.
    if (_loadEdgeTTS()) {
      const voice = EDGE_TTS_VOICES[lp] || EDGE_TTS_VOICES['en'];
      const wavPath = path.join(os.tmpdir(), `xenon-say-${Date.now()}-${myToken}.wav`);
      try {
        const tts = new _MsEdgeTTS();
        await tts.setMetadata(voice, _EDGE_OUTPUT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(clean);
        if (_speakGenToken !== myToken) return resolve();

        const ffmpegExe = getFfmpegPath();
        const ffProc = spawn(ffmpegExe, [
          '-hide_banner', '-loglevel', 'error',
          '-i', 'pipe:0',
          '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1', '-f', 'wav', wavPath,
        ], { windowsHide: true });
        _speakProc = ffProc; // allow stopServerSpeak to kill the conversion
        audioStream.pipe(ffProc.stdin);
        audioStream.on('error', () => { try { ffProc.stdin.destroy(); } catch {} });

        const ffExitCode = await new Promise(res => {
          ffProc.once('close', res);
          ffProc.once('error', () => res(-1));
        });
        if (_speakGenToken !== myToken || ffExitCode !== 0) {
          if (_speakProc === ffProc) _speakProc = null;
          fs.promises.unlink(wavPath).catch(() => {});
          return resolve();
        }
        await _playWavFile(wavPath, myToken);
        return resolve();
      } catch (e) {
        process.stdout.write(`[TTS] edge-tts error (${e.message}), falling back to SAPI\n`);
        fs.promises.unlink(wavPath).catch(() => {});
      }
    }

    if (_speakGenToken !== myToken) return resolve();

    // ── 2. SAPI fallback (last resort) ─────────────────────────────
    const txtPath = path.join(os.tmpdir(), `xenon-say-${Date.now()}.txt`);
    try { await fs.promises.writeFile(txtPath, clean, 'utf8'); }
    catch { return resolve(); }
    const ps = [
      'Add-Type -AssemblyName System.Speech;',
      "$t = Get-Content -Raw -Encoding UTF8 -LiteralPath '" + txtPath + "';",
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$s.SetOutputToDefaultAudioDevice();',
      "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like '" + lp + "*' } | Select-Object -First 1;",
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name); }',
      '$s.Rate = 1; $s.Speak($t);',
    ].join(' ');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    _speakProc = proc;
    const done = () => { if (_speakProc === proc) _speakProc = null; fs.promises.unlink(txtPath).catch(() => {}); resolve(); };
    proc.on('exit', done);
    proc.on('error', done);
  });
}

// Build a short two-note chime WAV in memory (sine + decay envelope).
let _chimeCache = {};
function _buildChimeWav(kind) {
  const rate = 24000, dur = 0.6;
  const notes = kind === 'close' ? [[660, 0], [440, 0.13]] : [[784, 0], [1046, 0.13]];
  const total = Math.floor(rate * dur);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let s = 0;
    for (const [freq, start] of notes) {
      if (t >= start) {
        const lt = t - start;
        const env = Math.exp(-lt * 4) * (1 - Math.exp(-lt * 80));
        s += Math.sin(2 * Math.PI * freq * lt) * env;
      }
    }
    s = Math.max(-1, Math.min(1, s * 0.08));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return pcmToWav(buf, rate, 1, 16);
}

function playChimeOnServer(kind) {
  const k = kind === 'close' ? 'close' : 'wake';
  if (!_chimeCache[k]) {
    try { _chimeCache[k] = _buildChimeWav(k); } catch { return; }
  }
  const wavPath = path.join(os.tmpdir(), `xenon-chime-${k}.wav`);
  fs.promises.writeFile(wavPath, _chimeCache[k]).then(() => {
    const ps = "(New-Object System.Media.SoundPlayer -ArgumentList '" + wavPath + "').PlaySync();";
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    proc.on('error', () => {});
  }).catch(() => {});
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getFfmpegPath() {
  if (process.env.XEH_FFMPEG) return process.env.XEH_FFMPEG;
  const localCandidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ];
  const local = localCandidates.find(candidate => fs.existsSync(candidate));
  if (local) return local;

  if (process.env.LOCALAPPDATA) {
    const wingetPackages = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const wingetFfmpeg = findFirstFile(wingetPackages, 'ffmpeg.exe', 5);
    if (wingetFfmpeg) return wingetFfmpeg;
  }

  return 'ffmpeg.exe';
}

function findFirstFile(root, fileName, maxDepth) {
  if (!root || maxDepth < 0 || !fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const direct = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase());
    if (direct) return path.join(root, direct.name);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findFirstFile(path.join(root, entry.name), fileName, maxDepth - 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function isFfmpegMissing(error) {
  return error && (error.code === 'ENOENT' || /not recognized|ENOENT|cannot find/i.test(String(error.message || '')));
}

async function transcodeMp4BackgroundToWebm(sourcePath, targetPath) {
  const ffmpeg = getFfmpegPath();
  await execFilePromise(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-vf', 'fps=30,scale=1920:-2',
    '-an',
    '-c:v', 'libvpx',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-b:v', '6M',
    '-maxrate', '8M',
    '-bufsize', '12M',
    '-auto-alt-ref', '0',
    targetPath,
  ], { timeout: BACKGROUND_TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Converted WebM is empty');
  return stat;
}

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'mic', 'system', 'notes', 'tasks']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks', 'timer']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
});
const DASHBOARD_WIDGET_SIZES = Object.freeze(['compact', 'normal', 'wide', 'tall', 'large', 'full']);
const DASHBOARD_CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({
  widgets: Object.freeze({
    media: Object.freeze({ order: 0, size: 'tall', visible: true }),
    mic: Object.freeze({ order: 1, size: 'normal', visible: true }),
    system: Object.freeze({ order: 2, size: 'tall', visible: true }),
    notes: Object.freeze({ order: 3, size: 'normal', visible: true }),
    tasks: Object.freeze({ order: 4, size: 'normal', visible: false }),
  }),
  cards: Object.freeze({
    main: Object.freeze({
      cpu: Object.freeze({ order: 0, size: 'normal', visible: true }),
      gpu: Object.freeze({ order: 1, size: 'normal', visible: true }),
      ram: Object.freeze({ order: 2, size: 'normal', visible: true }),
      disk: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    net: Object.freeze({
      ping: Object.freeze({ order: 0, size: 'normal', visible: true }),
      fps: Object.freeze({ order: 1, size: 'normal', visible: true }),
      latency: Object.freeze({ order: 2, size: 'normal', visible: true }),
      bandwidth: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    audio: Object.freeze({
      volume: Object.freeze({ order: 0, size: 'wide', visible: true }),
      speaker: Object.freeze({ order: 1, size: 'normal', visible: true }),
      microphone: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
  }),
  tabs: Object.freeze({ order: ['main', 'net'], active: 'main' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks', 'timer'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
});

const DEFAULT_HUB_SETTINGS = Object.freeze({
  accent: '#1ed760',
  background: '#070808',
  text: '#f0f3f1',
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  backgroundMedia: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  weather: Object.freeze({ mode: 'auto', city: '' }),
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
  geminiApiKey: '',
  aiTtsEnabled: true,
});

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

function sanitizeSettingsBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!url.startsWith('/uploads/')) return null;
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

function normalizeSettingsWeather(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function cloneDashboardLayout(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDashboardOrder(value, fallback, maxOrder) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(0, Math.min(maxOrder, numeric));
}

function normalizeDashboardSize(value, allowedSizes, fallback) {
  return allowedSizes.includes(value) ? value : fallback;
}

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  return {
    order: normalizeDashboardOrder(source.order, fallbackItem.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fallbackItem.size),
    visible: source.visible === undefined ? true : source.visible !== false,
  };
}

function sortDashboardIds(collection) {
  return Object.keys(collection).sort((left, right) => {
    const diff = collection[left].order - collection[right].order;
    return diff || left.localeCompare(right);
  });
}

function reindexDashboardCollection(collection) {
  sortDashboardIds(collection).forEach((id, index) => { collection[id].order = index; });
}

function normalizeDashboardTabs(sourceTabs) {
  const source = sourceTabs && typeof sourceTabs === 'object' ? sourceTabs : {};
  const sourceOrder = Array.isArray(source.order) ? source.order : DEFAULT_DASHBOARD_LAYOUT.tabs.order;
  const order = sourceOrder.filter(tab => DASHBOARD_TAB_IDS.includes(tab));
  DASHBOARD_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: DASHBOARD_TAB_IDS.includes(source.active) ? source.active : DEFAULT_DASHBOARD_LAYOUT.tabs.active,
  };
}

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(tab => CALENDAR_TAB_IDS.includes(tab));
  CALENDAR_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: CALENDAR_TAB_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.active,
  };
}

function normalizeMediaView(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    active: MEDIA_VIEW_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.mediaView.active,
  };
}

function normalizeDashboardLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  const layout = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  const sourceWidgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    layout.widgets[widgetId] = normalizeDashboardItem(
      sourceWidgets[widgetId],
      DEFAULT_DASHBOARD_LAYOUT.widgets[widgetId],
      DASHBOARD_WIDGET_IDS.length - 1,
      DASHBOARD_WIDGET_SIZES,
    );
  });

  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    const sourceCards = source.cards && source.cards[groupId] && typeof source.cards[groupId] === 'object'
      ? source.cards[groupId]
      : {};
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      layout.cards[groupId][cardId] = normalizeDashboardItem(
        sourceCards[cardId],
        DEFAULT_DASHBOARD_LAYOUT.cards[groupId][cardId],
        DASHBOARD_CARD_IDS[groupId].length - 1,
        DASHBOARD_CARD_SIZES,
      );
    });
    reindexDashboardCollection(layout.cards[groupId]);
  });

  reindexDashboardCollection(layout.widgets);
  layout.tabs = normalizeDashboardTabs(source.tabs);
  layout.calendarTabs = normalizeCalendarTabs(source.calendarTabs);
  layout.mediaView = normalizeMediaView(source.mediaView);
  return layout;
}

function normalizeHubSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    accent: normalizeHex(source.accent, DEFAULT_HUB_SETTINGS.accent),
    background: normalizeHex(source.background, DEFAULT_HUB_SETTINGS.background),
    text: normalizeHex(source.text, DEFAULT_HUB_SETTINGS.text),
    panelAlpha: clampNumber(source.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(source.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(source.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    backgroundMedia: sanitizeSettingsBackgroundMedia(source.backgroundMedia),
    lockWidgets: normalizeLockWidgets(source.lockWidgets),
    weather: normalizeSettingsWeather(source.weather),
    dashboardLayout: normalizeDashboardLayout(source.dashboardLayout),
    geminiApiKey: String(source.geminiApiKey || '').trim().slice(0, 200),
    aiTtsEnabled: source.aiTtsEnabled !== false,
  };
}

async function readHubSettings() {
  try {
    const raw = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
    return normalizeHubSettings(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeHubSettings(settings) {
  const safe = normalizeHubSettings(settings);
  await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

function normalizeEvents(value) {
  const source = Array.isArray(value) ? value : (Array.isArray(value && value.events) ? value.events : []);
  return source.slice(0, 250).map(item => {
    const title = String(item && item.title || '').trim().slice(0, 120);
    const notes = String(item && item.notes || '').trim().slice(0, 600);
    const startsAt = String(item && item.startsAt || '').trim();
    const reminderAt = String(item && item.reminderAt || '').trim();
    const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    return {
      id,
      title,
      notes,
      startsAt: Number.isFinite(Date.parse(startsAt)) ? startsAt : '',
      reminderAt: Number.isFinite(Date.parse(reminderAt)) ? reminderAt : '',
      notifiedAt: item && item.notifiedAt ? String(item.notifiedAt).slice(0, 40) : '',
      createdAt: item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString(),
    };
  }).filter(item => item.title || item.startsAt || item.notes);
}

async function readEvents() {
  try {
    const raw = await fs.promises.readFile(EVENTS_FILE, 'utf8');
    return normalizeEvents(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeEvents(events) {
  const safe = normalizeEvents(events);
  await fs.promises.writeFile(EVENTS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

const TASK_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const TASK_RECURRENCES = Object.freeze(['never', 'daily', 'weekly', 'custom']);

function normalizeTask(item) {
  const text = String(item && item.text || '').trim().slice(0, 200);
  const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const priority = TASK_PRIORITIES.includes(item && item.priority) ? item.priority : 'medium';
  const recurrence = TASK_RECURRENCES.includes(item && item.recurrence) ? item.recurrence : 'never';
  const recurrenceDays = (recurrence === 'custom' && Number.isFinite(Number(item && item.recurrenceDays)) && Number(item.recurrenceDays) >= 1)
    ? Math.round(Number(item.recurrenceDays)) : 1;
  const completed = Boolean(item && item.completed);
  const completedAt = completed && item.completedAt ? String(item.completedAt).slice(0, 40) : null;
  const createdAt = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, text, priority, recurrence, recurrenceDays, completed, completedAt, createdAt };
}

function normalizeTasks(value) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, TASKS_MAX).map(normalizeTask).filter(t => t.text.length > 0);
}

async function readTasks() {
  try {
    const raw = await fs.promises.readFile(TASKS_FILE, 'utf8');
    return normalizeTasks(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeTasks(tasks) {
  const safe = normalizeTasks(tasks);
  await fs.promises.writeFile(TASKS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

// ── Timers ────────────────────────────────────────────────────────────────────

let _timers = []; // in-memory timer list; persisted to TIMERS_FILE
let _timerCheckInterval = null;

function _normalizeTimer(item) {
  const id          = String(item && item.id || `t${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const label       = String(item && item.label || 'Timer').trim().slice(0, 40);
  const durationSecs = Math.max(1, Math.round(Number(item && item.durationSecs) || 60));
  const status      = ['running', 'paused', 'done'].includes(item && item.status) ? item.status : 'running';
  const startedAt   = Number.isFinite(Number(item && item.startedAt)) ? Number(item.startedAt) : Date.now();
  const pausedElapsed = Math.max(0, Number(item && item.pausedElapsed) || 0);
  const createdAt   = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, label, durationSecs, status, startedAt, pausedElapsed, createdAt };
}

function _getTimerRemaining(t) {
  if (t.status === 'done')   return 0;
  if (t.status === 'paused') return Math.max(0, t.durationSecs - t.pausedElapsed);
  const elapsed = t.pausedElapsed + (Date.now() - t.startedAt) / 1000;
  return Math.max(0, t.durationSecs - elapsed);
}

async function _saveTimers() {
  try {
    await fs.promises.writeFile(TIMERS_FILE, JSON.stringify(_timers, null, 2), 'utf8');
  } catch {}
}

function _checkTimers() {
  let changed = false;
  for (const t of _timers) {
    if (t.status === 'running' && _getTimerRemaining(t) <= 0) {
      t.status = 'done';
      changed = true;
      broadcastSSE('timer_done', { id: t.id, label: t.label });
    }
  }
  if (changed) {
    _saveTimers();
    broadcastSSE('timer_update', { timers: _timers });
  }
}

async function _initTimers() {
  try {
    const raw = await fs.promises.readFile(TIMERS_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    _timers = (Array.isArray(loaded) ? loaded : []).slice(0, TIMERS_MAX).map(_normalizeTimer);
  } catch (e) {
    if (e.code !== 'ENOENT') process.stdout.write(`[timers] load error: ${e.message}\n`);
    _timers = [];
  }
  if (_timerCheckInterval) clearInterval(_timerCheckInterval);
  _timerCheckInterval = setInterval(_checkTimers, 1000);
  _timerCheckInterval.unref();
}

// ── Server-Sent Events infrastructure ────────────────────────────────────────
// Clients connect to GET /sse and receive named events instead of polling.
// Each event carries the same JSON payload the old poll endpoints returned,
// so the client-side render functions need no changes — only the fetch trigger
// changes from setInterval to EventSource.

const sseClients = new Set();

function broadcastSSE(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch { sseClients.delete(res); }
  }
}

// Security: only accept connections from loopback addresses.
// Double-checked at both the TCP socket level (remoteAddress) and the HTTP Host header
// level, so DNS-rebinding / Host-spoofing attacks from non-loopback IPs are blocked.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:3030', 'localhost:3030', '[::1]:3030',
  '127.0.0.1', 'localhost', '[::1]',
]);

function isAllowedRequest(req) {
  // Layer 1: TCP source IP must be loopback (blocks LAN spoofing regardless of Host)
  const remoteAddr = req.socket.remoteAddress || '';
  if (!LOOPBACK_IPS.has(remoteAddr)) return false;

  // Layer 2: Host header must be a loopback address (protects against DNS rebinding)
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;

  // Layer 3: If an Origin header is present, it must also be loopback or opaque.
  // 'null' = opaque origin from Qt WebEngine (file:// or qrc:// page) — allowed.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return false;
    } catch { return false; }
  }
  return true;
}

// Enumerate DirectShow audio devices via ffmpeg. Returns an array of friendly device name strings.
async function _enumSttDevice() {
  const ffmpeg = getFfmpegPath();
  let stderr = '';
  try {
    await new Promise(resolve => {
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', resolve);
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 5000);
    });
  } catch {}

  const names = [];
  let inAudioSection = false; // for ffmpeg <7 (section-based format)

  for (const line of stderr.split('\n')) {
    if (/Alternative name/i.test(line)) continue;

    // ffmpeg 7+ format: [in#0 @ ...] "Device Name" (audio)
    const newFmt = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (newFmt && !newFmt[1].startsWith('@device_')) { names.push(newFmt[1]); continue; }

    // ffmpeg <7 format: section header + [dshow @ ...] "Device Name"
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
    if (inAudioSection) {
      const oldFmt = line.match(/"([^@][^"]+)"/);
      if (oldFmt) names.push(oldFmt[1]);
    }
  }
  return names;
}

async function _initSttDevice() {
  const ffmpeg = getFfmpegPath();

  // Probe WASAPI support — if ffmpeg knows the format, use it (fast init ~200ms)
  let wasapiOk = false;
  try {
    await new Promise(resolve => {
      let stderr = '';
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'wasapi', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', () => { wasapiOk = !/Unknown input format/i.test(stderr); resolve(); });
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 4000);
    });
  } catch {}

  if (wasapiOk) {
    _sttUseWasapi = true;
    process.stdout.write('[STT] WASAPI available — fast init\n');
  } else {
    // WASAPI not supported — enumerate DirectShow devices as fallback
    try {
      const names = await _enumSttDevice();
      if (names.length > 0) {
        let chosen = null;
        if (cachedMicLabel) {
          const lbl = cachedMicLabel.toLowerCase();
          chosen = names.find(d => d.toLowerCase().includes(lbl));
        }
        _sttDshowDevice = chosen || names[0];
        process.stdout.write(`[STT] WASAPI unavailable, dshow: "${_sttDshowDevice}"\n`);
      } else {
        process.stdout.write('[STT] No audio input method found\n');
      }
    } catch (e) {
      process.stdout.write('[STT] Device init error: ' + e.message + '\n');
    }
  }

  _sttDeviceReady = true;
  _sttDeviceWaiters.splice(0).forEach(cb => cb());
}

function _sttDeviceWhenReady() {
  return new Promise(resolve => {
    if (_sttDeviceReady) resolve();
    else _sttDeviceWaiters.push(resolve);
  });
}

function pcmToWav(pcmBytes, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const buf = Buffer.alloc(44 + pcmBytes.length);
  buf.write('RIFF', 0);         buf.writeUInt32LE(36 + pcmBytes.length, 4);
  buf.write('WAVE', 8);         buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);    buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buf.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);        buf.writeUInt32LE(pcmBytes.length, 40);
  pcmBytes.copy(buf, 44);
  return buf;
}

function _transcribeAudio(audioB64, mimeType, apiKey) {
  const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
  const safeMime = ALLOWED_AUDIO.has(mimeType) ? mimeType : 'audio/webm';
  const payload = JSON.stringify({
    contents: [{ parts: [
      { text: 'Transcribe this audio exactly as spoken. Output only the transcribed text, nothing else — no explanations, no punctuation beyond what was said. The user may mix Italian commands with English proper nouns (app names, brand names): always output them as separate words with a space between them (e.g. "apri Steam", not "apristim"; "apri Spotify", not "aprispot"; "apri Discord", not "apridiscord"). The recording may begin with a short notification chime or activation tone — ignore it completely and transcribe only human speech that follows. If the audio contains only silence, background noise, breathing, chimes, or music with no clear human speech, output exactly an empty string. Do NOT guess, invent, or output placeholder text.' },
      { inline_data: { mime_type: safeMime, data: audioB64 } },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'XenonEdgeWidget/2.0' },
    }, (geminiRes) => {
      let d = '';
      geminiRes.on('data', c => { d += c; });
      geminiRes.on('end', () => {
        process.stdout.write(`[STT] Gemini status=${geminiRes.statusCode} body=${d.slice(0, 400)}\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          resolve(parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '');
        } catch { reject(new Error('Gemini invalid JSON: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Web search via Gemini grounding. Runs as a SEPARATE call from the main chat
// because the google_search grounding tool cannot be combined with
// functionDeclarations in the same request (doing so makes Gemini return empty
// responses). Returns a short grounded answer plus source URLs. On any failure
// resolves with an { error } object so the caller can degrade gracefully.
function _geminiWebSearch(query, apiKey) {
  return new Promise((resolve) => {
    const q = String(query || '').trim().slice(0, 500);
    if (!q) return resolve({ error: 'empty query' });
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: q }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 700, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
    });
    const t0 = Date.now();
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'XenonEdgeWidget/2.0' },
    }, (r) => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        process.stdout.write(`[WebSearch] Gemini HTTP ${r.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return resolve({ error: parsed.error.message || 'search error' });
          const cand = parsed?.candidates?.[0];
          const text = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
          // Collect grounding source URLs/titles when present
          const chunks = cand?.groundingMetadata?.groundingChunks || [];
          const sources = chunks
            .map(c => c.web && { title: c.web.title || '', uri: c.web.uri || '' })
            .filter(Boolean).slice(0, 5);
          if (!text) return resolve({ error: 'no result' });
          resolve({ answer: text, sources });
        } catch { resolve({ error: 'invalid JSON' }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'search timeout' }); });
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers required for the iCUE widget WebView (opaque origin, qrc:// or file://).
  // Access-Control-Allow-Private-Network is required by Chrome 104+ (Private Network
  // Access spec) when a non-secure context (file://) fetches a private-network address.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSONP support: if ?cb=<name> is present, wrap the response in a JS callback.
  // Used by the iCUE widget where fetch() is blocked by Qt WebEngine's
  // LocalContentCanAccessRemoteUrls policy; <script> tag injection bypasses it.
  const urlObj  = new URL(req.url, 'http://localhost');
  const jsonpCb = urlObj.searchParams.get('cb');
  const json    = data => {
    const body = JSON.stringify(data);
    if (jsonpCb && /^[A-Za-z_$][\w$]*$/.test(jsonpCb)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(jsonpCb + '(' + body + ');');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }
  };
  const err500 = msg  => { res.writeHead(500); res.end(String(msg)); };

  const reqPath = urlObj.pathname;

  if (reqPath === '/' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

  } else if (reqPath === '/toggle' && (req.method === 'POST' || req.method === 'GET')) {
    isMuted = !isMuted;
    setMicMute(isMuted);
    json({ muted: isMuted });

  } else if (reqPath === '/ping' && req.method === 'GET') {
    // 1×1 transparent GIF — used by the iCUE widget to probe connectivity via
    // Image() instead of fetch(), bypassing Qt WebEngine's LocalContentCanAccessRemoteUrls block.
    const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    res.end(gif);

  } else if (reqPath === '/status' && req.method === 'GET') {
    json({ muted: isMuted });

  } else if (reqPath === '/audio' && req.method === 'GET') {
    try   { json(await getAudioInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/system' && req.method === 'GET') {
    try   { json(await getSystemInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/network' && req.method === 'GET') {
    try   { json(await getNetworkInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/weather' && req.method === 'GET') {
    try {
      const requestedWeather = urlObj.searchParams.has('mode') || urlObj.searchParams.has('city')
        ? { mode: urlObj.searchParams.get('mode'), city: urlObj.searchParams.get('city') }
        : null;
      json(await getWeather(urlObj.searchParams.get('lang') || 'it', requestedWeather));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media' && req.method === 'GET') {
    try {
      if (urlObj.searchParams.has('source')) setMediaPreferredSource(urlObj.searchParams.get('source'));
      json(await getMediaInfo());
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/source' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let body = {};
      if (req.method === 'POST') body = JSON.parse(await readBody(req) || '{}');
      const source = body.source ?? urlObj.searchParams.get('source') ?? '';
      json({ ok: true, preferredSource: setMediaPreferredSource(source) });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/media/playpause' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('playpause')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/next' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('next')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/previous' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('previous')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows' && req.method === 'GET') {
    try   { json(await runPowerShellScript(WINDOWS_SCRIPT, ['list'], 12000)); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows/focus' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runPowerShellScript(WINDOWS_SCRIPT, ['focus', id], 5000));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/volume/set' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      if (!cachedSpeakerId) { err500('Cache not ready'); return; }
      execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], e => {
        if (e) err500(e.message); else json({ ok: true, level: vol });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/volume' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      if (!cachedMicId) { err500('Cache not ready'); return; }
      execFile(SVV, ['/SetVolume', cachedMicId, String(vol)], e => {
        if (e) err500(e.message); else json({ ok: true, level: vol });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/speaker/mute' && (req.method === 'POST' || req.method === 'GET')) {
    if (!cachedSpeakerId) { err500('Cache not ready'); return; }
    execFile(SVV, ['/Switch', cachedSpeakerId], e => {
      if (e) err500(e.message); else json({ ok: true });
    });

  } else if (reqPath === '/speaker/set' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      execFile(SVV, ['/SetDefault', id, 'all'], e => {
        if (e) err500(e.message); else { cachedSpeakerId = id; json({ ok: true }); }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/set' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      execFile(SVV, ['/SetDefault', id, 'all'], e => {
        if (e) { err500(e.message); return; }
        cachedMicId = id;
        if (isMuted) setMicMute(true);
        json({ ok: true });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/notes' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    fs.promises.readFile(NOTES_FILE, 'utf8')
      .then(notes => json({ notes }))
      .catch(e => {
        if (e.code === 'ENOENT') json({ notes: '' });
        else err500(e.message);
      });

  } else if (reqPath === '/notes' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let notes;
      if (req.method === 'GET') {
        notes = urlObj.searchParams.get('data') || '';
      } else {
        const body = JSON.parse(await readBody(req));
        notes = typeof body.notes === 'string' ? body.notes : (typeof body.text === 'string' ? body.text : '');
      }
      // Cap at 200 KB to prevent disk exhaustion via repeated saves.
      const safe = String(notes).slice(0, 200_000);
      fs.promises.writeFile(NOTES_FILE, safe, 'utf8')
        .then(() => json({ ok: true, savedAt: Date.now() }))
        .catch(e => err500(e.message));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'GET') {
    try { json({ settings: await readHubSettings() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'POST') {
    try {
      const body    = JSON.parse(await readBody(req));
      const prev    = await readHubSettings().catch(() => null);
      const settings = await writeHubSettings(body.settings || body);
      // Restart wake word detector when Gemini key changes
      if (settings.geminiApiKey !== (prev && prev.geminiApiKey)) {
        stopServerWakeWord();
        if (settings.geminiApiKey) startServerWakeWord(settings.geminiApiKey);
      }
      json({ ok: true, settings, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    try { json({ events: await readEvents() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let body;
      if (req.method === 'GET') {
        body = JSON.parse(urlObj.searchParams.get('data') || '[]');
      } else {
        body = JSON.parse(await readBody(req));
      }
      const events = await writeEvents(body.events || body);
      json({ ok: true, events, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'GET') {
    try { json({ tasks: await readTasks() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const tasks = await writeTasks(body.tasks || body);
      json({ ok: true, tasks, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  // ── Timers API ────────────────────────────────────────────────────────────
  } else if (reqPath === '/api/timers' && req.method === 'GET') {
    json({ timers: _timers });

  } else if (reqPath === '/api/timers' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (_timers.length >= TIMERS_MAX) { res.writeHead(400); res.end(JSON.stringify({ error: 'max timers reached' })); return; }
      const timer = _normalizeTimer({
        label: String(body.label || 'Timer').trim(),
        durationSecs: Math.max(1, Math.round(Number(body.duration_secs) || 60)),
        status: 'running',
        startedAt: Date.now(),
        pausedElapsed: 0,
      });
      _timers.push(timer);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ timer });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'PATCH') {
    try {
      const tid = decodeURIComponent(reqPath.slice('/api/timers/'.length));
      const body = JSON.parse(await readBody(req));
      const action = String(body.action || '').trim();
      const idx = _timers.findIndex(t => t.id === tid);
      if (idx < 0) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      const t = { ..._timers[idx] };
      if (action === 'pause' && t.status === 'running') {
        t.pausedElapsed += (Date.now() - t.startedAt) / 1000;
        t.status = 'paused';
      } else if (action === 'resume' && t.status === 'paused') {
        t.startedAt = Date.now();
        t.status = 'running';
      } else if (action === 'reset') {
        t.startedAt = Date.now();
        t.pausedElapsed = 0;
        t.status = 'running';
      }
      _timers[idx] = t;
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ timer: t });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'DELETE') {
    try {
      const tid = decodeURIComponent(reqPath.slice('/api/timers/'.length));
      _timers = _timers.filter(t => t.id !== tid);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/lock' && req.method === 'POST') {
    exec('rundll32.exe user32.dll,LockWorkStation', e => {
      if (e) err500(e.message); else json({ ok: true });
    });

  } else if (reqPath === '/api/ai' && req.method === 'POST') {
    try {
      const aiRaw = await readBodyBuffer(req, 10 * 1024 * 1024); // 10 MB — accommodate base64 images
      const aiBody = JSON.parse(aiRaw.toString('utf8') || '{}');
      const apiKey = String(aiBody.key || '').trim().slice(0, 200);
      const messages = Array.isArray(aiBody.messages) ? aiBody.messages.slice(0, 50) : [];

      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      if (!messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_messages' })); return;
      }

      const AI_FUNCTIONS = [
        // ── Microphone ──
        { name: 'toggle_mic', description: 'Toggle microphone mute/unmute', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'mute_mic', description: 'Mute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'unmute_mic', description: 'Unmute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        // ── Media ──
        { name: 'media_playpause', description: 'Play or pause current media playback', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_next', description: 'Skip to the next track', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_previous', description: 'Go to the previous track', parameters: { type: 'OBJECT', properties: {} } },
        // ── Volume ──
        { name: 'set_volume', description: 'Set master speaker volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Volume level 0-100' } }, required: ['level'] } },
        // ── System ──
        { name: 'lock_pc', description: 'Lock the Windows workstation', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_system_info', description: 'Get current CPU, GPU, RAM and disk usage stats', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_weather', description: 'Get current weather conditions and forecast', parameters: { type: 'OBJECT', properties: {} } },
        // ── Web search ──
        { name: 'web_search', description: 'Search the internet for current, recent, or real-time information you are not certain about (news, prices, sports scores, release dates, live facts, anything after your training cutoff). Returns a grounded summary with sources. Use it instead of guessing whenever freshness matters.', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'The search query, phrased clearly (e.g. "EUR USD exchange rate today", "latest iPhone model 2026")' },
        }, required: ['query'] } },
        // ── Screen vision ──
        { name: 'capture_screen', description: 'Capture a fresh screenshot of the user\'s screen so you can see what is currently displayed. Use it whenever the user asks about what is on their screen, asks you to read/look at/check something visual, or references on-screen content. The capture is always live (current moment). On multi-monitor setups, pass the 1-based monitor number; if the user did not say which monitor and there are several, omit it to receive the monitor list and then ask which one to focus on.', parameters: { type: 'OBJECT', properties: { monitor: { type: 'NUMBER', description: '1-based monitor index to capture (e.g. 1, 2). Omit on single-monitor setups or to list monitors first.' } } } },
        // ── Notes ──
        { name: 'read_notes', description: 'Read the current notes/scratchpad content', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'write_notes', description: 'Replace the notes content with new text', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING', description: 'New notes content' } }, required: ['content'] } },
        // ── Tasks ──
        { name: 'list_tasks', description: 'List all tasks in the task list', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_task', description: 'Create a new task in the task list', parameters: { type: 'OBJECT', properties: {
          text: { type: 'STRING', description: 'Task description' },
          priority: { type: 'STRING', description: 'Priority: high, medium, or low (default: medium)' },
        }, required: ['text'] } },
        // ── Calendar ──
        { name: 'list_calendar_events', description: 'List upcoming calendar events', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_calendar_event', description: 'Create a new calendar event', parameters: { type: 'OBJECT', properties: {
          title: { type: 'STRING', description: 'Event title' },
          starts_at: { type: 'STRING', description: 'Start datetime in ISO 8601, e.g. 2026-05-25T14:00:00' },
          notes: { type: 'STRING', description: 'Optional notes' },
          reminder_at: { type: 'STRING', description: 'Optional reminder datetime in ISO 8601' },
        }, required: ['title', 'starts_at'] } },
        // ── Dashboard UI ──
        { name: 'open_weather_panel', description: 'Open the weather details panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_settings', description: 'Open the settings panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_app_switcher', description: 'Open the app switcher panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'show_lock_screen', description: 'Show the focus lock screen overlay', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'change_theme', description: 'Change the dashboard color theme (xenon, ocean, ember, violet, mono)', parameters: { type: 'OBJECT', properties: { preset: { type: 'STRING', description: 'Theme name' } }, required: ['preset'] } },
        { name: 'close_ai_panel', description: 'Close the Xenon AI chat panel', parameters: { type: 'OBJECT', properties: {} } },
        // ── Timers ──
        { name: 'start_timer', description: 'Start a new countdown timer. Use for user requests like "set a timer for 5 minutes", "remind me in 30 seconds", etc.', parameters: { type: 'OBJECT', properties: {
          label: { type: 'STRING', description: 'Short label for the timer, e.g. "Pasta", "Break", "Meeting"' },
          duration_secs: { type: 'NUMBER', description: 'Duration in seconds (e.g. 300 for 5 minutes, 3600 for 1 hour)' },
        }, required: ['duration_secs'] } },
        { name: 'list_timers', description: 'List all active timers and their remaining time', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'delete_timer', description: 'Delete a timer by its id', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Timer id to delete' },
        }, required: ['id'] } },
        // ── System launcher ──
        { name: 'open_application', description: 'Open an app, website, or file on the user\'s Windows PC. For well-known apps use their plain name (spotify, chrome, notepad, obs, vlc…). For Steam use exactly "steam", for Discord use "discord". Full URLs (https://…) and absolute file paths also work.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name (e.g. "spotify", "steam", "discord"), full URL, or absolute file path' },
        }, required: ['target'] } },
      ];

      const CLIENT_ACTIONS = new Set(['open_weather_panel', 'open_settings', 'open_app_switcher', 'show_lock_screen', 'change_theme', 'close_ai_panel', 'refresh_tasks', 'refresh_calendar', 'refresh_timers']);

      // Validate and sanitise image parts sent by the client
      const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
      const rawImageParts = Array.isArray(aiBody.imageParts) ? aiBody.imageParts.slice(0, 4) : [];
      const safeImageParts = rawImageParts
        .filter(p => p && ALLOWED_IMAGE_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 8 * 1024 * 1024) }));

      // Inject images into the last user message (current turn only — not stored in history)
      let currentMessages = messages.slice();
      if (safeImageParts.length > 0 && currentMessages.length > 0) {
        const last = currentMessages[currentMessages.length - 1];
        if (last.role === 'user') {
          currentMessages[currentMessages.length - 1] = {
            role: 'user',
            parts: [...(last.parts || []), ...safeImageParts.map(p => ({ inlineData: p }))],
          };
        }
      }

      const callGemini = (msgs) => new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          system_instruction: { parts: [{ text: 'You are Xenon, a capable, helpful AI assistant embedded in XenonEdge Hub — a real-time dashboard for the CORSAIR Xeneon Edge 14.5" display. Answer ANY question the user asks, drawing on your broad general knowledge (technology, science, history, everyday topics, etc.). For anything recent, live, or that you are not certain about (news, prices, sports results, weather elsewhere, release dates, "what is X today"…), call web_search to look it up on the internet instead of guessing — then answer using the results. Dashboard controls you can use: toggle mic mute, control media playback (play/pause/next/previous), set volume, read/write notes, manage tasks and calendar events, start/delete timers, change theme, open the lock screen, open the weather/settings/app-switcher panels. You can open any app, website, or file on Windows via open_application. You can capture a screenshot of any monitor and analyse images the user shares — if there are multiple monitors and the user did not specify one, ask which to use. When creating tasks, events, or timers, confirm briefly what was created. Always reply in the same language as the user. Be concise but complete, and natural to listen to (your replies may be read aloud). IMPORTANT — speech-to-text artefacts: the STT engine may occasionally merge consecutive words when the user mixes Italian with English proper nouns. If you receive something like "apristim", "aprispot", "apridiscord", or similar phonetic mashups, interpret them as the most likely Italian command plus the English app name (e.g. "apristim" → open Steam, "aprispot" → open Spotify). Always prefer a command interpretation over treating the input as gibberish.' }] },
          tools: [{ functionDeclarations: AI_FUNCTIONS }],
          contents: msgs,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
        });
        const aiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'XenonEdgeWidget/2.0' },
        }, (aiRes) => {
          let data = '';
          aiRes.on('data', chunk => { data += chunk; });
          aiRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              else resolve(parsed);
            } catch (parseErr) { reject(parseErr); }
          });
        });
        aiReq.on('error', reject);
        aiReq.setTimeout(20000, () => { aiReq.destroy(); reject(new Error('Gemini request timed out')); });
        aiReq.write(payload);
        aiReq.end();
      });

      const getCandidate = (r) => {
        const content = r.candidates && r.candidates[0] && r.candidates[0].content;
        const part = content && content.parts && content.parts[0];
        return { content, part };
      };

      // currentMessages already built above (with optional imageParts injected)
      const clientActions = [];

      let geminiResult = await callGemini(currentMessages);
      let { content, part } = getCandidate(geminiResult);

      // Function calling loop — up to 3 server-side iterations
      let pendingScreenImage = null; // base64 JPEG to feed Gemini after capture_screen
      for (let iter = 0; iter < 3 && part && part.functionCall; iter++) {
        const fnName = part.functionCall.name;
        const fnArgs = part.functionCall.args || {};
        currentMessages = [...currentMessages, content];

        let fnResult;
        if (CLIENT_ACTIONS.has(fnName)) {
          clientActions.push({ action: fnName, args: fnArgs });
          fnResult = { ok: true };
        } else {
          try {
            if (fnName === 'toggle_mic') {
              isMuted = !isMuted; setMicMute(isMuted);
              fnResult = { ok: true, muted: isMuted };
            } else if (fnName === 'mute_mic') {
              isMuted = true; setMicMute(true);
              fnResult = { ok: true, muted: true };
            } else if (fnName === 'unmute_mic') {
              isMuted = false; setMicMute(false);
              fnResult = { ok: true, muted: false };
            } else if (fnName === 'media_playpause') {
              fnResult = await mediaAction('playpause');
            } else if (fnName === 'media_next') {
              fnResult = await mediaAction('next');
            } else if (fnName === 'media_previous') {
              fnResult = await mediaAction('previous');
            } else if (fnName === 'set_volume') {
              const vol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
              if (cachedSpeakerId) {
                await new Promise((resolve, reject) => {
                  execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], e => e ? reject(e) : resolve());
                });
              }
              fnResult = { ok: true, level: vol };
            } else if (fnName === 'lock_pc') {
              await new Promise((resolve, reject) => {
                exec('rundll32.exe user32.dll,LockWorkStation', e => e ? reject(e) : resolve());
              });
              fnResult = { ok: true };
            } else if (fnName === 'capture_screen') {
              const screens = await listScreens();
              const reqMon = fnArgs.monitor != null ? parseInt(fnArgs.monitor) - 1 : -1;
              if (screens.length > 1 && (reqMon < 0 || reqMon >= screens.length)) {
                // Ambiguous on a multi-monitor setup — show a clickable picker in the UI
                // and let Gemini inform the user verbally at the same time.
                clientActions.push({
                  action: 'show_monitor_picker',
                  args: {
                    screens: screens.map((s, i) => ({
                      index: i + 1, primary: s.primary,
                      width: s.width, height: s.height,
                      x: s.x, y: s.y,
                    })),
                  },
                });
                fnResult = {
                  needs_monitor_choice: true,
                  monitor_count: screens.length,
                  monitors: screens.map((s, i) => ({ number: i + 1, primary: s.primary, resolution: `${s.width}x${s.height}` })),
                };
              } else {
                const target = screens.length === 1 ? screens[0]
                  : (reqMon >= 0 ? screens[reqMon] : (screens.find(s => s.primary) || screens[0]));
                _aiFocusedScreen = target;
                try {
                  pendingScreenImage = await captureScreenshot(target);
                  fnResult = { ok: true, captured: true, monitor: screens.indexOf(target) + 1, resolution: `${target.width}x${target.height}` };
                } catch (capErr) {
                  fnResult = { error: 'capture failed: ' + capErr.message };
                }
              }
            } else if (fnName === 'get_system_info') {
              fnResult = await getSystemInfo();
            } else if (fnName === 'get_weather') {
              fnResult = await getWeather('it', null);
            } else if (fnName === 'web_search') {
              const searchRes = await _geminiWebSearch(fnArgs.query, apiKey);
              fnResult = searchRes.error
                ? { error: searchRes.error, note: 'web search unavailable — answer from your own knowledge and say it may not be up to date' }
                : { query: String(fnArgs.query || ''), result: searchRes.answer, sources: searchRes.sources };
            } else if (fnName === 'read_notes') {
              const notesText = await fs.promises.readFile(NOTES_FILE, 'utf8').catch(() => '');
              fnResult = { notes: notesText };
            } else if (fnName === 'write_notes') {
              const safe = String(fnArgs.content || '').slice(0, 200_000);
              await fs.promises.writeFile(NOTES_FILE, safe, 'utf8');
              clientActions.push({ action: 'refresh_notes', args: {} });
              fnResult = { ok: true };
            } else if (fnName === 'list_tasks') {
              const tasks = await readTasks();
              fnResult = { tasks: tasks.map(t => ({ id: t.id, text: t.text, priority: t.priority, completed: t.completed })) };
            } else if (fnName === 'create_task') {
              const taskText = String(fnArgs.text || '').trim();
              if (!taskText) { fnResult = { error: 'empty text' }; }
              else {
                const tasks = await readTasks();
                const newTask = normalizeTask({
                  text: taskText,
                  priority: TASK_PRIORITIES.includes(fnArgs.priority) ? fnArgs.priority : 'medium',
                  recurrence: 'never',
                });
                tasks.push(newTask);
                await writeTasks(tasks);
                clientActions.push({ action: 'refresh_tasks', args: {} });
                fnResult = { ok: true, task: { id: newTask.id, text: newTask.text, priority: newTask.priority } };
              }
            } else if (fnName === 'list_calendar_events') {
              const events = await readEvents();
              const now = new Date().toISOString();
              const upcoming = events
                .filter(e => !e.startsAt || e.startsAt >= now)
                .sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''))
                .slice(0, 20);
              fnResult = { events: upcoming.map(e => ({ id: e.id, title: e.title, startsAt: e.startsAt, notes: e.notes })) };
            } else if (fnName === 'create_calendar_event') {
              const evTitle = String(fnArgs.title || '').trim();
              if (!evTitle) { fnResult = { error: 'empty title' }; }
              else {
                const events = await readEvents();
                const newEvent = {
                  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                  title: evTitle.slice(0, 120),
                  notes: String(fnArgs.notes || '').trim().slice(0, 600),
                  startsAt: String(fnArgs.starts_at || '').trim(),
                  reminderAt: String(fnArgs.reminder_at || '').trim(),
                  notifiedAt: '',
                  createdAt: new Date().toISOString(),
                };
                events.push(newEvent);
                await writeEvents(events);
                clientActions.push({ action: 'refresh_calendar', args: {} });
                fnResult = { ok: true, event: { id: newEvent.id, title: newEvent.title, startsAt: newEvent.startsAt } };
              }
            } else if (fnName === 'open_application') {
              const rawTarget = String(fnArgs.target || '').trim();
              if (!rawTarget) { fnResult = { error: 'target mancante' }; }
              else {
                // Some apps are more reliably opened via their registered URI protocol
                // than via App Paths name lookup (e.g. Steam doesn't always resolve by
                // name). Use canonical deep links that actually open a window — a bare
                // "steam://" invokes the handler but opens nothing visible.
                const PROTOCOL_MAP = {
                  'steam': 'steam://open/main', 'steam client': 'steam://open/main',
                  'discord': 'discord://',
                  'whatsapp': 'whatsapp://',
                  'slack': 'slack://',
                  'zoom': 'zoommtg://',
                  'epic': 'com.epicgames.launcher://apps',
                  'epic games': 'com.epicgames.launcher://apps',
                };
                const resolved = PROTOCOL_MAP[rawTarget.toLowerCase()] || rawTarget;
                // Escape single quotes for PowerShell single-quoted strings
                const psEscaped = resolved.replace(/'/g, "''");
                // Use ShellExecute (UseShellExecute=true) for reliable App Paths & protocol lookup.
                // Unlike `cmd /c start`, this gives a real exception on failure → detectable error.
                const ps = `try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='${psEscaped}';UseShellExecute=$true})}catch{exit 1}`;
                try {
                  await new Promise((resolve, reject) =>
                    execFile('powershell.exe',
                      ['-NoProfile', '-NonInteractive', '-Command', ps],
                      { windowsHide: true, timeout: 10000 },
                      (err) => err ? reject(new Error(`"${rawTarget}" non trovato o non installato`)) : resolve()
                    )
                  );
                  fnResult = { ok: true, opened: rawTarget };
                } catch (launchErr) {
                  fnResult = { error: launchErr.message };
                }
              }
            } else if (fnName === 'start_timer') {
              const durSecs = Math.max(1, Math.round(Number(fnArgs.duration_secs) || 60));
              const timerLabel = String(fnArgs.label || 'Timer').trim().slice(0, 40);
              if (_timers.length >= TIMERS_MAX) {
                fnResult = { error: 'Too many timers active' };
              } else {
                const newTimer = _normalizeTimer({ label: timerLabel, durationSecs: durSecs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 });
                _timers.push(newTimer);
                await _saveTimers();
                clientActions.push({ action: 'refresh_timers', args: {} });
                broadcastSSE('timer_update', { timers: _timers });
                const mins = Math.floor(durSecs / 60), secs = durSecs % 60;
                const durationLabel = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins} min`) : `${secs}s`;
                fnResult = { ok: true, id: newTimer.id, label: timerLabel, duration: durationLabel };
              }
            } else if (fnName === 'list_timers') {
              fnResult = {
                timers: _timers.map(t => ({
                  id: t.id, label: t.label, status: t.status,
                  remaining_secs: Math.ceil(_getTimerRemaining(t)),
                  duration_secs: t.durationSecs,
                })),
              };
            } else if (fnName === 'delete_timer') {
              const delId = String(fnArgs.id || '').trim();
              const before = _timers.length;
              _timers = _timers.filter(t => t.id !== delId);
              if (_timers.length < before) {
                await _saveTimers();
                clientActions.push({ action: 'refresh_timers', args: {} });
                broadcastSSE('timer_update', { timers: _timers });
                fnResult = { ok: true };
              } else {
                fnResult = { error: 'timer not found' };
              }
            } else {
              fnResult = { error: 'unknown_function' };
            }
          } catch (fnErr) {
            fnResult = { error: fnErr.message };
          }
        }

        currentMessages = [...currentMessages, {
          role: 'user',
          parts: [{ functionResponse: { name: fnName, response: { output: JSON.stringify(fnResult) } } }],
        }];

        // Feed the captured screenshot to Gemini so it can actually see the screen.
        if (pendingScreenImage) {
          currentMessages.push({
            role: 'user',
            parts: [
              { text: 'Here is the current screenshot of the requested monitor.' },
              { inlineData: { mimeType: 'image/jpeg', data: pendingScreenImage } },
            ],
          });
          pendingScreenImage = null;
        }

        geminiResult = await callGemini(currentMessages);
        ({ content, part } = getCandidate(geminiResult));
      }

      const text = (part && part.text) ? part.text : '';
      json({ text, clientActions, newContent: content });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/log' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, 4 * 1024);
      const { msg } = JSON.parse(body.toString('utf8') || '{}');
      if (typeof msg === 'string') process.stdout.write('[CLIENT] ' + msg + '\n');
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/api/screens' && req.method === 'GET') {
    try {
      const psScript = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }';
      const stdout = await new Promise((resolve, reject) =>
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { maxBuffer: 64 * 1024, windowsHide: true },
          (err, out) => err ? reject(err) : resolve(out)
        )
      );
      const screens = stdout.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
        const [x, y, w, h, primary, dev] = line.trim().split('|');
        const label = (dev || '').replace(/^\\\\.\\/, '').trim() || `DISPLAY${i + 1}`;
        return { index: i, x: parseInt(x) || 0, y: parseInt(y) || 0, width: parseInt(w) || 1920, height: parseInt(h) || 1080, primary: primary === 'True', name: label };
      });
      json({ screens });
    } catch {
      json({ screens: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }] });
    }

  } else if (reqPath === '/api/screenshot' && req.method === 'GET') {
    const tmpPath = path.join(os.tmpdir(), `xenon_ss_${Date.now()}.jpg`);
    try {
      const ffmpeg = getFfmpegPath();
      const px = urlObj.searchParams.get('x');
      const py = urlObj.searchParams.get('y');
      const pw = urlObj.searchParams.get('w');
      const ph = urlObj.searchParams.get('h');
      const ffmpegArgs = ['-y', '-f', 'gdigrab', '-framerate', '1'];
      if (px !== null && py !== null && pw !== null && ph !== null) {
        const w = parseInt(pw), h = parseInt(ph);
        if (w > 0 && h > 0) {
          ffmpegArgs.push('-offset_x', px, '-offset_y', py, '-video_size', `${w}x${h}`);
        }
      }
      // gdigrab -vframes 1 takes a single screenshot frame
      ffmpegArgs.push('-i', 'desktop', '-vframes', '1', '-q:v', '3', '-vf', 'scale=\'min(1920,iw)\':-2', tmpPath);
      await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
      const imgBuffer = await fs.promises.readFile(tmpPath);
      const base64 = imgBuffer.toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ base64, mimeType: 'image/jpeg' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

  } else if (reqPath === '/api/stt/start' && req.method === 'POST') {
    try {
      await readBody(req);
      await Promise.race([
        _sttDeviceWhenReady(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('STT device timeout')), 10000)),
      ]);
      if (!_sttUseWasapi && !_sttDshowDevice) throw new Error('No audio device available for recording');
      // Prevent two concurrent STT sessions (e.g. two browser tabs receiving the same wake event)
      if (_sttPending.size > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'already_recording' })); return;
      }
      _wakeKillClip(); // release mic from wake word recording before STT starts

      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const wavPath = path.join(os.tmpdir(), `xenon-stt-${id}.wav`);

      let resolveRecording, resolveSaved;
      const recordingStarted = new Promise(r => { resolveRecording = r; });
      const recordingSaved   = new Promise(r => { resolveSaved   = r; });

      const ffmpeg = getFfmpegPath();
      const inputArgs = _sttUseWasapi
        ? ['-f', 'wasapi', '-i', 'default']
        : ['-f', 'dshow', '-i', `audio=${_sttDshowDevice}`];
      const ffmpegProc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'info',
        ...inputArgs,
        '-af', 'silencedetect=noise=-32dB:d=0.8',
        '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
        '-y', wavPath,
      ], { windowsHide: true });

      ffmpegProc.stdin.setDefaultEncoding('utf8');
      ffmpegProc.stderr.setEncoding('utf8');

      let stderrAccum = '';
      let didStart = false;
      let silenceNotified = false;
      ffmpegProc.stderr.on('data', d => {
        stderrAccum += d;
        if (!didStart && /Press \[q\] to stop/i.test(stderrAccum)) {
          didStart = true;
          resolveRecording();
        }
        // End-of-speech detection: a silence_start at t>=1s means the user spoke
        // and then paused — notify the client to stop recording immediately so the
        // assistant feels responsive instead of waiting out a fixed window.
        if (!silenceNotified) {
          const m = d.match(/silence_start:\s*([\d.]+)/);
          if (m && parseFloat(m[1]) >= 1.0) {
            silenceNotified = true;
            broadcastSSE('stt_silence', { id });
          }
        }
      });
      ffmpegProc.on('exit', () => resolveSaved());
      ffmpegProc.on('error', e => {
        process.stdout.write('[STT] ffmpeg error: ' + e.message + '\n');
        if (!didStart) { didStart = true; resolveRecording(); }
        resolveSaved();
      });

      _sttPending.set(id, { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved });

      await Promise.race([
        recordingStarted,
        new Promise((_, rej) => setTimeout(() => rej(new Error('ffmpeg did not start recording')), 6000)),
      ]);
      process.stdout.write(`[STT] Recording id=${id} via=${_sttUseWasapi ? 'wasapi' : 'dshow'}\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/stt/stop' && req.method === 'POST') {
    try {
      const stopBody = JSON.parse(await readBody(req) || '{}');
      const id = String(stopBody.id || '').trim();
      const apiKey = String(stopBody.key || '').trim().slice(0, 200);
      const rec = _sttPending.get(id);
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' })); return;
      }
      // Stop ffmpeg gracefully — send 'q' then close stdin (EOF)
      try { rec.ffmpegProc.stdin.write('q'); rec.ffmpegProc.stdin.end(); } catch {}
      await Promise.race([rec.recordingSaved, new Promise(r => setTimeout(r, 6000))]);
      _sttPending.delete(id);
      let wavData = null;
      try { wavData = await fs.promises.readFile(rec.wavPath); } catch {}
      fs.promises.unlink(rec.wavPath).catch(() => {});
      // Whole-clip RMS — used both for logging and as a speech gate below.
      let clipRms = 0;
      if (wavData && wavData.length > 44) {
        const pcm = wavData.slice(44);
        let sumSq = 0;
        const n = pcm.length - (pcm.length % 2);
        for (let i = 0; i + 1 < n; i += 2) sumSq += pcm.readInt16LE(i) ** 2;
        clipRms = n > 0 ? Math.sqrt(sumSq / (n / 2)) : 0;
        process.stdout.write(`[STT] Stopped id=${id} wavSize=${wavData.length} rms=${clipRms.toFixed(1)}\n`);
      } else {
        process.stdout.write(`[STT] Stopped id=${id} wavSize=${wavData ? wavData.length : 0}\n`);
      }
      if (!wavData || wavData.length < 100) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '' })); return;
      }
      // Speech gate: silence/background noise sits well below spoken voice
      // (observed ~400 for silence vs ~800+ for real speech). Below the floor
      // we return empty instead of letting Gemini hallucinate a plausible
      // command (e.g. "apri Spotify") from near-silent audio.
      if (clipRms > 0 && clipRms < STT_SPEECH_MIN) {
        process.stdout.write(`[STT] Below speech floor (${clipRms.toFixed(1)} < ${STT_SPEECH_MIN}) → empty\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '' })); return;
      }
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      const sttText = await _transcribeAudio(wavData.toString('base64'), 'audio/wav', apiKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: sttText }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/transcribe' && req.method === 'POST') {
    try {
      const tRaw = await readBodyBuffer(req, 30 * 1024 * 1024);
      const tBody = JSON.parse(tRaw.toString('utf8') || '{}');
      const apiKey = String(tBody.key || '').trim().slice(0, 200);
      const audioB64 = typeof tBody.audio === 'string' ? tBody.audio.slice(0, 20 * 1024 * 1024) : '';
      const rawMime = typeof tBody.mimeType === 'string' ? tBody.mimeType : 'audio/webm';
      const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
      const safeMime = ALLOWED_AUDIO.has(rawMime) ? rawMime : 'audio/webm';
      if (!apiKey || !audioB64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const tPayload = JSON.stringify({
        contents: [{ parts: [
          { text: 'Transcribe this audio exactly as spoken. Output only the transcribed text, nothing else — no explanations, no punctuation beyond what was said. The user may mix Italian commands with English proper nouns (app names, brand names): always output them as separate words with a space between them (e.g. "apri Steam", not "apristim"; "apri Spotify", not "aprispot"; "apri Discord", not "apridiscord"). The recording may begin with a short notification chime or activation tone — ignore it completely and transcribe only human speech that follows. If the audio contains only silence, background noise, breathing, chimes, or music with no clear human speech, output exactly an empty string. Do NOT guess, invent, or output placeholder text.' },
          { inline_data: { mime_type: safeMime, data: audioB64 } },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, candidateCount: 1 },
      });
      const tText = await new Promise((resolve, reject) => {
        const geminiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tPayload), 'User-Agent': 'XenonEdgeWidget/2.0' },
        }, (gRes) => {
          let d = '';
          gRes.on('data', c => { d += c; });
          gRes.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              resolve(parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '');
            } catch { reject(new Error('invalid JSON')); }
          });
        });
        geminiReq.on('error', reject);
        geminiReq.setTimeout(15000, () => { geminiReq.destroy(); reject(new Error('timeout')); });
        geminiReq.write(tPayload);
        geminiReq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: tText }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/tts' && req.method === 'POST') {
    try {
      const ttsRaw = await readBodyBuffer(req, 64 * 1024);
      const ttsBody = JSON.parse(ttsRaw.toString('utf8') || '{}');
      const apiKey = String(ttsBody.key || '').trim().slice(0, 200);
      const rawText = String(ttsBody.text || '').trim().slice(0, 1000);
      // Default to a male Gemini voice; the client may override via `voice`.
      const voice = String(ttsBody.voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
      if (!apiKey || !rawText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const ttsPayload = JSON.stringify({
        contents: [{ parts: [{ text: rawText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      process.stdout.write(`[TTS] request voice=${voice} chars=${rawText.length}\n`);
      const _ttsStart = Date.now();
      const inlineData = await new Promise((resolve, reject) => {
        const ttsReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ttsPayload), 'User-Agent': 'XenonEdgeWidget/2.0' },
        }, (ttsRes) => {
          let d = '';
          ttsRes.on('data', c => { d += c; });
          ttsRes.on('end', () => {
            process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - _ttsStart}ms\n`);
            try {
              const parsed = JSON.parse(d);
              if (parsed.error) {
                process.stdout.write(`[TTS] Gemini error: ${parsed.error.message || JSON.stringify(parsed.error).slice(0, 160)}\n`);
                return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              }
              const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
              if (!part || !part.data) return reject(new Error('no audio data in TTS response'));
              resolve(part);
            } catch (e) { reject(e); }
          });
        });
        ttsReq.on('error', reject);
        ttsReq.setTimeout(60000, () => { ttsReq.destroy(); reject(new Error('TTS timeout')); });
        ttsReq.write(ttsPayload);
        ttsReq.end();
      });
      const pcmBytes = Buffer.from(inlineData.data, 'base64');
      const rateMatch = String(inlineData.mimeType || '').match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
      const wavBuf = pcmToWav(pcmBytes, sampleRate);
      process.stdout.write(`[TTS] OK wav=${wavBuf.length} bytes rate=${sampleRate}\n`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wavBuf.length), 'Cache-Control': 'no-store' });
      res.end(wavBuf);
    } catch (e) {
      process.stdout.write(`[TTS] FAIL ${e.message}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/speak' && req.method === 'POST') {
    // Server-side voice output (Windows SAPI) — instant and focus-independent.
    // Resolves when speech finishes so the client knows when to re-open listening.
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const text = String(b.text || '').slice(0, 2000);
      const langp = String(b.lang || 'en').slice(0, 5);
      const key = String(b.key || '').trim().slice(0, 200);
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_text' })); return; }
      await speakOnServer(text, langp, key);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/speak/stop' && req.method === 'POST') {
    try { await readBody(req); } catch {}
    stopServerSpeak();
    res.writeHead(204); res.end();

  } else if (reqPath === '/api/chime' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      playChimeOnServer(b.kind === 'close' ? 'close' : 'wake');
    } catch {}
    res.writeHead(204); res.end();

  } else if (reqPath === '/api/volume/duck' && req.method === 'POST') {
    // Lower system volume before TTS speaks so Xenon's voice is foregrounded.
    try {
      await readBody(req);
      if (!_duckActive && cachedSpeakerId) {
        _duckSavedVolume = _lastSpeakerVolume;
        _duckActive = true;
        execFile(SVV, ['/SetVolume', cachedSpeakerId, '20'], () => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/api/volume/restore' && req.method === 'POST') {
    try {
      await readBody(req);
      if (_duckActive && cachedSpeakerId) {
        const vol = _duckSavedVolume != null ? _duckSavedVolume : 70;
        _duckActive = false;
        _duckSavedVolume = null;
        execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], () => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/background' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, BACKGROUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body);
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = BACKGROUND_MIME_BY_EXT.has(extFromName) ? extFromName : BACKGROUND_EXT_BY_MIME.get(file.contentType);
      if (!ext || !BACKGROUND_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = BACKGROUND_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `background-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(UPLOADS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);

      let response = { ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length, conversion: 'not-needed' };
      if (expectedType === 'video/mp4') {
        const webmName = safeName.replace(/\.mp4$/i, '.webm');
        const webmPath = path.join(UPLOADS_DIR, webmName);
        try {
          const webmStat = await transcodeMp4BackgroundToWebm(safePath, webmPath);
          await fs.promises.unlink(safePath).catch(() => {});
          response = {
            ok: true,
            url: `/uploads/${webmName}`,
            name: `${path.basename(file.originalName, path.extname(file.originalName))}.webm`,
            type: 'video/webm',
            size: webmStat.size,
            originalName: file.originalName,
            originalType: expectedType,
            converted: true,
            conversion: 'webm-vp8',
          };
          cleanupOldBackgrounds(webmName);
        } catch (conversionError) {
          await fs.promises.unlink(webmPath).catch(() => {});
          response = {
            ...response,
            conversion: isFfmpegMissing(conversionError) ? 'ffmpeg-missing' : 'failed',
          };
          console.warn(`Background MP4 conversion skipped: ${conversionError.message}`);
          cleanupOldBackgrounds(safeName);
        }
      } else {
        cleanupOldBackgrounds(safeName);
      }

      json(response);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (req.method === 'GET' && reqPath.startsWith('/uploads/')) {
    try {
      const name = decodeURIComponent(reqPath.slice('/uploads/'.length));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(403); res.end('Forbidden'); return; }
      const abs = path.join(UPLOADS_DIR, name);
      const ext = path.extname(name).toLowerCase();
      const mime = BACKGROUND_MIME_BY_EXT.get(ext);
      if (!mime) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      const range = req.headers.range;

      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        const suffixLength = match[1] === '' ? Number(match[2]) : null;
        const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
        const end = match[2] === '' || suffixLength !== null ? stat.size - 1 : Number(match[2]);

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }

  } else if (req.method === 'GET' && /^\/(styles|components|js)(\/|$)/.test(reqPath)) {
    // Static asset handler for refactored CSS/JS files.
    // Normalise to an absolute path and reject any traversal outside __dirname.
    const rel = reqPath.replace(/^\//, '');
    const abs = path.normalize(path.join(__dirname, rel));
    if (!abs.startsWith(path.join(__dirname, path.sep)) && abs !== __dirname) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === '.css' ? 'text/css; charset=utf-8'
               : ext === '.js'  ? 'text/javascript; charset=utf-8'
               : 'application/octet-stream';
    fs.promises.readFile(abs)
      .then(data => { res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(data); })
      .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });

  } else if (reqPath === '/sse' && req.method === 'GET') {
    // Server-Sent Events stream — replaces client-side polling for status, media,
    // system and audio data. Keepalive pings prevent proxy connection timeouts.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));

    // Push current state immediately so the client doesn't wait for the first tick.
    Promise.all([
      getSystemInfo().catch(() => null),
      getMediaInfo().catch(() => null),
      getAudioInfo().catch(() => null),
    ]).then(([sys, media, audio]) => {
      const now = `event: status\ndata: ${JSON.stringify({ muted: isMuted })}\n\n`;
      if (sys)   res.write(`event: system\ndata: ${JSON.stringify(sys)}\n\n`);
      if (media) res.write(`event: media\ndata: ${JSON.stringify(media)}\n\n`);
      if (audio) res.write(`event: audio\ndata: ${JSON.stringify(audio)}\n\n`);
      res.write(now);
    }).catch(() => {});

  } else {
    res.writeHead(404); res.end();
  }
});

function _startListen(host) {
  server.listen(3030, host, () => {
    console.log('Widget server running on http://' + host + ':3030');
    getAudioInfo().then(info => {
      if (info && info.mic && typeof info.mic.muted === 'boolean') isMuted = info.mic.muted;
      console.log('Speaker cache:', cachedSpeakerId);
      console.log('Mic cache:   ', cachedMicId);
      console.log('Mic muted:   ', isMuted);
    }).catch(e => console.error('Audio init failed:', e.message));
    _initSttDevice(); // Enumerate DirectShow audio devices in background
    _initTimers().catch(() => {}); // Load persisted timers + start 1-second check loop
    readHubSettings().then(s => {
      if (s && s.geminiApiKey) startServerWakeWord(s.geminiApiKey);
    }).catch(() => {});
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Porta 3030 già in uso. Chiudi l\'altro processo node prima di riavviare.');
    process.exit(1);
  } else if ((err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') && server.listening === false) {
    // IPv6 not available on this system — fall back to IPv4 loopback
    console.warn('IPv6 non disponibile, fallback a 127.0.0.1');
    _startListen('127.0.0.1');
  } else {
    throw err;
  }
});

// Try IPv6 dual-stack first (accepts both 127.0.0.1 and ::1).
// Falls back to IPv4 via the error handler if IPv6 is unavailable.
_startListen('::');

// ── SSE broadcast timers ──────────────────────────────────────────────────────
// These replace client-side setInterval polling.  Timers only run work when at
// least one SSE client is connected, so they have no cost at idle.

setInterval(() => {
  if (sseClients.size === 0) return;
  broadcastSSE('status', { muted: isMuted });
}, 3000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcastSSE('media', await getMediaInfo()); } catch {}
}, 2000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcastSSE('system', await getSystemInfo()); } catch {}
}, 7000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcastSSE('audio', await getAudioInfo()); } catch {}
}, 5000).unref();

// Keepalive ping every 20 s to prevent proxy/load-balancer timeouts.
setInterval(() => {
  if (sseClients.size === 0) return;
  const ping = ':ping\n\n';
  for (const res of sseClients) {
    try { res.write(ping); } catch { sseClients.delete(res); }
  }
}, 20000).unref();
