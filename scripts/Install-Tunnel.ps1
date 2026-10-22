param([string]$Version = 'latest')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$installDir = Join-Path $projectRoot 'tools'
New-Item -ItemType Directory -Force $installDir | Out-Null
$releaseUrl = if ($Version -eq 'latest') { 'https://api.github.com/repos/openai/tunnel-client/releases/latest' } else { "https://api.github.com/repos/openai/tunnel-client/releases/tags/$Version" }
$release = Invoke-RestMethod -Uri $releaseUrl
$architecture = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$archiveName = "tunnel-client-$($release.tag_name)-windows-$architecture.zip"
$asset = $release.assets | Where-Object name -eq $archiveName
$checksums = $release.assets | Where-Object name -eq 'SHA256SUMS.txt'
if (!$asset -or !$checksums) { throw 'Official Windows release or checksum file unavailable.' }
$archive = Join-Path $installDir $archiveName
$sums = Join-Path $installDir 'SHA256SUMS.txt'
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
Invoke-WebRequest -Uri $checksums.browser_download_url -OutFile $sums
$entry = Get-Content -LiteralPath $sums | Where-Object { $_ -match ('\s+\*?' + [regex]::Escape($archiveName) + '$') }
if (@($entry).Count -ne 1) { throw 'Missing or duplicate checksum entry.' }
$expectedHash = ($entry -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'SHA256 mismatch. Archive not extracted.' }
$extractDir = Join-Path $installDir $release.tag_name
Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
$binary = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter tunnel-client.exe | Select-Object -First 1
if (!$binary) { throw 'tunnel-client.exe missing from archive.' }
Copy-Item -LiteralPath $binary.FullName -Destination (Join-Path $installDir 'tunnel-client.exe') -Force
[pscustomobject]@{ version=$release.tag_name; sha256=$expectedHash; downloadedAt=(Get-Date).ToUniversalTime().ToString('o'); url=$asset.browser_download_url } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installDir 'release.json') -Encoding UTF8
& (Join-Path $installDir 'tunnel-client.exe') --version
Write-Host 'Official binary installed and archive SHA256 checked. This is not Sigstore provenance verification.'
