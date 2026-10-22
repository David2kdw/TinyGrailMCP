$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS or newer from https://nodejs.org/ first.' }
if ([version](& node -p 'process.versions.node') -lt [version]'22.18.0') { throw 'Node.js >=22.18.0 required.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
& npx.cmd playwright install chromium
if ($LASTEXITCODE -ne 0) { throw 'Playwright browser installation failed' }
& "$PSScriptRoot/Install-Tunnel.ps1"
Write-Host 'Run scripts/Start.ps1 to open the local manager.'
