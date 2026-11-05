# Builds transformHub.ico from an image in this folder, without stretching it.
# Usage:  powershell -ExecutionPolicy Bypass -File .\Make-Icon.ps1            (uses thumbnail.png, or transformHub.png)
#         powershell -ExecutionPolicy Bypass -File .\Make-Icon.ps1 -Source .\myimage.png
param([string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = $PSScriptRoot
if (-not $Source) {
  foreach ($n in 'thumbnail.png', 'transformHub.png') { if (Test-Path (Join-Path $root $n)) { $Source = Join-Path $root $n; break } }
}
if (-not $Source -or -not (Test-Path $Source)) { throw 'No source image found. Put thumbnail.png or transformHub.png in this folder, or pass -Source.' }

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$sizes = 16, 32, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  # fit inside the square, keep the proportions, centre it (no stretching)
  $scale = [Math]::Min($s / $src.Width, $s / $src.Height)
  $w = [int][Math]::Round($src.Width * $scale); $h = [int][Math]::Round($src.Height * $scale)
  $g.DrawImage($src, [int](($s - $w) / 2), [int](($s - $h) / 2), $w, $h)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , $ms.ToArray()
  $bmp.Dispose(); $ms.Dispose()
}
$src.Dispose()

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
$dest = Join-Path $root 'transformHub.ico'
[System.IO.File]::WriteAllBytes($dest, $out.ToArray())
Write-Host "Created $dest"
Write-Host 'Now run: powershell -File .\Start-transformHub.ps1 -Shortcut   (delete the old desktop shortcut first)'
