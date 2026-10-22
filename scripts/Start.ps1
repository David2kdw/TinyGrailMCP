param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
Set-Location $projectRoot
if (!(Test-Path -LiteralPath "$projectRoot/dist/main.js")) { throw 'Run scripts/Install.ps1 first.' }
$dataPath = if ($env:TG_DATA_DIR) { $env:TG_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'TinyGrailMCP' }
$runtimePath = Join-Path $dataPath 'runtime.json'
$running = $false
if (Test-Path -LiteralPath $runtimePath) {
  try { $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json; $health=Invoke-RestMethod -Uri ($runtime.origin + '/health') -TimeoutSec 2; $running = $health.application -eq 'TinyGrailMCP' -and $health.instance -eq $runtime.instance } catch {}
}
if (!$running) {
  New-Item -ItemType Directory -Force $dataPath | Out-Null
  $nodePath = (Get-Command node).Source
  Start-Process -FilePath $nodePath -ArgumentList @('"' + (Join-Path $projectRoot 'dist/main.js') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden
  for ($attempt=0; $attempt -lt 100; $attempt++) {
    Start-Sleep -Milliseconds 200
    try { $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json; if ((Invoke-RestMethod -Uri ($runtime.origin + '/health') -TimeoutSec 1).instance -eq $runtime.instance) { $running=$true; break } } catch {}
  }
}
if (!$running) { throw 'Manager failed to start. Run node dist/main.js in a terminal for diagnostics.' }
if (!$NoBrowser) { Start-Process ($runtime.origin + '/#' + $runtime.bootstrap) }
Write-Host ('TinyGrailMCP manager is running at ' + $runtime.origin + '. Use Start.ps1 again to reopen it.')
