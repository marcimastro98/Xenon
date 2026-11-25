// Lists the screens connected to this PC with their position and size.

const { execFile } = require('node:child_process');

// Bounds in real pixels, the space ffmpeg's gdigrab captures in. A plain (DPI-unaware) PowerShell
// reads a scaled monitor smaller than it is (a 4K screen at 150% as 2560x1440), and a capture of
// those bounds kept only its top-left two thirds. So the thread turns per-monitor DPI aware first
// (-4 = PER_MONITOR_AWARE_V2); on a Windows without that call the listing still runs, as before.
const SCREENS_PS = [
  'try {',
  "Add-Type -Namespace XenonDpi -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr c);';",
  '[void][XenonDpi.Native]::SetThreadDpiAwarenessContext([System.IntPtr]::new(-4))',
  '} catch {}',
  'Add-Type -AssemblyName System.Windows.Forms;',
  '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }',
].join(' ');

// ── Screen enumeration (shared by /api/screens, /api/screenshot/monitor, the AI capture_screen
//    function and the game companion) ───────────────────────────────────────────────────────────
async function listScreens() {
  try {
    const stdout = await new Promise((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCREENS_PS],
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

module.exports = { listScreens, SCREENS_PS };
