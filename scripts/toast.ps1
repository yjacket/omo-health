# Show one Windows toast. Input is a UTF-8 JSON file {title, body, tag} so
# Korean text survives the process boundary untouched.
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'
$data = Get-Content -Raw -Encoding UTF8 -LiteralPath $File | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$title = [System.Security.SecurityElement]::Escape([string]$data.title)
$body = [System.Security.SecurityElement]::Escape([string]$data.body)
$xml = "<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>"
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
if ($data.tag) { $toast.Tag = ([string]$data.tag).Substring(0, [Math]::Min(64, ([string]$data.tag).Length)) }
$toast.Group = 'omo-health'
# PowerShell's AppUserModelID: always registered, so the toast shows without an installer.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
Write-Output 'shown'
