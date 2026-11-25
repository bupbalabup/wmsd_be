$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path $PSScriptRoot -Parent
$frontendRoot = Join-Path (Split-Path $backendRoot -Parent) 'NameUi-latest'
$runtimeRoot = Join-Path $backendRoot '.local/trung-demo'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

if (-not (Get-NetTCPConnection -State Listen -LocalPort 27017 -ErrorAction SilentlyContinue)) {
    $binary = Get-ChildItem (Join-Path $backendRoot '.local/tools') -Recurse -Filter mongod.exe | Select-Object -First 1
    if (-not $binary) { throw 'Local MongoDB binary is missing; see TRUNG_DEMO_LOCAL.md.' }
    $dataPath = Join-Path $backendRoot '.local/trung-mongo/data'
    $logPath = Join-Path $backendRoot '.local/trung-mongo/mongod.log'
    if (-not (Test-Path -LiteralPath $dataPath)) { throw 'Prepared MongoDB data directory is missing.' }
    Start-Process -FilePath $binary.FullName -ArgumentList @('--dbpath', ('"' + $dataPath + '"'), '--logpath', ('"' + $logPath + '"'), '--port', '27017', '--bind_ip', '127.0.0.1', '--replSet', 'rs0', '--wiredTigerCacheSizeGB', '0.5') -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 3333 -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath 'node' -ArgumentList 'scripts/start-trung-demo.mjs' -WorkingDirectory $backendRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'api.log') -RedirectStandardError (Join-Path $runtimeRoot 'api-error.log')
}
$ready = $false
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    try {
        $health = Invoke-WebRequest 'http://127.0.0.1:3333/api/health' -TimeoutSec 2
        if ($health.Headers['X-WMSD-Demo-Database'] -ne 'wmsd_demo_trung_20261112') { throw 'Port 3333 is serving another database. Stop that server before starting this demo.' }
        $ready = $true
        break
    } catch {
        if ($_.Exception.Message -match 'another database') { throw }
        Start-Sleep -Seconds 1
    }
}
if (-not $ready) { throw 'Local API did not start; check .local/trung-demo/api-error.log.' }
if (-not (Get-NetTCPConnection -State Listen -LocalPort 3334 -ErrorAction SilentlyContinue)) {
    $env:VITE_API_URL = '/api'
    $env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:3333'
    $vitePath = Join-Path $frontendRoot 'node_modules/vite/bin/vite.js'
    Start-Process -FilePath 'node' -ArgumentList @(('"' + $vitePath + '"'), '--host', '127.0.0.1') -WorkingDirectory $frontendRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'web.log') -RedirectStandardError (Join-Path $runtimeRoot 'web-error.log')
}
Write-Output 'Local Trung demo: http://127.0.0.1:3334'
Write-Output 'Database: mongodb://127.0.0.1:27017/wmsd_demo_trung_20261112?replicaSet=rs0'
Write-Output 'Use login role presets. Data is preserved; this script does not reseed or reset.'
