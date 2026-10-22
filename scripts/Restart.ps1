$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/Stop.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Stop failed; replacement was not started.' }
& "$PSScriptRoot/Start.ps1"
