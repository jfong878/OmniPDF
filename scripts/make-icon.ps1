Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\assets'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$master = 512
$bmp = New-Object System.Drawing.Bitmap $master, $master
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# ---- rounded background -------------------------------------------------
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$rect = New-Object System.Drawing.Rectangle 16, 16, 480, 480
$d = 224
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 252, 94, 84),
  [System.Drawing.Color]::FromArgb(255, 122, 5, 16),
  90
)
$g.FillPath($bg, $path)

$g.SetClip($path)

# smooth top gloss: fades out completely, so there is no visible boundary
$glossRect = New-Object System.Drawing.Rectangle 16, 16, 480, 250
$gloss = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $glossRect,
  [System.Drawing.Color]::FromArgb(92, 255, 255, 255),
  [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
  90
)
$g.FillRectangle($gloss, 16, 16, 480, 250)

# depth at the base
$vigRect = New-Object System.Drawing.Rectangle 16, 330, 480, 180
$vig = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $vigRect,
  [System.Drawing.Color]::FromArgb(0, 60, 0, 6),
  [System.Drawing.Color]::FromArgb(70, 60, 0, 6),
  90
)
$g.FillRectangle($vig, 16, 330, 480, 180)

$g.ResetClip()

# ---- soft drop shadow ---------------------------------------------------
# GDI+ has no blur, so the silhouette is downscaled then upscaled with
# bicubic interpolation, which produces a genuine soft falloff.
$px = 150; $py = 104; $pw = 212; $ph = 272

$silhouette = New-Object System.Drawing.Bitmap 512, 512
$sg = [System.Drawing.Graphics]::FromImage($silhouette)
$sg.Clear([System.Drawing.Color]::Transparent)
$sb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 66, 0, 10))
$sg.FillRectangle($sb, $px, $py, $pw, $ph)
$sg.Dispose()

$tiny = New-Object System.Drawing.Bitmap 32, 32
$tg = [System.Drawing.Graphics]::FromImage($tiny)
$tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$tg.Clear([System.Drawing.Color]::Transparent)
$tg.DrawImage($silhouette, 0, 0, 32, 32)
$tg.Dispose()

$attrs = New-Object System.Drawing.Imaging.ImageAttributes
$matrix = New-Object System.Drawing.Imaging.ColorMatrix
$matrix.Matrix33 = 0.6
$attrs.SetColorMatrix($matrix)

$destRect = New-Object System.Drawing.Rectangle 12, 18, 512, 512
$g.DrawImage($tiny, $destRect, 0, 0, 32, 32, [System.Drawing.GraphicsUnit]::Pixel, $attrs)

$attrs.Dispose()
$tiny.Dispose()
$silhouette.Dispose()

# ---- sheet --------------------------------------------------------------
$paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$g.FillRectangle($paper, $px, $py, $pw, $ph)

$fold = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 216, 216))
$pts = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point 322, 104),
  (New-Object System.Drawing.Point 362, 144),
  (New-Object System.Drawing.Point 322, 144)
)
$g.FillPolygon($fold, $pts)

$lineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 160, 166))
foreach ($y in @(196, 228, 260)) {
  $g.FillRectangle($lineBrush, 182, $y, 148, 9)
}

$sig = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 174, 26)), 13
$sig.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$sig.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawBezier($sig, 184, 328, 232, 282, 268, 356, 332, 306)

# ---- crisp inner edge ---------------------------------------------------
$edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 255, 255, 255)), 2.5
$g.DrawPath($edge, $path)

$g.Dispose()
$bmp.Save((Join-Path $outDir 'icon-master.png'), [System.Drawing.Imaging.ImageFormat]::Png)

foreach ($size in @(256, 128, 64, 48, 32, 16)) {
  $dst = New-Object System.Drawing.Bitmap $size, $size
  $dg = [System.Drawing.Graphics]::FromImage($dst)
  $dg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $dg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $dg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $dg.Clear([System.Drawing.Color]::Transparent)
  $dg.DrawImage($bmp, 0, 0, $size, $size)
  $dg.Dispose()
  $dst.Save((Join-Path $outDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()
}

$bmp.Dispose()
Write-Output "icon rebuilt"
