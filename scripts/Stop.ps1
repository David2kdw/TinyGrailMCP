$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
& node dist/cli.js stop
if ($LASTEXITCODE -ne 0) { throw 'Stop failed; inspect the local manager.' }
