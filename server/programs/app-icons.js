// Icons of the programs on this PC, looked up once and kept: for running apps and for Store
// apps.

const { runPowerShellCommand } = require('../powershell/run-command.js');
const { psQuote } = require('../ps-quote.js');

// Persistent icon cache keyed by process exe path — avoids repeated PowerShell spawns.
// Bounded LRU (oldest evicted past the cap) so a long-running session that sees
// many distinct executables can't grow it without limit — mirrors artworkCache.
const appIconCache = new Map();
const APP_ICON_CACHE_MAX = 200;
function setAppIcon(key, value) {
  if (appIconCache.size >= APP_ICON_CACHE_MAX && !appIconCache.has(key)) {
    appIconCache.delete(appIconCache.keys().next().value);
  }
  appIconCache.set(key, value);
}

async function resolveAppIcons(appPaths) {
  // Extract the associated exe icon for each process path, exactly like windows.ps1
  // does for the app switcher. Keyed by path so each app resolves once and is cached.
  const keys = appPaths.map(p => (p || '').toLowerCase());
  const uncached = [...new Set(keys)].filter(k => k && !appIconCache.has(k));
  if (uncached.length) {
    const psArr = uncached.map(p => psQuote(p)).join(',');
    const psCmd = `
      $paths = @(${psArr})
      $out = @{}
      try { Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue } catch {}
      foreach ($p in $paths) {
        $key = $p
        try {
          if ($p -and (Test-Path -LiteralPath $p)) {
            $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
            if ($ico) {
              $bmp = New-Object System.Drawing.Bitmap(32, 32)
              $g = [System.Drawing.Graphics]::FromImage($bmp)
              $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
              $g.DrawImage($ico.ToBitmap(), 0, 0, 32, 32)
              $g.Dispose()
              $ms = New-Object System.IO.MemoryStream
              $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
              $out[$key] = 'data:image/png;base64,' + [Convert]::ToBase64String($ms.ToArray())
              $bmp.Dispose(); $ms.Dispose(); $ico.Dispose()
            }
          }
        } catch {}
        if (-not $out.ContainsKey($key)) { $out[$key] = $null }
      }
      $out | ConvertTo-Json -Compress
    `;
    try {
      const result = await runPowerShellCommand(psCmd, 10000);
      if (result && typeof result === 'object') {
        for (const [k, v] of Object.entries(result)) {
          setAppIcon(k.toLowerCase(), v || null);
        }
      }
    } catch {}
    for (const k of uncached) {
      if (!appIconCache.has(k)) setAppIcon(k, null);
    }
  }
  return keys.map(k => appIconCache.get(k) || null);
}

// Extract a Store/UWP app's own tile logo from its installed package manifest, so
// a Deck "open Store app" key can use the app's real icon with no external image.
// Store apps have no classic exe for ExtractAssociatedIcon — they launch by AUMID
// (PackageFamilyName!AppId) — so we read the Square logo asset declared in
// AppxManifest.xml straight off disk (best-scaled variant), yielding a clean PNG
// with proper transparency. Cached in appIconCache under a 'store:' namespace so
// it can't collide with exe-path keys. Returns a PNG data URL or null.
async function resolveStoreAppIcon(aumid) {
  const id = String(aumid || '').trim();
  // Defence in depth: the endpoint already charset-checks the AUMID, but re-assert
  // here so the two halves can never carry anything but [\w.-] into PowerShell.
  if (!/^[\w.-]+![\w.-]+$/.test(id)) return null;
  const cacheKey = 'store:' + id.toLowerCase();
  if (appIconCache.has(cacheKey)) return appIconCache.get(cacheKey);
  const [pfn, appId] = id.split('!');
  const psCmd = `
    $pfn = '${pfn}'
    $appId = '${appId}'
    $out = @{ icon = $null }
    try {
      $name = ($pfn -split '_')[0]
      $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $pfn } | Select-Object -First 1
      if (-not $pkg) { $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $pfn } | Select-Object -First 1 }
      if ($pkg -and $pkg.InstallLocation) {
        $loc = $pkg.InstallLocation
        $manifest = Join-Path $loc 'AppxManifest.xml'
        if (Test-Path -LiteralPath $manifest) {
          [xml]$m = Get-Content -LiteralPath $manifest
          $logo = $null
          foreach ($app in $m.SelectNodes("//*[local-name()='Application']")) {
            if ($app.GetAttribute('Id') -eq $appId) {
              $ve = $app.SelectSingleNode(".//*[local-name()='VisualElements']")
              if ($ve) { $logo = $ve.GetAttribute('Square44x44Logo'); if (-not $logo) { $logo = $ve.GetAttribute('Square150x150Logo') } }
              break
            }
          }
          if (-not $logo) {
            $ve = $m.SelectSingleNode("//*[local-name()='VisualElements']")
            if ($ve) { $logo = $ve.GetAttribute('Square44x44Logo'); if (-not $logo) { $logo = $ve.GetAttribute('Square150x150Logo') } }
          }
          if ($logo) {
            $baseName = [System.IO.Path]::GetFileNameWithoutExtension($logo.Replace('/', '\\'))
            $ext = [System.IO.Path]::GetExtension($logo)
            if (-not $ext) { $ext = '.png' }
            # The manifest logo path is LOGICAL (resource-resolved); the real scaled
            # assets live elsewhere in the package under the same base filename, so
            # search the package and prefer the standard full-colour variant near a
            # crisp size, falling back to any non-themed then the largest available.
            $all = @(Get-ChildItem -LiteralPath $loc -Recurse -Filter ($baseName + '*' + $ext) -File -ErrorAction SilentlyContinue)
            $file = $null
            foreach ($tag in @('scale-200','targetsize-48','targetsize-64','scale-150','targetsize-96','scale-100','targetsize-32')) {
              $cand = $all | Where-Object { $_.Name -eq ($baseName + '.' + $tag + $ext) } | Select-Object -First 1
              if ($cand) { $file = $cand.FullName; break }
            }
            if (-not $file) {
              $cand = $all | Where-Object { $_.Name -notmatch 'altform' } | Sort-Object Length -Descending | Select-Object -First 1
              if ($cand) { $file = $cand.FullName }
            }
            if (-not $file -and $all.Count) { $file = ($all | Sort-Object Length -Descending | Select-Object -First 1).FullName }
            if ($file) {
              $bytes = [System.IO.File]::ReadAllBytes($file)
              $out.icon = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes)
            }
          }
        }
      }
    } catch {}
    $out | ConvertTo-Json -Compress
  `;
  let icon = null;
  try {
    const out = await runPowerShellCommand(psCmd, 10000);
    if (out && typeof out.icon === 'string' && out.icon) icon = out.icon;
  } catch {}
  setAppIcon(cacheKey, icon);
  return icon;
}

module.exports = {
  appIconCache, APP_ICON_CACHE_MAX, setAppIcon, resolveAppIcons, resolveStoreAppIcon,
};
