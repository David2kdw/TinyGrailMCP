param([switch]$RemovePrivateData)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/Stop.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Stop failed. Private data preserved.' }
if ($RemovePrivateData) {
  $target = [IO.Path]::GetFullPath($(if ($env:TG_DATA_DIR) { $env:TG_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'TinyGrailMCP' }))
  $standard = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'TinyGrailMCP'))
  if ($target -ne $standard) { throw 'Custom data directory: remove it manually after checking the path.' }
  if ((Split-Path $target -Leaf) -ne 'TinyGrailMCP') { throw 'Unexpected target. Nothing deleted.' }
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Stopped. The repository and browser runtime remain; delete them manually if no longer needed.'
