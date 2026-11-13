// Screen mirror: the loop that captures one monitor and sends its frames.

using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace XenonHelper;

internal static partial class ScreenHost
{
    // ── Capture loop ────────────────────────────────────────────────────────────

    private sealed class CaptureLoop
    {
        private readonly MonitorInfo _mon;
        private readonly int _fps;
        private readonly int _maxW, _maxH, _quality;
        private readonly CancellationTokenSource _cts = new();
        private Thread? _thread;
        private long _seq;
        private ulong _lastHash;
        private long _lastEmitTicks;

        private static readonly ImageCodecInfo JpegCodec =
            ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);

        public CaptureLoop(MonitorInfo mon, int fps, int maxW, int maxH, int quality)
        {
            _mon = mon; _fps = fps; _maxW = maxW; _maxH = maxH; _quality = quality;
        }

        // The captured monitor's geometry — used to map tile-relative input
        // coordinates back onto the virtual desktop for SendInput.
        public MonitorInfo Target => _mon;

        public void Start()
        {
            _thread = new Thread(Loop) { IsBackground = true, Name = "screen-capture" };
            _thread.Start();
        }

        public void Stop()
        {
            try { _cts.Cancel(); } catch { }
            try { _thread?.Join(1000); } catch { }
            _cts.Dispose();
        }

        private void Loop()
        {
            var frameMs = Math.Max(1, 1000 / _fps);
            const int keepaliveMs = 1000; // re-send a static frame at most ~1/s
            using var encParams = new EncoderParameters(1);
            encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)_quality);

            while (!_cts.IsCancellationRequested)
            {
                var started = Environment.TickCount64;
                try
                {
                    using var shot = Capture();
                    // Hash the captured pixels BEFORE scaling/encoding so a static
                    // screen costs almost nothing (the encode is the expensive part).
                    var hash = FastHash(shot);
                    var now = Environment.TickCount64;
                    var changed = hash != _lastHash;
                    if (changed || now - _lastEmitTicks >= keepaliveMs)
                    {
                        using var outBmp = Scale(shot, _maxW, _maxH);
                        EmitFrame(outBmp, encParams);
                        _lastHash = hash;
                        _lastEmitTicks = now;
                    }
                }
                catch { /* transient capture failure: skip this frame */ }

                var elapsed = (int)(Environment.TickCount64 - started);
                var wait = frameMs - elapsed;
                if (wait > 0 && _cts.Token.WaitHandle.WaitOne(wait)) break;
            }
        }

        private Bitmap Capture()
        {
            var bmp = new Bitmap(_mon.Width, _mon.Height, PixelFormat.Format32bppArgb);
            try
            {
                using var g = Graphics.FromImage(bmp);
                g.CopyFromScreen(_mon.X, _mon.Y, 0, 0, new Size(_mon.Width, _mon.Height), CopyPixelOperation.SourceCopy);
                DrawCursor(g);
            }
            catch { bmp.Dispose(); throw; }
            return bmp;
        }

        // BitBlt never captures the mouse pointer, and a virtual display draws its
        // cursor as a hardware overlay (outside the framebuffer), so the captured
        // frame has no cursor at all — the user can't see where they're pointing.
        // Composite it ourselves: read the live cursor, offset it into this monitor's
        // space (the same process-DPI space CopyFromScreen and SendInput use, so it
        // lands exactly where input goes) and draw it onto the frame.
        private void DrawCursor(Graphics g)
        {
            var ci = new CURSORINFO { cbSize = Marshal.SizeOf<CURSORINFO>() };
            // Draw whenever a cursor exists — CURSOR_SHOWING (0x1) OR CURSOR_SUPPRESSED
            // (0x2). On a touchscreen Windows *suppresses* the cursor visual after touch
            // input, but the logical pointer still moves and clicks land; the remote view
            // must show it anyway so the user can see where they're pointing. Skip only
            // when genuinely hidden (flags 0) or there's no cursor handle.
            if (!GetCursorInfo(ref ci) || ci.hCursor == IntPtr.Zero || ci.flags == 0) return;
            // Skip all the per-frame GDI icon work when the pointer isn't over this
            // monitor (the common case while the user isn't pointing here): no bitmap
            // churn, and a static screen keeps hashing identical so it isn't re-encoded.
            if (ci.ptScreenPos.x < _mon.X || ci.ptScreenPos.x >= _mon.X + _mon.Width ||
                ci.ptScreenPos.y < _mon.Y || ci.ptScreenPos.y >= _mon.Y + _mon.Height) return;
            if (!GetIconInfo(ci.hCursor, out var ii)) return;
            try
            {
                var x = ci.ptScreenPos.x - _mon.X - ii.xHotspot;
                var y = ci.ptScreenPos.y - _mon.Y - ii.yHotspot;
                var hdc = g.GetHdc();
                try { DrawIconEx(hdc, x, y, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL); }
                finally { g.ReleaseHdc(hdc); }
            }
            finally
            {
                if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
            }
        }

        private static Bitmap Scale(Bitmap src, int maxW, int maxH)
        {
            if (src.Width <= maxW && src.Height <= maxH) return (Bitmap)src.Clone();
            var ratio = Math.Min((double)maxW / src.Width, (double)maxH / src.Height);
            var w = Math.Max(1, (int)Math.Round(src.Width * ratio));
            var h = Math.Max(1, (int)Math.Round(src.Height * ratio));
            var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            try
            {
                using var g = Graphics.FromImage(dst);
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                g.DrawImage(src, 0, 0, w, h);
            }
            catch { dst.Dispose(); throw; }
            return dst;
        }

        private void EmitFrame(Bitmap bmp, EncoderParameters encParams)
        {
            using var ms = new MemoryStream();
            bmp.Save(ms, JpegCodec, encParams);
            var b64 = Convert.ToBase64String(ms.GetBuffer(), 0, (int)ms.Length);
            var seq = ++_seq;
            WriteFrame(bmp.Width, bmp.Height, seq, b64);
        }

        // FNV-1a over a strided sample of the 32bpp pixel buffer — cheap change
        // detection that avoids re-encoding a static screen every tick.
        private static ulong FastHash(Bitmap bmp)
        {
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                ulong hash = 14695981039346656037UL;
                var total = data.Stride * data.Height;
                const int step = 257 * 4; // prime-ish stride, stays 4-byte aligned
                unsafe
                {
                    var p = (byte*)data.Scan0;
                    for (var i = 0; i < total; i += step)
                    {
                        hash ^= p[i];
                        hash *= 1099511628211UL;
                    }
                }
                // Mix in dimensions so a resize never collides with a static frame.
                hash ^= (ulong)((bmp.Width << 16) ^ bmp.Height);
                return hash;
            }
            finally { bmp.UnlockBits(data); }
        }
    }

    private static int Clamp(int v, int lo, int hi) => v < lo ? lo : v > hi ? hi : v;
}
