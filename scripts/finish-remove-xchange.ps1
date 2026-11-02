$ErrorActionPreference = 'Continue'

Write-Output 'Finishing PDF-XChange removal'

$dir = 'C:\Program Files\PDF-XChange'
if (Test-Path $dir) {
  Remove-Item $dir -Recurse -Force -ErrorAction Continue
}
if (Test-Path $dir) {
  Write-Output "PARTIAL: still locked -> $dir"
  Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 5 -ExpandProperty FullName
} else {
  Write-Output "removed: $dir"
}

$shortcutHomes = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  ([Environment]::GetFolderPath('Desktop')),
  'C:\Users\Public\Desktop'
)

foreach ($shortcutHome in $shortcutHomes) {
  if (-not (Test-Path $shortcutHome)) { continue }
  Get-ChildItem $shortcutHome -Recurse -Filter '*PDF-XChange*' -ErrorAction SilentlyContinue |
    ForEach-Object {
      Remove-Item $_.FullName -Force -ErrorAction Continue
      Write-Output "removed shortcut: $($_.FullName)"
    }
}

$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
Get-ChildItem $pinned -Filter '*PDF-XChange*' -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item $_.FullName -Force -ErrorAction Continue
  Write-Output "removed pin: $($_.Name)"
}

if (Test-Path (Join-Path $pinned 'OmniPDF.lnk')) {
  Write-Output 'OmniPDF pin present'
} else {
  Write-Output 'OmniPDF pin MISSING'
}

Write-Output 'FINISH_DONE'
