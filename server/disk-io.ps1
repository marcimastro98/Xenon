# I/O per disco fisico, per lo stream SDK `diskIo` (chiesto su Discord per un
# widget di monitoraggio: throughput, IOPS, modello, etichetta del volume).
#
# Contatori RAW, non Formatted. Win32_PerfFormattedData_* fa DUE letture dentro
# WMI a ogni query per poter calcolare il rate da solo: si paga il doppio e si
# aspetta l'intervallo. Qui prendiamo i cumulativi e il delta lo fa server.js,
# esattamente come per la rete.
#
# Gira SOLO quando un widget lo chiede (stream pull), mai nel poll dei sensori.
$ErrorActionPreference = 'SilentlyContinue'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# ----- CONTATORI PER DISCO FISICO -----
# Name e' "0 C:" / "1 D: E:" / "_Total". Il numero iniziale e' l'indice del
# disco fisico, le lettere sono i volumi che ci stanno sopra: la riga porta
# gia' l'associazione disco -> volumi, senza una seconda query.
$rows = New-Object System.Collections.ArrayList
try {
  $perf = Get-CimInstance -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk -ErrorAction Stop
  foreach ($p in $perf) {
    $name = [string]$p.Name
    if (-not $name -or $name -eq '_Total') { continue }
    $idx = -1
    $letters = @()
    $parts = $name.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Count -ge 1 -and [int]::TryParse($parts[0], [ref]$idx)) {
      for ($i = 1; $i -lt $parts.Count; $i++) { $letters += $parts[$i] }
    } else { continue }
    [void]$rows.Add(@{
      index           = $idx
      drives          = @($letters)
      readBytes       = [int64]$p.DiskReadBytesPersec
      writeBytes      = [int64]$p.DiskWriteBytesPersec
      readsCompleted  = [int64]$p.DiskReadsPersec
      writesCompleted = [int64]$p.DiskWritesPersec
    })
  }
} catch { }

# ----- MODELLO, SERIALE, DIMENSIONE -----
# Una query sola su Win32_DiskDrive; Index la lega alle righe sopra.
$drives = @{}
try {
  foreach ($d in Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction Stop) {
    $drives[[int]$d.Index] = @{
      model  = [string]$d.Model
      serial = ([string]$d.SerialNumber).Trim()
      size   = $(if ($d.Size) { [int64]$d.Size } else { $null })
      bus    = [string]$d.InterfaceType
      media  = [string]$d.MediaType
    }
  }
} catch { }

# ----- ETICHETTE DEI VOLUMI -----
# Solo le lettere che i contatori hanno gia' nominato: enumerare tutto
# costerebbe una terza query per dischi che nessuno sta guardando.
$labels = @{}
try {
  foreach ($v in Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop) {
    $labels[[string]$v.DeviceID] = [string]$v.VolumeName
  }
} catch { }

$out = New-Object System.Collections.ArrayList
foreach ($r in $rows) {
  $info = $drives[[int]$r.index]
  $vols = New-Object System.Collections.ArrayList
  foreach ($letter in $r.drives) {
    [void]$vols.Add(@{ mount = $letter; label = [string]$labels[$letter]; fstype = '' })
  }
  # `id` e' stabile fra riavvii quanto l'indice del disco fisico; il seriale
  # viaggia accanto per chi vuole esserne certo.
  [void]$out.Add(@{
    id              = 'phys' + $r.index
    model           = $(if ($info -and $info.model) { $info.model } else { 'Disk ' + $r.index })
    serial          = $(if ($info) { $info.serial } else { '' })
    sizeBytes       = $(if ($info) { $info.size } else { $null })
    # Win32_DiskDrive non distingue SSD e HDD (MediaType dice "Fixed hard disk"
    # per entrambi). MSFT_PhysicalDisk lo saprebbe, ma e' una terza query in un
    # altro namespace: meglio niente che una sigla sbagliata sulla riga.
    kind            = ''
    volumes         = @($vols)
    readBytes       = $r.readBytes
    writeBytes      = $r.writeBytes
    readsCompleted  = $r.readsCompleted
    writesCompleted = $r.writesCompleted
    # La temperatura del disco vorrebbe una lettura SMART: la farebbe
    # LibreHardwareMonitor, ma abilitare il suo albero Storage significa
    # interrogare SMART a ogni lettura sensori - e svegliare un disco meccanico
    # fermo ogni cinque secondi. Resta null finche' non c'e' un modo di pagarlo
    # solo a chi lo chiede.
    temperature     = $null
  })
}

# -Depth 4: le hashtable dentro l'array (e `volumes` dentro quelle) altrimenti
# escono come "System.Collections.Hashtable".
@{ disks = @($out) } | ConvertTo-Json -Compress -Depth 4
