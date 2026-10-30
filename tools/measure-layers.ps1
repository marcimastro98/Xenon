# Memory and CPU of the native shell and everything it started (WebView2 browser,
# renderers, GPU process), plus its widget-layer windows. Used to hold the layers
# to their budget (one surface per layer per monitor, ~15 MB per anchored widget,
# zero CPU at rest and while hidden). Read-only: it never touches the processes.
#
#   Run:  pwsh -File tools/measure-layers.ps1 [-Seconds 10] [-ProcessId <pid>]
#
# Without -ProcessId it measures the running shell (xenon-native.exe in a dev
# build, Xenon.exe installed). Compare a run with no layers against one with
# layers placed: the difference is what the layers cost.

param(
    [int]$Seconds = 10,
    [int]$ProcessId = 0
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace MeasureLayers -Name Win -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
public static int[] Layers(uint pid) {
    int shown = 0, hidden = 0;
    EnumWindows((h, l) => {
        uint id; GetWindowThreadProcessId(h, out id);
        if (id != pid) return true;
        var t = new System.Text.StringBuilder(64); GetWindowTextW(h, t, 64);
        if (t.ToString() == "Xenon widgets") { if (IsWindowVisible(h)) shown++; else hidden++; }
        return true;
    }, System.IntPtr.Zero);
    return new[] { shown, hidden };
}
'@

function Find-Shell {
    if ($ProcessId) { return Get-Process -Id $ProcessId }
    $p = Get-Process -Name 'xenon-native', 'Xenon' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { throw 'No Xenon shell is running. Start it, or pass -ProcessId.' }
    $p
}

# The shell and every descendant, from one process snapshot.
function Get-Tree([int]$root) {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
    $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($root)
    do {
        $added = $false
        foreach ($p in $all) {
            if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true }
        }
    } while ($added)
    $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
}

function Role($p) {
    if ($p.Name -notmatch 'msedgewebview2') { return 'shell' }
    if ($p.CommandLine -match '--type=([\w-]+)') { return $Matches[1] }
    'browser'
}

$shell = Find-Shell
$tree = Get-Tree $shell.Id
$procs = foreach ($t in $tree) {
    $gp = Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue
    if ($gp) { [pscustomobject]@{ Role = (Role $t); Proc = $gp; Cpu0 = $gp.TotalProcessorTime } }
}
Start-Sleep -Seconds $Seconds
$cores = [Environment]::ProcessorCount
$rows = foreach ($r in $procs) {
    $r.Proc.Refresh()
    if ($r.Proc.HasExited) { continue }
    [pscustomobject]@{
        Role      = $r.Role
        Pid       = $r.Proc.Id
        WorkingMB = [math]::Round($r.Proc.WorkingSet64 / 1MB)
        PrivateMB = [math]::Round($r.Proc.PrivateMemorySize64 / 1MB)
        CpuPct    = [math]::Round(($r.Proc.TotalProcessorTime - $r.Cpu0).TotalMilliseconds / ($Seconds * 10 * $cores), 2)
    }
}
$rows | Sort-Object Role, Pid | Format-Table -AutoSize
$layers = [MeasureLayers.Win]::Layers([uint32]$shell.Id)
'{0} processes: {1:N0} MB working set, {2:N0} MB private, {3:N2}% CPU over {4} s (of all {5} cores)' -f `
    @($rows).Count, ($rows | Measure-Object WorkingMB -Sum).Sum, ($rows | Measure-Object PrivateMB -Sum).Sum,
    ($rows | Measure-Object CpuPct -Sum).Sum, $Seconds, $cores
'Layer windows: {0} shown, {1} hidden' -f $layers[0], $layers[1]
