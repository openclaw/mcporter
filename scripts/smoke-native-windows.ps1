$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $env:RUNNER_TEMP 'native-windows-x64'
$smoke = Join-Path $env:RUNNER_TEMP 'smoke-windows-x64'
New-Item -ItemType Directory -Force $stage, $smoke | Out-Null
Set-Location $root
$version = (Get-Content package.json | ConvertFrom-Json).version
$binary = Join-Path $stage 'mcporter.exe'
pnpm build:bun --target bun-windows-x64-baseline --output $binary
if ($LASTEXITCODE -ne 0) { throw 'Windows native build failed' }
$archive = Join-Path $env:RUNNER_TEMP 'mcporter-dry-run-windows-x64.zip'
Compress-Archive -Path $binary -DestinationPath $archive -Force
Expand-Archive -Path $archive -DestinationPath $smoke -Force
$binary = Join-Path $smoke 'mcporter.exe'
$env:BUN_BE_BUN = '1'
try {
    $metadata = & $binary --print 'JSON.stringify({bun: process.versions.bun, platform: process.platform, arch: process.arch})'
    if ($LASTEXITCODE -ne 0) { throw 'Embedded runtime probe failed' }
    $runtime = $metadata | ConvertFrom-Json
    if ($runtime.bun -ne '1.4.4' -or $runtime.platform -ne 'win32' -or $runtime.arch -ne 'x64') {
        throw "Unexpected embedded runtime: $metadata"
    }
    Write-Output "Embedded runtime: $metadata"
} finally {
    Remove-Item Env:BUN_BE_BUN
}
Set-Location $smoke
$env:HOME = Join-Path $smoke 'home'
$env:USERPROFILE = $env:HOME
New-Item -ItemType Directory -Force $env:HOME | Out-Null
if ((& $binary --version) -ne $version -or $LASTEXITCODE -ne 0) { throw 'Native version mismatch' }
& $binary --help
if ($LASTEXITCODE -ne 0) { throw 'Native help failed' }
'{"mcpServers":{}}' | Set-Content -Path empty.json
& $binary --config (Join-Path $smoke 'empty.json') list --json
if ($LASTEXITCODE -ne 0) { throw 'Native synthetic config smoke failed' }
