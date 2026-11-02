$ErrorActionPreference = 'Continue'

Write-Output 'PDF-XChange Editor forced removal'

$processNames = @('PDFXEdit', 'PDFXTools', 'PDFXChangeEditor', 'PDFXChange', 'PDFXChangeEditorShellExt')
foreach ($name in $processNames) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 700

foreach ($dir in @('C:\Program Files\PDF-XChange', 'C:\Program Files\Tracker Software')) {
  if (Test-Path $dir) {
    Remove-Item $dir -Recurse -Force -ErrorAction Continue
    if (Test-Path $dir) { Write-Output "PARTIAL: $dir" } else { Write-Output "removed: $dir" }
  }
}

$uninstallRoots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $uninstallRoots) {
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($props.DisplayName -like '*PDF-XChange*') {
      Remove-Item $_.PSPath -Recurse -Force -ErrorAction Continue
      Write-Output "removed registry: $($props.DisplayName)"
    }
  }
}

$shortcutHomes = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  ([Environment]::GetFolderPath('Desktop')),
  'C:\Users\Public\Desktop'
)
foreach ($home in $shortcutHomes) {
  if (-not (Test-Path $home)) { continue }
  Get-ChildItem $home -Recurse -Filter '*PDF-XChange*' -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction Continue
    Write-Output "removed shortcut: $($_.FullName)"
  }
}

$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
Get-ChildItem $pinned -Filter '*PDF-XChange*' -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item $_.FullName -Force -ErrorAction Continue
  Write-Output "removed pin: $($_.Name)"
}

# Offer OmniPDF as the handler now that the previous one is gone.
$exe = Join-Path $env:LOCALAPPDATA 'Programs\OmniPDF\OmniPDF.exe'
if (Test-Path $exe) {
  $progId = 'OmniPDF.Document'
  New-Item -Path "HKCU:\Software\Classes\$progId\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Classes\$progId" -Name '(default)' -Value 'PDF Document'
  Set-ItemProperty -Path "HKCU:\Software\Classes\$progId\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""
  New-Item -Path "HKCU:\Software\Classes\.pdf\OpenWithProgids" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Classes\.pdf\OpenWithProgids" -Name $progId -Value ([byte[]]@()) -Type Binary
  Write-Output 'registered OmniPDF as an Open With handler'
}

Write-Output 'FORCE_REMOVE_DONE'
