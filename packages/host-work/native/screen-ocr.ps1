# DSH Work — Windows screen reader.
#
# Replaces the macOS Swift helper on Windows: same command line, same JSON
# shapes, same normalised line coordinates, so the TypeScript parser is shared.
#
#   screen-ocr.ps1 --list          visible windows as JSON
#   screen-ocr.ps1 --frontmost     foreground application as JSON
#   screen-ocr.ps1 --feishu        pick the Feishu window, capture + OCR it
#   screen-ocr.ps1 <pid> [window]  capture one window and OCR it
#
# Windows has no equivalent of `screencapture -l`, so the window is rendered with
# PrintWindow(PW_RENDERFULLCONTENT); when that yields a blank bitmap (some GPU
# surfaces), it falls back to copying the on-screen rectangle. OCR is the built-in
# Windows.Media.Ocr engine, scaled up 2x because the UI text is small and the
# Windows model reads it more accurately at that size.
#
# Must run under Windows PowerShell 5.1: WinRT projections are not available in
# PowerShell 7 without extra modules. Everything expensive (GDI+, WinRT) is
# loaded only for the modes that need it, because a process costs ~0.5 s.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'

if ($args.Count -lt 1) {
  [Console]::Error.Write('usage: screen-ocr.ps1 --list | --frontmost | --feishu | <pid> [window]')
  exit 1
}

$mode = $args[0]
$isCapture = $mode -notin @('--list', '--frontmost')
$isFeishu = $mode -eq '--feishu'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# The Win32 interop block is compiled once into the user cache: Add-Type from
# source costs about a second per process, and the helper is spawned per read.
$interopSource = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DshScreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

  public static string ProcessName(uint pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) return "";
    try {
      uint size = 1024;
      StringBuilder buffer = new StringBuilder((int)size);
      if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return "";
      string full = buffer.ToString();
      int slash = full.LastIndexOfAny(new char[] { '\\', '/' });
      string name = slash >= 0 ? full.Substring(slash + 1) : full;
      return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
    } finally { CloseHandle(handle); }
  }

  public static string Title(IntPtr hwnd) {
    int length = GetWindowTextLengthW(hwnd);
    if (length <= 0) return "";
    StringBuilder buffer = new StringBuilder(length + 2);
    GetWindowTextW(hwnd, buffer, buffer.Capacity);
    return buffer.ToString();
  }

  public static bool Cloaked(IntPtr hwnd) {
    int cloaked = 0;
    // DWMWA_CLOAKED: hidden UWP frames and suspended windows report 1..4.
    if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) != 0) return false;
    return cloaked != 0;
  }

  public static IntPtr[] TopLevelWindows() {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr lparam) { found.Add(hwnd); return true; }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@

$cacheDir = Join-Path $env:LOCALAPPDATA 'dsh-work\bin'
$assemblyPath = Join-Path $cacheDir 'dsh-screen-interop.dll'
$hashPath = Join-Path $cacheDir 'dsh-screen-interop.sha256'
$hash = [System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes($interopSource)
  )
).Replace('-', '')
$cachedHash = if (Test-Path $hashPath) { (Get-Content -LiteralPath $hashPath -Raw).Trim() } else { '' }
if ((Test-Path $assemblyPath) -and $cachedHash -eq $hash) {
  Add-Type -Path $assemblyPath
} else {
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  Add-Type -TypeDefinition $interopSource -OutputAssembly $assemblyPath -OutputType Library
  Set-Content -LiteralPath $hashPath -Value $hash -Encoding ascii -NoNewline
  Add-Type -Path $assemblyPath
}

# GDI+ and the WinRT projections are only needed to capture + OCR.
if ($isCapture) {
  Add-Type -AssemblyName System.Drawing
  # PowerShell 5.1 exposes WinRT types only through the assembly-qualified form.
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
}

function Await($operation, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($operation))
  [void]$task.Wait(-1)
  $task.Result
}

function Emit($value) {
  # PS 5.1 writes stdout in the console code page otherwise, which mangles CJK.
  $json = ConvertTo-Json -InputObject $value -Depth 8 -Compress
  [Console]::Out.Write($json)
  [Console]::Out.Flush()
}

# JSON string literal; OCR text only needs quotes, backslashes and controls.
function Escape-Json([string]$text) {
  $escaped = $text.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return '"' + $escaped + '"'
}

function Fail([string]$message) {
  [Console]::Error.Write($message)
  exit 1
}

