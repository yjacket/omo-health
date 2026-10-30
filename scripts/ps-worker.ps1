# omo-health process snapshot worker.
# Long-lived: reads one command per stdin line, answers with one compact JSON line.
#   snap  -> all processes (pid, ppid, name, creation time, cpu ms, private bytes, working set, command line,
#            wv: owns a visible top-level window, wt: its title, at most 200 chars)
#   os    -> commit charge and physical memory (KB)
#   ports -> listening TCP ports with owning pid
#   ping  -> liveness check
#   exit  -> quit
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true

function Emit($obj) {
	$out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
}

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	$cmd = $line.Trim()
	if ($cmd -eq '') { continue }
	try {
		switch ($cmd) {
			'snap' {
				$windows = @{}
				foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
					if ($proc.MainWindowHandle -ne 0) {
						$title = [string]$proc.MainWindowTitle
						if ($title.Length -gt 200) { $title = $title.Substring(0, 200) }
						$windows[[int]$proc.Id] = $title
					}
				}
				$rows = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate, KernelModeTime, UserModeTime, PrivatePageCount, WorkingSetSize, ReadTransferCount, WriteTransferCount, CommandLine | ForEach-Object {
					$cl = $_.CommandLine
					if ($cl -and $cl.Length -gt 2000) { $cl = $cl.Substring(0, 2000) }
					$ct = $null
					$wv = $windows.ContainsKey([int]$_.ProcessId)
					$wt = $null
					if ($wv -and $windows[[int]$_.ProcessId]) { $wt = $windows[[int]$_.ProcessId] }
					if ($_.CreationDate) { $ct = $_.CreationDate.ToUniversalTime().ToString('o') }
					[pscustomobject]@{
						p   = [int]$_.ProcessId
						pp  = [int]$_.ParentProcessId
						n   = $_.Name
						c   = $ct
						cpu = [math]::Round(([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000)
						pv  = [int64]$_.PrivatePageCount
						ws  = [int64]$_.WorkingSetSize
						rb  = [int64]$_.ReadTransferCount
						wb  = [int64]$_.WriteTransferCount
						cl  = $cl
						wv  = $wv
						wt  = $wt
					}
				})
				Emit @{ cmd = 'snap'; ok = $true; ts = (Get-Date).ToUniversalTime().ToString('o'); data = $rows }
			}
			'os' {
				$os = Get-CimInstance Win32_OperatingSystem
				Emit @{ cmd = 'os'; ok = $true; data = @{
						totalVirtualKB  = [int64]$os.TotalVirtualMemorySize
						freeVirtualKB   = [int64]$os.FreeVirtualMemory
						totalVisibleKB  = [int64]$os.TotalVisibleMemorySize
						freePhysicalKB  = [int64]$os.FreePhysicalMemory
					} }
			}
			'ports' {
				$rows = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
					[pscustomobject]@{ a = [string]$_.LocalAddress; port = [int]$_.LocalPort; p = [int]$_.OwningProcess }
				})
				Emit @{ cmd = 'ports'; ok = $true; data = $rows }
			}
			'ping' { Emit @{ cmd = 'ping'; ok = $true; data = $PID } }
			'exit' { Emit @{ cmd = 'exit'; ok = $true }; break }
			default { Emit @{ cmd = $cmd; ok = $false; error = 'unknown command' } }
		}
		if ($cmd -eq 'exit') { break }
	}
	catch {
		Emit @{ cmd = $cmd; ok = $false; error = [string]$_.Exception.Message }
	}
}
