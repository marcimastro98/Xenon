# ─────────────────────────────────────────────────────────────────────────
# Deck Hotkey runner — send a keyboard shortcut to the app the user was using.
#
# The problem: tapping the Xeneon touchscreen gives foreground to the dashboard
# window, so a naive SendInput lands on the widget, not the target app. The fix:
# at action time we walk the window Z-ORDER from the current foreground (the
# dashboard) and pick the first eligible window BELOW it — the app the user was
# last looking at (works for native apps AND browser tabs). We then FORCE that
# window to the foreground (the AttachThreadInput dance + an ALT-tap to lift the
# SetForegroundWindow lock, with a retry), let it settle, and send the combo via
# SendInput (more reliable than keybd_event, e.g. Ctrl+C/Ctrl+V are honoured).
#
# Input is pre-validated by the server (registry.normalizeKeys): only known
# modifiers/keys joined by '+'. Prints a single JSON line.
# ─────────────────────────────────────────────────────────────────────────
param(
  [Parameter(Mandatory = $true)][string]$Keys,
  [switch]$DryRun   # report the detected target window only — no focus steal, no keystroke
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$source = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class XenonHotkey {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool SpiGet(uint action, uint uiParam, ref uint pvParam, uint fWinIni);
  [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")] public static extern bool SpiSet(uint action, uint uiParam, IntPtr pvParam, uint fWinIni);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  // NOTE: the union MUST carry MOUSEINPUT too. Without it the struct is smaller than
  // the OS INPUT (40 bytes on x64), cbSize mismatches, and SendInput silently sends
  // nothing — which is exactly why keystrokes never landed.
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  const uint GW_HWNDNEXT = 2;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const int DWMWA_CLOAKED = 14;
  const int SW_RESTORE = 9;
  const int SW_SHOW = 5;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint KEYEVENTF_SCANCODE = 0x0008;
  const uint MAPVK_VK_TO_VSC = 0;
  const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
  const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
  const uint SPIF_SENDCHANGE = 0x0002;

  // First real, on-screen, top-level window beneath the foreground (the dashboard
  // the user just tapped). Skips invisible, minimised, cloaked, tool, title-less.
  public static IntPtr FindTarget() {
    IntPtr fg = GetForegroundWindow();
    IntPtr h = fg;
    for (int i = 0; i < 80 && h != IntPtr.Zero; i++) {
      h = GetWindow(h, GW_HWNDNEXT);
      if (h == IntPtr.Zero || h == fg) continue;
      if (!IsWindowVisible(h) || IsIconic(h)) continue;
      if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) continue;
      if (GetWindowTextLength(h) == 0) continue;
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, sizeof(int)); } catch { }
      if (cloaked != 0) continue;
      return h;
    }
    return IntPtr.Zero;
  }

  public static string Title(IntPtr h) {
    System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }

  // Every modifier virtual-key (generic + left/right). We force these UP defensively
  // so a half-completed combo or focus change can never leave a modifier stuck down —
  // a stuck Ctrl/Alt turns every later keypress into a shortcut and looks like a crash.
  static readonly byte[] MOD_VKS = new byte[] { 0x11, 0x12, 0x10, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
  public static void ClearMods() {
    List<INPUT> seq = new List<INPUT>();
    for (int i = 0; i < MOD_VKS.Length; i++) seq.Add(Vk(MOD_VKS[i], true));
    INPUT[] arr = seq.ToArray();
    SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }

  // Virtual-keys whose scan code MUST carry the extended (E0) flag, or the OS reads
  // a different key. Crucially this includes Win (0x5B/0x5C): sent without the flag,
  // scancode 0x5B is NOT seen as Win, so every "win+…" combo did nothing. The list
  // also covers nav/edit keys and right-hand modifiers. Applies to modifiers AND the
  // main key — the extended-ness is a property of the key, not of its role.
  static readonly byte[] EXT_VKS = new byte[] { 0x2E, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x2D, 0x5B, 0x5C, 0xA3, 0xA5 };
  static bool IsExt(byte vk) { for (int i = 0; i < EXT_VKS.Length; i++) if (EXT_VKS[i] == vk) return true; return false; }

  // Send by SCAN CODE (wVk = 0). Modern WinUI apps (e.g. the Win11 Notepad) only
  // honour scan-code input when detecting modifiers, so a VK-only Ctrl+A was read as
  // a plain 'a'. Scan codes are the most widely-honoured form across app types. The
  // extended flag is derived from the key itself (see EXT_VKS).
  static INPUT Vk(byte vk, bool up) {
    ushort sc = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);
    uint f = KEYEVENTF_SCANCODE;
    if (IsExt(vk)) f |= KEYEVENTF_EXTENDEDKEY;
    if (up) f |= KEYEVENTF_KEYUP;
    INPUT i = new INPUT(); i.type = INPUT_KEYBOARD;
    i.U.ki.wVk = 0; i.U.ki.wScan = sc; i.U.ki.dwFlags = f; i.U.ki.time = 0; i.U.ki.dwExtraInfo = IntPtr.Zero;
    return i;
  }

  // Claim the foreground WITHOUT any keyboard trick. We neither AttachThreadInput
  // (which can freeze the target's input queue → "crash") nor inject an ALT tap
  // (which leaves the target stuck in menu mode / ALT held). Instead we momentarily
  // zero the system foreground-lock timeout so SetForegroundWindow is honoured, then
  // restore the original value — the standard, side-effect-free technique.
  static bool TryForeground(IntPtr target) {
    // fWinIni = 0 (NOT SPIF_SENDCHANGE): change the timeout for our SetForegroundWindow
    // without broadcasting WM_SETTINGCHANGE to every window — that broadcast can upset
    // packaged apps (e.g. Win11 Notepad closing/reopening).
    uint orig = 0;
    SpiGet(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ref orig, 0);
    SpiSet(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, 0);
    BringWindowToTop(target);
    SetForegroundWindow(target);
    SpiSet(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, (IntPtr)orig, 0);
    return GetForegroundWindow() == target;
  }

  public static bool Focus(IntPtr target) {
    if (!IsWindow(target)) return false;
    if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
    for (int i = 0; i < 3; i++) {
      if (TryForeground(target)) return true;
      Thread.Sleep(40);
    }
    return GetForegroundWindow() == target;
  }

  static void Send1(INPUT i) {
    INPUT[] a = new INPUT[] { i };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  // Press the modifiers, let their key-state settle, THEN tap the key, then release.
  // Sending it all in one zero-gap batch makes apps translate the key to a plain
  // character before the modifier registers — so Ctrl+A typed a literal "a".
  public static void SendCombo(byte[] mods, byte main) {
    for (int i = 0; i < mods.Length; i++) Send1(Vk(mods[i], false));
    if (mods.Length > 0) Thread.Sleep(20);
    Send1(Vk(main, false));
    Thread.Sleep(15);
    Send1(Vk(main, true));
    if (mods.Length > 0) Thread.Sleep(10);
    for (int i = mods.Length - 1; i >= 0; i--) Send1(Vk(mods[i], true));
  }
}
"@
Add-Type -TypeDefinition $source

