# DDC/CI feasibility probe — throwaway diagnostic (NOT part of the app, not committed).
# Enumerates every physical monitor and asks each one, over DDC/CI, whether it
# exposes brightness / contrast / RGB-gain controls. Run it once on the machine
# driving the Xeneon Edge to confirm the panel actually answers DDC/CI before we
# build the in-app brightness controls.
#
#   Run:  pwsh -ExecutionPolicy Bypass -File tools/ddcci-probe.ps1
#
# What to look for in the output: the Xeneon Edge listed with "Brightness: OK"
# and a capabilities string that includes VCP code 10 (and ideally 12, 16, 18, 1A).

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR {
        public IntPtr hPhysicalMonitor;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szDescription;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);

    [DllImport("dxva2.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint count, [Out] PHYSICAL_MONITOR[] arr);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetMonitorBrightness(IntPtr h, out uint min, out uint cur, out uint max);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetMonitorContrast(IntPtr h, out uint min, out uint cur, out uint max);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetCapabilitiesStringLength(IntPtr h, out uint len);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool CapabilitiesRequestAndCapabilitiesReply(IntPtr h, StringBuilder reply, uint len);

    [DllImport("dxva2.dll", SetLastError = true)]
    public static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte vcp, out int type, out uint cur, out uint max);

    [DllImport("dxva2.dll")]
    public static extern bool DestroyPhysicalMonitors(uint count, [In] PHYSICAL_MONITOR[] arr);
}
"@

$hmonitors = New-Object System.Collections.Generic.List[IntPtr]
$cb = [Ddc+MonitorEnumProc] {
    param([IntPtr]$h, [IntPtr]$hdc, [ref]$rect, [IntPtr]$data)
    $hmonitors.Add($h)
    return $true
}
[void][Ddc]::EnumDisplayMonitors([IntPtr]::Zero, [IntPtr]::Zero, $cb, [IntPtr]::Zero)

Write-Host ""
Write-Host "=== DDC/CI probe — $($hmonitors.Count) display(s) found ===" -ForegroundColor Cyan
Write-Host ""

$idx = 0
foreach ($hm in $hmonitors) {
    $idx++
    $count = 0
    if (-not [Ddc]::GetNumberOfPhysicalMonitorsFromHMONITOR($hm, [ref]$count) -or $count -eq 0) {
        Write-Host "[$idx] (no physical monitor handle)" -ForegroundColor DarkGray
        continue
    }
    $arr = New-Object 'Ddc+PHYSICAL_MONITOR[]' $count
    if (-not [Ddc]::GetPhysicalMonitorsFromHMONITOR($hm, $count, $arr)) {
        Write-Host "[$idx] GetPhysicalMonitorsFromHMONITOR failed" -ForegroundColor Red
        continue
    }

    # Identify this HMONITOR: GDI device name (\\.\DISPLAYn — matches Windows
    # "Display N") + logical resolution/position, so the Edge can be pinpointed.
    $mi = New-Object 'Ddc+MONITORINFOEX'
    $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    $devLine = ''
    if ([Ddc]::GetMonitorInfo($hm, [ref]$mi)) {
        $w = $mi.rcMonitor.right - $mi.rcMonitor.left
        $ht = $mi.rcMonitor.bottom - $mi.rcMonitor.top
        $primary = if (($mi.dwFlags -band 1) -ne 0) { ' [PRIMARY]' } else { '' }
        $devLine = "  ($($mi.szDevice)  ${w}x${ht}  @ $($mi.rcMonitor.left),$($mi.rcMonitor.top))$primary"
    }

    foreach ($pm in $arr) {
        $h = $pm.hPhysicalMonitor
        Write-Host "[$idx] $($pm.szDescription)$devLine" -ForegroundColor White

        $bMin = 0; $bCur = 0; $bMax = 0
        if ([Ddc]::GetMonitorBrightness($h, [ref]$bMin, [ref]$bCur, [ref]$bMax)) {
            Write-Host ("      Brightness: OK   min=$bMin cur=$bCur max=$bMax") -ForegroundColor Green
        } else {
            Write-Host ("      Brightness: not supported (err $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))") -ForegroundColor Yellow
        }

        $cMin = 0; $cCur = 0; $cMax = 0
        if ([Ddc]::GetMonitorContrast($h, [ref]$cMin, [ref]$cCur, [ref]$cMax)) {
            Write-Host ("      Contrast:   OK   min=$cMin cur=$cCur max=$cMax") -ForegroundColor Green
        } else {
            Write-Host ("      Contrast:   not supported") -ForegroundColor Yellow
        }

        # RGB gains (VCP 0x16 red, 0x18 green, 0x1A blue) + luminance 0x10 direct read
        foreach ($vcp in @(0x10, 0x12, 0x16, 0x18, 0x1A)) {
            $type = 0; $cur = 0; $max = 0
            if ([Ddc]::GetVCPFeatureAndVCPFeatureReply($h, [byte]$vcp, [ref]$type, [ref]$cur, [ref]$max)) {
                Write-Host ("      VCP 0x{0:X2}:   cur=$cur max=$max" -f $vcp) -ForegroundColor Green
            } else {
                Write-Host ("      VCP 0x{0:X2}:   -" -f $vcp) -ForegroundColor DarkGray
            }
        }

        $len = 0
        if ([Ddc]::GetCapabilitiesStringLength($h, [ref]$len) -and $len -gt 0) {
            $sb = New-Object System.Text.StringBuilder ([int]$len)
            if ([Ddc]::CapabilitiesRequestAndCapabilitiesReply($h, $sb, $len)) {
                Write-Host ("      Capabilities: " + $sb.ToString()) -ForegroundColor DarkCyan
            }
        } else {
            Write-Host "      Capabilities: (none reported)" -ForegroundColor DarkGray
        }
        Write-Host ""
    }

    [void][Ddc]::DestroyPhysicalMonitors($count, $arr)
}

Write-Host ""
Write-Host "=== Monitor friendly names (EDID via WMI) ===" -ForegroundColor Cyan
try {
    Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop | ForEach-Object {
        $name = -join ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
        Write-Host ("  {0,-40} -> {1}" -f $_.InstanceName, $name)
    }
} catch {
    Write-Host "  (WmiMonitorID unavailable: $($_.Exception.Message))" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Done. Tell me which entry above is the Xeneon Edge (match the friendly"
Write-Host "name, or the \\.\DISPLAYn / resolution). If the Edge shows 'Brightness: OK'"
Write-Host "and VCP 0x10, we can drive it; if not, DDC/CI over its link isn't exposed."
