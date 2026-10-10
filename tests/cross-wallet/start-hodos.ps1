# Starts the Hodos browser in spv mode for the cross-wallet test: the wallet first (so the
# browser adopts it instead of launching its own), then the frontend dev server, then the browser.
# Everything Hodos writes goes under -Scratch: the wallet's data (HODOS_DATA_DIR) and the
# browser's profile (APPDATA), so the real HodosBrowserDev data is never opened.
#
#   .\start-hodos.ps1                 start (creates the scratch wallet on first run)
#   .\start-hodos.ps1 -Stop           stop only this clone's browser, wallet and dev server
param(
  [string]$Scratch = "$PSScriptRoot\out\hodos",
  [string]$Arcade = 'http://localhost:8080',
  [string]$Chaintracks = 'http://localhost:8083/chaintracks/v2',
  [string]$ArcadeSse = 'http://localhost:8082',
  # Extra switches for the browser (Chromium's), e.g. to map a test hostname to this machine.
  [string[]]$BrowserArgs = @(),
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$hodos = (Resolve-Path "$PSScriptRoot\..\..\browsers\Hodos-Browser").Path
$walletExe = "$hodos\rust-wallet\target\debug\hodos-wallet.exe"
$browserExe = "$hodos\cef-native\build\bin\Release\HodosBrowser.exe"

# Only this clone's processes, matched by path: the installed Hodos uses the same image names.
function Get-Mine {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -eq $walletExe) -or ($_.ExecutablePath -eq $browserExe) -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$hodos\frontend*vite*")
  }
}
if ($Stop) {
  Get-Mine | ForEach-Object { "stopping $($_.Name) $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  return
}

foreach ($f in $walletExe, $browserExe) { if (-not (Test-Path $f)) { throw "not built: $f (see docs/cross-wallet-e2e.md)" } }
New-Item -ItemType Directory -Force "$Scratch\wallet-data", "$Scratch\appdata" | Out-Null

$env:HODOS_DEV = '1'
$env:HODOS_DATA_DIR = "$Scratch\wallet-data"
$env:HODOS_CHAIN_MODE = 'spv'
$env:HODOS_ARCADE_URL = $Arcade
$env:HODOS_CHAINTRACKS_URL = $Chaintracks
$env:HODOS_ARCADE_SSE_URL = $ArcadeSse

$listening = { param($port) [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Wait-Port($port, $what) {
  foreach ($i in 1..60) { if (& $listening $port) { return }; Start-Sleep -Milliseconds 500 }
  throw "$what did not start listening on $port"
}

if (-not (& $listening 31401)) {
  Start-Process -FilePath $walletExe -WindowStyle Hidden -RedirectStandardOutput "$Scratch\wallet.out.log" -RedirectStandardError "$Scratch\wallet.err.log"
  Wait-Port 31401 'the wallet'
}
$status = Invoke-RestMethod http://127.0.0.1:31401/wallet/status
if (-not $status.exists) {
  Invoke-RestMethod -Method Post http://127.0.0.1:31401/wallet/create -ContentType 'application/json' -Body '{}' | Out-Null
  'created a scratch wallet'
}

if (-not (& $listening 5137)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' -WorkingDirectory "$hodos\frontend" -WindowStyle Hidden
  Wait-Port 5137 'the frontend dev server'
}

if (-not (& $listening 9322)) {
  $env:APPDATA = "$Scratch\appdata"
  if ($BrowserArgs.Count) { Start-Process -FilePath $browserExe -ArgumentList $BrowserArgs } else { Start-Process -FilePath $browserExe }
  Wait-Port 9322 'the browser (DevTools port)'
}
"Hodos is up in spv mode: wallet 127.0.0.1:31401 (Arcade $Arcade), DevTools 127.0.0.1:9322, data under $Scratch"
