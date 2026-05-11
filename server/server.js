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

const SVV = path.join(__dirname, 'soundvolumeview-x64', 'SoundVolumeView.exe');
const MEDIA_SCRIPT = path.join(__dirname, 'media.ps1');
const GPU_SCRIPT = path.join(__dirname, 'gpu.ps1');
const NETWORK_SCRIPT = path.join(__dirname, 'network.ps1');
const WINDOWS_SCRIPT = path.join(__dirname, 'windows.ps1');
const NOTES_FILE = path.join(__dirname, 'notes.txt');
const EVENTS_FILE = path.join(__dirname, 'events.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKGROUND_MAX_BYTES = 32 * 1024 * 1024;
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

function runPowerShellScript(script, args = [], timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill();
      fn(value);
    };

    const resolveIfJsonReady = () => {
      if (!stdout.trimEnd().endsWith('}')) return;
      try { settle(resolve, parseJsonOutput(stdout)); }
      catch { }
    };

    const timer = setTimeout(() => {
      try { settle(resolve, parseJsonOutput(stdout)); }
      catch { settle(reject, new Error(stderr || `PowerShell timeout: ${path.basename(script)}`)); }
    }, timeout);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); resolveIfJsonReady(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', e => settle(reject, e));
    child.on('close', code => {
      if (settled) return;
      try { settle(resolve, parseJsonOutput(stdout)); }
      catch (e) { settle(reject, new Error(stderr || e.message || `PowerShell exited with ${code}`)); }
    });
  });
}

function runPowerShellCommand(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      timeout,
      windowsHide: true,
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
let weatherCache = { data: null, updatedAt: 0, lang: '' };
let gpuPending = null;
let cpuTempPending = null;
let mediaPending = null;
let weatherPending = null;
const MEDIA_CACHE_MS = 1200;
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const artworkCache = new Map();

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
    artworkCache.set(key, bigArt);
    data.thumbnail = bigArt;
  } catch {
    artworkCache.set(key, null);
  }

  return data;
}

function firstWeatherValue(value) {
  if (Array.isArray(value) && value[0] && typeof value[0].value === 'string') return value[0].value;
  return '';
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

  return {
    ok: Number.isFinite(tempC),
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
    hourly,
    forecast: days.slice(0, 3).map(day => normalizeWeatherDay(day, lang)),
    updatedAt: Date.now(),
  };
}

async function getWeather(lang = 'it') {
  const safeLang = lang === 'en' ? 'en' : 'it';
  const age = Date.now() - weatherCache.updatedAt;
  if (weatherCache.data && weatherCache.lang === safeLang && age < WEATHER_CACHE_MS) return weatherCache.data;
  if (weatherPending) return weatherPending;

  weatherPending = fetchJson(`https://wttr.in/?format=j1&lang=${safeLang}`, 3500)
    .then(raw => {
      const data = normalizeWeather(raw, safeLang);
      weatherCache = { data, updatedAt: Date.now(), lang: safeLang };
      return data;
    })
    .catch(e => {
      if (weatherCache.data) return { ...weatherCache.data, stale: true };
      throw e;
    })
    .finally(() => { weatherPending = null; });

  return weatherPending;
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

  const command = `
    $ErrorActionPreference = 'Stop'
    $temps = @()

    try {
      $temps += @(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop |
        Where-Object {
          $_.SensorType -eq 'Temperature' -and
          ($_.Name -match 'CPU Package|CPU CCD|CPU Tctl|CPU Tdie|Core Average|Package')
        } |
        Select-Object -ExpandProperty Value)
    } catch { }

    try {
      $temps += @(Get-WmiObject -Namespace root/OpenHardwareMonitor -Class Sensor -ErrorAction Stop |
        Where-Object {
          $_.SensorType -eq 'Temperature' -and
          ($_.Name -match 'CPU Package|CPU CCD|CPU Tctl|CPU Tdie|Core Average|Package')
        } |
        Select-Object -ExpandProperty Value)
    } catch { }

    # Fallback: native Windows thermal zones (no extra software required).
    # CurrentTemperature is in tenths of Kelvin; convert to Celsius.
    if ($temps.Count -eq 0) {
      try {
        $tzRaw = @(Get-WmiObject -Namespace root/wmi -Class MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
          Select-Object -ExpandProperty CurrentTemperature)
        $temps += @($tzRaw | ForEach-Object { ($_ - 2732) / 10 })
      } catch { }
    }

    $cpuTemp = $temps |
      Where-Object { $_ -gt 5 -and $_ -lt 120 } |
      Sort-Object -Descending |
      Select-Object -First 1

    [pscustomobject]@{ cpuTemp = if ($null -ne $cpuTemp) { [double]$cpuTemp } else { $null } } |
      ConvertTo-Json -Compress
  `;

  cpuTempPending = (async () => {
    try {
      const data = await runPowerShellCommand(command, 6000);
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
    const data = await runPowerShellScript(MEDIA_SCRIPT, ['info'], 12000);
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
  const data = await runPowerShellScript(MEDIA_SCRIPT, [action], 5000);
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

          if (defSpk) { cachedSpeakerId = defSpk[F.CLI_ID]; cachedSpeakerName = defSpk[F.NAME]; }
          if (defMic) cachedMicId     = defMic[F.CLI_ID];

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
    try { json(await getWeather(urlObj.searchParams.get('lang') || 'it')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media' && req.method === 'GET') {
    try   { json(await getMediaInfo()); }
    catch (e) { err500(e.message); }

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

  } else if (reqPath === '/lock' && req.method === 'POST') {
    exec('rundll32.exe user32.dll,LockWorkStation', e => {
      if (e) err500(e.message); else json({ ok: true });
    });

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
      await fs.promises.writeFile(path.join(UPLOADS_DIR, safeName), file.data);
      cleanupOldBackgrounds(safeName);
      json({ ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length });
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
      const data = await fs.promises.readFile(abs);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(data);
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
      .then(data => { res.writeHead(200, { 'Content-Type': mime }); res.end(data); })
      .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });

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