function Window-Info($hwnd) {
  if (-not [DshScreen]::IsWindowVisible($hwnd)) { return $null }
  if ([DshScreen]::Cloaked($hwnd)) { return $null }
  $rect = New-Object DshScreen+RECT
  if (-not [DshScreen]::GetWindowRect($hwnd, [ref]$rect)) { return $null }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { return $null }
  $pidValue = [uint32]0
  [void][DshScreen]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
  [pscustomobject]@{
    handle = $hwnd
    pid = [int]$pidValue
    title = [DshScreen]::Title($hwnd)
    minimized = [DshScreen]::IsIconic($hwnd)
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
  }
}

function List-Windows {
  $rows = @()
  foreach ($hwnd in [DshScreen]::TopLevelWindows()) {
    $info = Window-Info $hwnd
    if (-not $info) { continue }
    if ($info.title.Length -eq 0) { continue }
    # Taskbar-less tool windows, shadows and 1px helpers are not app windows.
    if ($info.width -lt 200 -or $info.height -lt 150) { continue }
    $rows += [pscustomobject]@{
      pid = $info.pid
      windowNumber = [int64]$hwnd.ToInt64()
      owner = [DshScreen]::ProcessName([uint32]$info.pid)
      title = $info.title
      x = $info.x
      y = $info.y
      width = $info.width
      height = $info.height
      onScreen = (-not $info.minimized)
    }
  }
  ,@($rows | Sort-Object -Property @{ Expression = { $_.width * $_.height }; Descending = $true })
}

function Choose-Window([int]$processId, [int64]$explicit) {
  $best = $null
  foreach ($hwnd in [DshScreen]::TopLevelWindows()) {
    if ($explicit -ne 0 -and $hwnd.ToInt64() -ne $explicit) { continue }
    $info = Window-Info $hwnd
    if (-not $info) { continue }
    if ($info.pid -ne $processId) { continue }
    if ($explicit -eq 0 -and $info.title.Length -eq 0) { continue }
    $area = $info.width * $info.height
    if (-not $best) { $best = $info; continue }
    $better = ($best.minimized -and -not $info.minimized) -or
      ($best.minimized -eq $info.minimized -and $area -gt ($best.width * $best.height))
    if ($better) { $best = $info }
  }
  return $best
}

# Windows runs a dozen helper processes all called Feishu.exe, so a pid list
# cannot tell which one owns the chat window. The window is the only reliable
# handle, and picking it directly saves a second process launch per read.
function Choose-FeishuWindow {
  $best = $null
  foreach ($hwnd in [DshScreen]::TopLevelWindows()) {
    $info = Window-Info $hwnd
    if (-not $info) { continue }
    if ($info.title.Length -eq 0) { continue }
    if ($info.width -lt 400 -or $info.height -lt 300) { continue }
    $owner = [DshScreen]::ProcessName([uint32]$info.pid)
    if ($owner -notmatch '^(Feishu|Lark|LarkInternational|MiWorkSaaS|saxmsa667)$') { continue }
    if ($owner -match 'Helper|Crashpad|Renderer|GPU|Plugin|Updater') { continue }
    $area = $info.width * $info.height
    if (-not $best) { $best = $info; continue }
    $better = ($best.minimized -and -not $info.minimized) -or
      ($best.minimized -eq $info.minimized -and $area -gt ($best.width * $best.height))
    if ($better) { $best = $info }
  }
  return $best
}

function Capture-Bitmap($info, [double]$scale) {
  $width = [int]($info.width * $scale)
  $height = [int]($info.height * $scale)
  $target = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($target)

  $source = New-Object System.Drawing.Bitmap $info.width, $info.height
  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source)
  $hdc = $sourceGraphics.GetHdc()
  $printed = [DshScreen]::PrintWindow($info.handle, $hdc, 2)  # PW_RENDERFULLCONTENT
  $sourceGraphics.ReleaseHdc($hdc)
  $sourceGraphics.Dispose()

  # A window that refuses PrintWindow comes back as one flat colour; copying the
  # on-screen rectangle is the only way to read it, and only works when visible.
  # Sample a coarse grid (bounded count): GetPixel is a slow GDI+ call and this
  # only has to answer "is anything drawn here".
  $sampled = 0
  $colored = 0
  $stepX = [Math]::Max(17, [int]($info.width / 24))
  $stepY = [Math]::Max(17, [int]($info.height / 16))
  for ($y = 8; $y -lt $info.height; $y += $stepY) {
    for ($x = 8; $x -lt $info.width; $x += $stepX) {
      $pixel = $source.GetPixel($x, $y)
      $sampled++
      if (($pixel.R + $pixel.G + $pixel.B) -gt 30) { $colored++ }
    }
  }
  if ($printed -and $colored -gt ($sampled / 50)) {
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($source, 0, 0, $width, $height)
  } else {
    $graphics.Dispose()
    $target.Dispose()
    $source.Dispose()
    $width = $info.width
    $height = $info.height
    $target = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($target)
    $graphics.CopyFromScreen($info.x, $info.y, 0, 0, (New-Object System.Drawing.Size $width, $height))
  }
  $source.Dispose()
  $graphics.Dispose()
  return $target
}

