// Lists the screens connected to this PC with their position and size.

const { execFile } = require('node:child_process');

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

module.exports = { listScreens };
