param(
  [string]$SourceDir = (Join-Path $PSScriptRoot '..\dist\win-unpacked'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\OmniPDF'),
  [switch]$SkipPin
)

$ErrorActionPreference = 'Stop'

Write-Output "OmniPDF installer"
Write-Output "  source: $SourceDir"
Write-Output "  target: $InstallDir"

if (-not (Test-Path $SourceDir)) {
  throw "Packaged build not found: $SourceDir"
}

Get-Process -Name OmniPDF -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item (Join-Path $SourceDir '*') $InstallDir -Recurse -Force

$exe = Join-Path $InstallDir 'OmniPDF.exe'
if (-not (Test-Path $exe)) { throw "Executable missing after copy: $exe" }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\OmniPDF.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OmniPDF.lnk')
)
if (-not $SkipPin) {
  $targets += (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\OmniPDF.lnk')
}

foreach ($lnk in $targets) {
  $shortcut = $shell.CreateShortcut($lnk)
  $shortcut.TargetPath = $exe
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.IconLocation = "$exe,0"
  $shortcut.Description = 'OmniPDF — PDF viewer, editor, signer, OCR'
  $shortcut.Save()
  Write-Output "  shortcut: $lnk"
}

# File associations: offer OmniPDF for .pdf without stealing the default.
$progId = 'OmniPDF.Document'
$regRoot = 'HKCU:\Software\Classes'
New-Item -Path "$regRoot\$progId" -Force | Out-Null
Set-ItemProperty -Path "$regRoot\$progId" -Name '(default)' -Value 'PDF Document'
New-Item -Path "$regRoot\$progId\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$regRoot\$progId\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""
New-Item -Path "$regRoot\$progId\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$regRoot\$progId\DefaultIcon" -Name '(default)' -Value "$exe,0"
New-Item -Path "$regRoot\.pdf\OpenWithProgids" -Force | Out-Null
Set-ItemProperty -Path "$regRoot\.pdf\OpenWithProgids" -Name $progId -Value ([byte[]]@()) -Type Binary

# Application registration: this is what makes OmniPDF selectable as the
# default PDF handler in Settings > Default apps. Windows protects the
# UserChoice default with a hash, so no program can set it silently —
# the registration below only offers the app; the user confirms the choice.
$capRoot = 'HKCU:\Software\OmniPDF\Capabilities'
New-Item -Path $capRoot -Force | Out-Null
Set-ItemProperty -Path $capRoot -Name 'ApplicationName' -Value 'OmniPDF'
Set-ItemProperty -Path $capRoot -Name 'ApplicationDescription' -Value 'OmniPDF — PDF viewer, editor, signer, OCR'
New-Item -Path "$capRoot\FileAssociations" -Force | Out-Null
Set-ItemProperty -Path "$capRoot\FileAssociations" -Name '.pdf' -Value $progId
New-Item -Path 'HKCU:\Software\RegisteredApplications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name 'OmniPDF' -Value 'Software\OmniPDF\Capabilities'
Write-Output "  registered: OmniPDF handles .pdf (Settings > Default apps)"

Write-Output "Installed."