function Emit($json) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); exit 0 }
function Fail($msg) { Emit ('{"ok":false,"error":"' + $msg + '"}') }

# Virtual-key map: modifiers + the keys the server's allowlist permits.
$VK = @{
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B;
  'enter' = 0x0D; 'return' = 0x0D; 'esc' = 0x1B; 'escape' = 0x1B; 'tab' = 0x09; 'space' = 0x20;
  'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'home' = 0x24; 'end' = 0x23;
  'pageup' = 0x21; 'pagedown' = 0x22; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27; 'insert' = 0x2D;
}
for ($i = 1; $i -le 24; $i++) { $VK["f$i"] = 0x70 + ($i - 1) }     # F1..F24
foreach ($d in 0..9) { $VK["$d"] = 0x30 + $d }                     # 0..9
foreach ($i in 97..122) { $VK[[string][char]$i] = $i - 32 }        # a..z -> uppercase ASCII VK

# NB: PowerShell variable names are case-insensitive, so this MUST NOT be named
# $MODS — that would be the same variable as the $mods output list built below,
# silently emptying the modifier set so Ctrl/Alt/Shift were never recognised.
$MOD_NAMES = @('ctrl', 'control', 'alt', 'shift', 'win')

$parts = $Keys.ToLower().Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
if ($parts.Count -eq 0) { Fail 'bad_keys' }

$mods = New-Object System.Collections.Generic.List[byte]
$main = $null
foreach ($p in $parts) {
  if (-not $VK.ContainsKey($p)) { Fail 'bad_keys' }
  if ($MOD_NAMES -contains $p) { $mods.Add([byte]$VK[$p]) }
  else { $main = [byte]$VK[$p] }
}
if ($null -eq $main) { Fail 'no_key' }

# Diagnostic mode: report what we WOULD target, touching nothing. Lets us confirm
# window detection on the device without risking focus changes or stray keystrokes.
if ($DryRun) {
  $fg = [XenonHotkey]::GetForegroundWindow()
  $tgt = [XenonHotkey]::FindTarget()
  Emit (@{
      ok         = $true
      dryRun     = $true
      foreground = [XenonHotkey]::Title($fg)
      target     = if ($tgt -eq [IntPtr]::Zero) { $null } else { [XenonHotkey]::Title($tgt) }
    } | ConvertTo-Json -Compress)
}

# Clear any modifier that an earlier run (or focus change) may have left stuck down,
# BEFORE we touch focus — otherwise the very first combo inherits the bad state.
[XenonHotkey]::ClearMods()

$target = [XenonHotkey]::FindTarget()
if ($target -eq [IntPtr]::Zero) { Fail 'no_target' }
$title = [XenonHotkey]::Title($target)
if (-not [XenonHotkey]::Focus($target)) {
  Emit (@{ ok = $false; error = 'focus_failed'; target = $title } | ConvertTo-Json -Compress)
}
Start-Sleep -Milliseconds 160      # let the target settle as the active window before
                                   # we inject — enough after stealing focus from the
                                   # dashboard, without making the key feel sluggish.

try {
  [XenonHotkey]::SendCombo($mods.ToArray(), $main)
}
finally {
  # Always release modifiers — a key-up that landed on the wrong window mid-combo
  # must never leave Ctrl/Alt/Shift logically held.
  [XenonHotkey]::ClearMods()
}

Emit (@{ ok = $true; target = $title } | ConvertTo-Json -Compress)
