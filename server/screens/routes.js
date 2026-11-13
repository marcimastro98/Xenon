// What the engine answers about the screens of the PC.

const { execFile } = require('node:child_process');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /api/screens': async (_req, _res, { json }) => {
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
  },
};

module.exports = { branches };
