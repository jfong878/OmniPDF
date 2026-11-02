param(
  [string]$SourceDir = (Join-Path $PSScriptRoot '..\dist\OmniPDF-win32-x64'),
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

Write-Output "Installed."