function Ocr-Bitmap($bitmap) {
  $path = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-work-ocr-" + [guid]::NewGuid().ToString('N') + ".png")
  try {
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
      foreach ($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        if ($engine) { break }
      }
    }
    if (-not $engine) { throw 'no OCR language pack is installed' }
    return Await ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Capture($info, [bool]$feishu) {
  if (-not $info) { Fail 'no window found' }
  if ($info.minimized) { Fail 'the window is minimized' }

  $scale = 2.0
  $bitmap = Capture-Bitmap $info $scale
  try {
    $result = Ocr-Bitmap $bitmap
    $width = $bitmap.Width
    $height = $bitmap.Height
    $invariant = [System.Globalization.CultureInfo]::InvariantCulture
    # Hand-built JSON: ConvertTo-Json over 80 objects with four numbers each is
    # several times slower than appending strings, and this runs per read.
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('{"pid":').Append($info.pid)
    [void]$builder.Append(',"windowNumber":').Append($info.handle.ToInt64())
    [void]$builder.Append(',"onScreen":').Append($(if ($info.minimized) { 'false' } else { 'true' }))
    [void]$builder.Append(',"bounds":{"x":').Append($info.x).Append(',"y":').Append($info.y)
    [void]$builder.Append(',"width":').Append($info.width).Append(',"height":').Append($info.height).Append('}')
    [void]$builder.Append(',"imageWidth":').Append($info.width).Append(',"imageHeight":').Append($info.height)
    if ($feishu) {
      $front = ([DshScreen]::GetForegroundWindow() -eq $info.handle)
      [void]$builder.Append(',"frontmost":').Append($(if ($front) { 'true' } else { 'false' }))
    }
    [void]$builder.Append(',"lines":[')
    $first = $true
    foreach ($line in $result.Lines) {
      $words = $line.Words
      if ($words.Count -eq 0) { continue }
      $x1 = [double]::MaxValue; $y1 = [double]::MaxValue
      $x2 = [double]::MinValue; $y2 = [double]::MinValue
      foreach ($word in $words) {
        $rect = $word.BoundingRect
        if ($rect.X -lt $x1) { $x1 = $rect.X }
        if ($rect.Y -lt $y1) { $y1 = $rect.Y }
        if (($rect.X + $rect.Width) -gt $x2) { $x2 = $rect.X + $rect.Width }
        if (($rect.Y + $rect.Height) -gt $y2) { $y2 = $rect.Y + $rect.Height }
      }
      if (-not $first) { [void]$builder.Append(',') }
      $first = $false
      [void]$builder.Append('{"text":').Append((Escape-Json $line.Text))
      [void]$builder.Append(',"x":').Append((($x1 / $width).ToString('0.####', $invariant)))
      [void]$builder.Append(',"y":').Append((($y1 / $height).ToString('0.####', $invariant)))
      [void]$builder.Append(',"w":').Append(((($x2 - $x1) / $width).ToString('0.####', $invariant)))
      [void]$builder.Append(',"h":').Append(((($y2 - $y1) / $height).ToString('0.####', $invariant)))
      [void]$builder.Append('}')
    }
    [void]$builder.Append(']}')
    Emit $builder.ToString()
  } finally {
    $bitmap.Dispose()
  }
}

switch ($mode) {
  '--list' { Emit (List-Windows) }
  '--frontmost' {
    $hwnd = [DshScreen]::GetForegroundWindow()
    $pidValue = [uint32]0
    if ($hwnd -ne [IntPtr]::Zero) { [void][DshScreen]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) }
    $name = ''
    if ($pidValue -ne 0) { $name = [DshScreen]::ProcessName($pidValue) }
    Emit ([pscustomobject]@{ pid = [int]$pidValue; name = $name; bundleId = '' })
  }
  '--feishu' { Invoke-Capture (Choose-FeishuWindow) $true }
  default {
    $processId = 0
    if (-not [int]::TryParse($args[0], [ref]$processId)) { Fail "unknown argument: $($args[0])" }
    $explicit = [int64]0
    if ($args.Count -ge 2) { [void][int64]::TryParse($args[1], [ref]$explicit) }
    Invoke-Capture (Choose-Window $processId $explicit) $false
  }
}
