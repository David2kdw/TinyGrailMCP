param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
Set-Location $projectRoot
if (!(Test-Path -LiteralPath "$projectRoot/dist/main.js")) { throw 'Run scripts/Install.ps1 first.' }
$dataPath = if ($env:TG_DATA_DIR) { $env:TG_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'TinyGrailMCP' }
$runtimePath = Join-Path $dataPath 'runtime.json'
function Get-RunningManager {
  try {
    $candidate = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
    $uri = [Uri]($candidate.origin + '/health')
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { return $null }
    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 1000
    $request.ReadWriteTimeout = 1000
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $health = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      if ($health.application -eq 'TinyGrailMCP' -and $health.instance -eq $candidate.instance) { return $candidate }
    } finally { $response.Dispose() }
  } catch {}
  return $null
}
$runtime = Get-RunningManager
if (!$runtime) {
  New-Item -ItemType Directory -Force $dataPath | Out-Null
  $nodePath = (Get-Command node).Source
  $diagnosticPath = Join-Path $dataPath 'manager-startup-error.json'
  $launchedAt = [DateTime]::UtcNow
  $managerProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + (Join-Path $projectRoot 'dist/main.js') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  $startupWait = [System.Diagnostics.Stopwatch]::StartNew()
  while ($startupWait.Elapsed.TotalSeconds -lt 60) {
    Start-Sleep -Milliseconds 200
    $runtime = Get-RunningManager
    if ($runtime) { break }
    $managerProcess.Refresh()
    if ($managerProcess.HasExited) {
      $failureCode = 'START_FAILED'
      try {
        $entry = Get-Content -Raw -LiteralPath $diagnosticPath | ConvertFrom-Json
        if ($entry.pid -eq $managerProcess.Id -and [DateTime]::Parse($entry.time).ToUniversalTime() -ge $launchedAt -and $entry.code -match '^[A-Z0-9_]+$') { $failureCode = $entry.code }
      } catch {}
      throw "Manager exited before startup completed ($failureCode). Diagnostic file: $diagnosticPath"
    }
  }
  if (!$runtime) { throw "Manager startup health check timed out after 60 seconds. Run node dist/main.js for diagnostics." }
}
if (!$NoBrowser) { Start-Process ($runtime.origin + '/#' + $runtime.bootstrap) }
Write-Host ('TinyGrailMCP manager is running at ' + $runtime.origin + '. Use Start.ps1 again to reopen it.')
