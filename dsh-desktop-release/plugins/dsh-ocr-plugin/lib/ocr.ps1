# dsh-ocr - WinRT OCR helper (Windows 10+ built-in OCR engine).
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -ImagePath <path> [-Lang <tag>] -OutFile <path>
# Writes recognized text to OutFile as UTF-8. Exits non-zero on failure.
# NOTE: keep this file ASCII-only so Windows PowerShell 5.1 parses it safely.

param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$Lang = "zh-Hans-CN",
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = "Stop"

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  # Reflection-based AsTask so WinRT async ops can be awaited synchronously.
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = $null
    if ($Lang) {
      $langObj = New-Object Windows.Globalization.Language($Lang)
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
    }
    if ($null -eq $engine) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
      throw "No OCR engine available for language: $Lang"
    }
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = [string]$result.Text
    [System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ("OK " + $result.Lines.Count + " lines")
  } finally {
    $stream.Dispose()
  }
} catch {
  $msg = $_.Exception.Message
  try { [System.IO.File]::WriteAllText($OutFile, "", (New-Object System.Text.UTF8Encoding($false))) } catch {}
  Write-Error "OCR_FAILED: $msg"
  exit 1
}
