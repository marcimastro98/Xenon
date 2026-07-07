# ddc.ps1 — DDC/CI display control host for Xenon.
#
# Reads and writes a monitor's *hardware* brightness / contrast / RGB white-point
# gains over DDC/CI (the same channel iCUE uses), so the dashboard can dim the
# Xeneon Edge — or any DDC/CI-capable monitor Xenon is shown on — without iCUE.
#
# Two modes:
#   -List    one-shot: prints one JSON line describing every monitor and which
#            controls it actually exposes, then exits. (Debug / manual use.)
#   -Serve   persistent stdio host (how server.js drives it): enumerates once,
#            keeps the physical-monitor handles open, and answers newline-framed
#            JSON commands on stdin — {"id":N,"action":"list"} re-reads current
#            values, {"id":N,"action":"set","key":..,"feature":..,"value":..}
#            writes one VCP. Replies are "XEDDC <base64-json>" frames, mirroring
#            the media host. Closing stdin ends the loop and releases the handles.
#
# Everything is capability-driven: a control is offered for a monitor ONLY if that
# monitor answers the matching VCP read. A display that speaks no DDC/CI (e.g. a
# virtual display) simply reports every feature unsupported — never an error.
#
# Feature → VCP code (MCCS): brightness 0x10, contrast 0x12, red 0x16,
# green 0x18, blue 0x1A. Values use each monitor's own reported max (an Edge RGB
# gain is 0..255, a typical brightness 0..100) — nothing is hardcoded.
[CmdletBinding(DefaultParameterSetName = 'List')]
param(
    [Parameter(ParameterSetName = 'List')]  [switch]$List,
    [Parameter(ParameterSetName = 'Serve')] [switch]$Serve
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Ddc {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szDescription;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]  public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);

    [DllImport("dxva2.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] arr);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte vcp, out int type, out uint cur, out uint max);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool SetVCPFeature(IntPtr h, byte vcp, uint value);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetCapabilitiesStringLength(IntPtr h, out uint len);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr h, StringBuilder reply, uint len);

    [DllImport("dxva2.dll")]
    public static extern bool DestroyPhysicalMonitors(uint count, [In] PHYSICAL_MONITOR[] arr);
}
"@

# Feature → VCP code. The client sends a feature *name* from this fixed set, never
# a raw VCP code, so no arbitrary VCP write can be requested over the wire.
$FEATURES = [ordered]@{
    brightness = [byte]0x10
    backlight  = [byte]0x6B
    contrast   = [byte]0x12
    red        = [byte]0x16
    green      = [byte]0x18
    blue       = [byte]0x1A
}
$EDD_GET_DEVICE_INTERFACE_NAME = [uint32]1
# MCCS "Restore Factory Defaults" — a write-only VCP; writing 1 tells the monitor to
# undo every brightness/contrast/colour tweak. This is the safety net the reset
# button uses, offered only when the monitor advertises it in its capabilities.
$VCP_RESET = [byte]0x04

# Best-effort friendly names ("XENEON EDGE") from the EDID via WMI, keyed by the
# monitor's hardware-id core so we can attach a human label to each DDC monitor.
# Any failure here just leaves monitors labelled by their generic description.
function Get-FriendlyNameMap {
    $map = @{}
    try {
        Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop | ForEach-Object {
            $name = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
            if (-not $name) { return }
            # InstanceName: "DISPLAY\CRXED00\5&25eeb2d0&0&UID512_0" → core "CRXED00\5&..UID512"
            $core = $_.InstanceName
            if ($core -match '^DISPLAY\\(.+?)_\d+$') { $core = $Matches[1] }
            $map[$core.ToUpperInvariant()] = $name
        }
    } catch {}
    return $map
}

# The hardware-id core for a GDI device ("\\.\DISPLAY6"), matched against the WMI
# map above. Uses the device *interface* name, whose '#'-separated form carries the
# same vendor\instance segments as the WMI InstanceName.
function Get-DeviceCore([string]$gdiName) {
    try {
        $dd = New-Object 'Ddc+DISPLAY_DEVICE'
        $dd.cb = [Runtime.InteropServices.Marshal]::SizeOf($dd)
        if ([Ddc]::EnumDisplayDevices($gdiName, 0, [ref]$dd, $EDD_GET_DEVICE_INTERFACE_NAME)) {
            # DeviceID: "\\?\DISPLAY#CRXED00#5&25eeb2d0&0&UID512#{guid}"
            $parts = $dd.DeviceID -split '#'
            if ($parts.Length -ge 3) { return "$($parts[1])\$($parts[2])".ToUpperInvariant() }
        }
    } catch {}
    return ''
}

# Whether the monitor advertises "Restore Factory Defaults" (VCP 0x04) in its MCCS
# capabilities string. Parses the top-level vcp(...) code list, skipping the nested
# value-groups (e.g. 14(01 05 06)) so their inner numbers aren't mistaken for codes.
function Test-CanReset([IntPtr]$h) {
    try {
        $len = [uint32]0
        if (-not ([Ddc]::GetCapabilitiesStringLength($h, [ref]$len)) -or $len -eq 0) { return $false }
        $sb = New-Object System.Text.StringBuilder ([int]$len)
        if (-not ([Ddc]::CapabilitiesRequestAndCapabilitiesReply($h, $sb, $len))) { return $false }
        $caps = $sb.ToString()
        $i = $caps.IndexOf('vcp(')
        if ($i -lt 0) { return $false }
        $start = $i + 4; $depth = 1; $j = $start
        while ($j -lt $caps.Length -and $depth -gt 0) {
            $c = $caps[$j]
            if ($c -eq '(') { $depth++ }
            elseif ($c -eq ')') { $depth--; if ($depth -eq 0) { break } }
            $j++
        }
        $inner = $caps.Substring($start, $j - $start)
        $top = [regex]::Replace($inner, '\([^()]*\)', ' ')   # drop value-groups
        $codes = $top -split '\s+' | Where-Object { $_ -ne '' }
        return ($codes -contains '04')
    } catch { return $false }
}

# Read every known feature for one open physical-monitor handle. A feature the
# monitor doesn't answer is reported supported=false (no cur/max), which the UI
# reads as "don't offer this slider".
function Read-Features([IntPtr]$h) {
    $feat = [ordered]@{}
    foreach ($name in $FEATURES.Keys) {
        $vcp = $FEATURES[$name]
        $type = 0; $cur = [uint32]0; $max = [uint32]0
        if ([Ddc]::GetVCPFeatureAndVCPFeatureReply($h, $vcp, [ref]$type, [ref]$cur, [ref]$max) -and $max -gt 0) {
            $feat[$name] = [ordered]@{ supported = $true; cur = [int]$cur; max = [int]$max }
        } else {
            $feat[$name] = [ordered]@{ supported = $false }
        }
    }
    return $feat
}

# Enumerate all monitors, opening (and keeping open, for -Serve) their physical
# handles. Returns rich objects the caller both serialises and drives writes from.
function Get-Monitors {
    $friendly = Get-FriendlyNameMap
    $hmonitors = New-Object System.Collections.Generic.List[IntPtr]
    $cb = [Ddc+MonitorEnumProc] {
        param([IntPtr]$h, [IntPtr]$hdc, [ref]$rect, [IntPtr]$data)
        $hmonitors.Add($h); return $true
    }
    [void][Ddc]::EnumDisplayMonitors([IntPtr]::Zero, [IntPtr]::Zero, $cb, [IntPtr]::Zero)

    $out = New-Object System.Collections.Generic.List[object]
    foreach ($hm in $hmonitors) {
        $mi = New-Object 'Ddc+MONITORINFOEX'
        $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
        if (-not [Ddc]::GetMonitorInfo($hm, [ref]$mi)) { continue }
        $gdi = $mi.szDevice
        $primary = (($mi.dwFlags -band 1) -ne 0)

        $count = [uint32]0
        if (-not [Ddc]::GetNumberOfPhysicalMonitorsFromHMONITOR($hm, [ref]$count) -or $count -eq 0) { continue }
        $arr = New-Object 'Ddc+PHYSICAL_MONITOR[]' $count
        if (-not [Ddc]::GetPhysicalMonitorsFromHMONITOR($hm, $count, $arr)) { continue }

        # One HMONITOR can back several physical monitors (mirror sets); index the
        # key so each gets a distinct, stable handle for this session.
        for ($i = 0; $i -lt $arr.Length; $i++) {
            $pm = $arr[$i]
            $key = if ($arr.Length -gt 1) { "$gdi#$i" } else { $gdi }
            $core = Get-DeviceCore $gdi
            $name = if ($core -and $friendly.ContainsKey($core)) { $friendly[$core] } else { $pm.szDescription }
            $out.Add([pscustomobject]@{
                Key      = $key
                Handle   = $pm.hPhysicalMonitor
                Name     = $name
                Primary  = $primary
                Features = Read-Features $pm.hPhysicalMonitor
                CanReset = Test-CanReset $pm.hPhysicalMonitor
            })
        }
    }
    return $out
}

# Project the rich monitor objects to the wire shape (no native handles).
function ConvertTo-Wire($mons) {
    $list = foreach ($m in $mons) {
        [ordered]@{ key = $m.Key; name = $m.Name; primary = $m.Primary; reset = $m.CanReset; features = $m.Features }
    }
    return @{ ok = $true; monitors = @($list) }
}

# ── -List: one-shot describe-and-exit ───────────────────────────────────────────
if ($List) {
    $mons = Get-Monitors
    (ConvertTo-Wire $mons) | ConvertTo-Json -Depth 6 -Compress
    foreach ($m in $mons) {
        try { [Ddc]::DestroyPhysicalMonitors(1, @([Ddc+PHYSICAL_MONITOR]@{ hPhysicalMonitor = $m.Handle })) | Out-Null } catch {}
    }
    return
}

# ── -Serve: persistent stdio host ───────────────────────────────────────────────
# Enumerate once and keep the handles open for the session. Values can drift if the
# user turns the monitor's own OSD knobs, so a "list" command re-reads them live.
$script:mons = Get-Monitors

function Send-Frame($obj) {
    $json = ($obj | ConvertTo-Json -Depth 6 -Compress)
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [Console]::Out.WriteLine("XEDDC $b64")
    [Console]::Out.Flush()
}

function Invoke-Command-Line([string]$line) {
    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { return }
    $id = $req.id
    try {
        switch ($req.action) {
            'list' {
                foreach ($m in $script:mons) { $m.Features = Read-Features $m.Handle }
                $wire = ConvertTo-Wire $script:mons
                Send-Frame @{ id = $id; ok = $true; monitors = $wire.monitors }
            }
            'set' {
                $mon = $script:mons | Where-Object { $_.Key -eq $req.key } | Select-Object -First 1
                if (-not $mon) { Send-Frame @{ id = $id; ok = $false; err = 'unknown monitor' }; return }
                if (-not $FEATURES.Contains([string]$req.feature)) { Send-Frame @{ id = $id; ok = $false; err = 'unknown feature' }; return }
                $f = $mon.Features[[string]$req.feature]
                if (-not $f.supported) { Send-Frame @{ id = $id; ok = $false; err = 'feature unsupported' }; return }
                $vcp = $FEATURES[[string]$req.feature]
                $val = [int]$req.value
                if ($val -lt 0) { $val = 0 }
                if ($val -gt $f.max) { $val = $f.max }
                if ([Ddc]::SetVCPFeature($mon.Handle, $vcp, [uint32]$val)) {
                    $f.cur = $val
                    Send-Frame @{ id = $id; ok = $true; feature = $req.feature; value = $val }
                } else {
                    Send-Frame @{ id = $id; ok = $false; err = 'write failed' }
                }
            }
            'reset' {
                $mon = $script:mons | Where-Object { $_.Key -eq $req.key } | Select-Object -First 1
                if (-not $mon) { Send-Frame @{ id = $id; ok = $false; err = 'unknown monitor' }; return }
                if (-not $mon.CanReset) { Send-Frame @{ id = $id; ok = $false; err = 'reset unsupported' }; return }
                [void][Ddc]::SetVCPFeature($mon.Handle, $VCP_RESET, [uint32]1)
                Start-Sleep -Milliseconds 250   # let the panel apply before we re-read
                $mon.Features = Read-Features $mon.Handle
                Send-Frame @{ id = $id; ok = $true; features = $mon.Features }
            }
            default { Send-Frame @{ id = $id; ok = $false; err = 'unknown action' } }
        }
    } catch {
        Send-Frame @{ id = $id; ok = $false; err = $_.Exception.Message }
    }
}

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }   # stdin closed → server is retiring us
        $line = $line.Trim()
        if ($line) { Invoke-Command-Line $line }
    }
} finally {
    foreach ($m in $script:mons) {
        try { [Ddc]::DestroyPhysicalMonitors(1, @([Ddc+PHYSICAL_MONITOR]@{ hPhysicalMonitor = $m.Handle })) | Out-Null } catch {}
    }
}
