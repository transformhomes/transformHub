# Opens transformHub. Run via transformHub.cmd (double-click) or: powershell -File Start-transformHub.ps1
# Add -Shortcut to create a desktop shortcut that runs this launcher.
param([switch]$Shortcut)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Fail($msg) {
  Add-Type -AssemblyName PresentationFramework
  [void][System.Windows.MessageBox]::Show($msg, 'transformHub', 'OK', 'Warning')
  exit 1
}

if ($Shortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'transformHub.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = Join-Path $root 'transformHub.cmd'
  $s.WorkingDirectory = $root
  $s.WindowStyle = 7
  $ico = Join-Path $root 'thumbnail.ico'
  if (-not (Test-Path $ico)) { $ico = Join-Path $root 'transformHub.ico' }
  if (Test-Path $ico) { $s.IconLocation = "$ico,0" }
  $s.Save()
  Write-Host "Shortcut created: $lnk"
  exit 0
}

$electronCmd = Join-Path $root 'node_modules\.bin\electron.cmd'

$icalDir = Join-Path $root 'node_modules\ical.js'
if (-not (Test-Path $electronCmd) -or -not (Test-Path $icalDir)) {
  # First run, or new dependencies after an update: install dependencies (needs Node.js, plus pnpm or npm)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was not found. Install Node.js 20 or newer from nodejs.org, then try again.' }
  Write-Host 'First run: installing dependencies, this takes a minute...'
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { & pnpm install } else { & npm install }
  # pnpm may skip Electron's download step; run it directly if the binary is missing
  $installJs = Get-ChildItem -Path (Join-Path $root 'node_modules') -Recurse -Filter install.js -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'electron[\\/]install\.js$' } | Select-Object -First 1
  $dist = Get-ChildItem -Path (Join-Path $root 'node_modules') -Recurse -Filter electron.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $dist -and $installJs) { & node $installJs.FullName }
  if (-not (Test-Path $electronCmd)) { Fail 'Install did not finish. Open a terminal in this folder and run: pnpm install' }
}

Start-Process -FilePath $electronCmd -ArgumentList '.' -WorkingDirectory $root -WindowStyle Hidden
