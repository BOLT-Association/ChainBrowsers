#requires -Version 5.1
<#
.SYNOPSIS
  One command for the cross-wallet spv test: start the chain stack, open the two browsers, run the test.

.DESCRIPTION
    .\e2e.ps1              start whatever is not running, then run tests/cross-wallet/run.mjs
    .\e2e.ps1 -NoTest      start everything and leave it up, without running the test
    .\e2e.ps1 -RestartMetro  the same as the first, with Metro and the app restarted first (needed after a change
                           to the app's code under node_modules, which Metro does not notice while running)
    .\e2e.ps1 -KeepOpen    the same as the first, leaving everything running after a pass
    .\e2e.ps1 -Stop        stop the browsers, Metro and the emulator (add -StackDown to stop the stack too)

  Steps: Docker Desktop -> spv-testnet stack (the submodule, spv-testnet/stack) -> Android emulator
  (AVD xw_spv) -> Hodos browser in spv mode (tests/cross-wallet/start-hodos.ps1) -> Metro on 8089 with
  the spv settings -> the BSV Browser app -> node run.mjs. Ten seconds after a pass everything is
  brought down (browsers, Metro, emulator, stack; the chain data is kept). After a failure, and with
  -NoTest or -KeepOpen, everything is left running. The test's output is in tests/cross-wallet/out/run.log.

  It does not build anything: the Hodos dev build, the app in the emulator and its onboarded wallet
  must exist (docs/cross-wallet-e2e.md).
#>
[CmdletBinding()]
param(
  [switch]$NoTest,
  [switch]$Stop,
  [switch]$StackDown,
  [switch]$KeepOpen,
  [switch]$RestartMetro,
  [string]$Avd = 'xw_spv',
  [string]$AndroidHome = 'C:\Android',
  [string]$JavaHome = 'C:\Program Files\Java\jdk-17',
  [int]$MetroPort = 8089
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stack = "$root\spv-testnet\stack\stack.ps1"
$xw = "$root\tests\cross-wallet"
$out = "$xw\out"
$app = "$root\browsers\bsv-browser"
$adb = "$AndroidHome\platform-tools\adb.exe"
$package = 'org.bsvassociation.browser'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
# Native commands through cmd: Windows PowerShell 5.1 turns their stderr into errors when redirected.
function Quiet($cmdline) { cmd /c "$cmdline >nul 2>&1"; $LASTEXITCODE -eq 0 }
function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Wait-For($what, [scriptblock]$test, [int]$timeoutSec = 180, [int]$everySec = 2) {
  $end = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $end) { if (& $test) { return }; Start-Sleep -Seconds $everySec }
  throw "timed out after $timeoutSec s waiting for $what"
}
function Adb { $ErrorActionPreference = 'Continue'; & $adb @args }
# The serial of the running emulator that is the test's AVD. Another emulator (e.g. the user's own
# bsv_pixel) may be running too, so the AVD is asked for its name and everything is addressed by serial.
function Get-Serial {
  if (-not (Test-Path $adb)) { return $null }
  foreach ($line in (Adb devices)) {
    if ($line -match '^(emulator-\d+)\s+device') {
      $serial = $Matches[1]
      if (((Adb -s $serial emu avd name) | Select-Object -First 1).Trim() -eq $Avd) { return $serial }
    }
  }
}
# A slow start (cold emulator, first bundle) can make Android show "<app> isn't responding", which
# covers the app until someone answers it. Answer "Wait". Returns whether the dialog was there.
function Dismiss-NotResponding($serial) {
  if (-not (((Adb -s $serial shell dumpsys window) | Out-String) -match 'mCurrentFocus=.*Application Not Responding')) { return $false }
  $ui = (Adb -s $serial exec-out uiautomator dump /dev/tty) | Out-String
  if ($ui -match 'text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') {
    Adb -s $serial shell input tap ([int](([int]$Matches[1] + [int]$Matches[3]) / 2)) ([int](([int]$Matches[2] + [int]$Matches[4]) / 2)) | Out-Null
  }
  Write-Host 'answered "Wait" to an app-not-responding dialog' -ForegroundColor Yellow
  return $true
}
function Get-Metro {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*expo*start*' -and $_.CommandLine -like "*--port $MetroPort*" }
}
function Invoke-HodosScript { powershell -NoProfile -ExecutionPolicy Bypass -File "$xw\start-hodos.ps1" @args; if ($LASTEXITCODE -ne 0) { throw 'start-hodos.ps1 failed' } }

# Put the two browsers beside each other on the primary screen: the emulator at the right edge, as
# tall as the screen allows, and the Hodos window (restored if it was maximised) in the rest.
function Set-SideBySide {
  Add-Type -AssemblyName System.Windows.Forms
  if (-not ('XwWin' -as [type])) {
    Add-Type -Namespace '' -Name XwWin -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@
  }
  $hodosExe = "$root\browsers\Hodos-Browser\cef-native\build\bin\Release\HodosBrowser.exe"
  $hodos = Get-Process HodosBrowser -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $hodosExe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  $emu = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "Android Emulator*$Avd*" } | Select-Object -First 1
  if (-not $hodos -or -not $emu) { Write-Host 'windows not arranged (Hodos or emulator window not found)' -ForegroundColor Yellow; return }
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $SW_RESTORE = 9
  [XwWin]::ShowWindow($emu.MainWindowHandle, $SW_RESTORE) | Out-Null
  $r = New-Object XwWin+RECT
  [XwWin]::GetWindowRect($emu.MainWindowHandle, [ref]$r) | Out-Null
  # Keep the emulator's proportions (a phone screen plus its toolbar) and fit its height to the screen.
  $h = $area.Height
  $w = [int](($r.R - $r.L) * $h / ($r.B - $r.T))
  [XwWin]::MoveWindow($emu.MainWindowHandle, $area.Right - $w, $area.Top, $w, $h, $true) | Out-Null
  [XwWin]::GetWindowRect($emu.MainWindowHandle, [ref]$r) | Out-Null   # the emulator may settle on its own size
  [XwWin]::MoveWindow($emu.MainWindowHandle, $area.Right - ($r.R - $r.L), $area.Top, $r.R - $r.L, $r.B - $r.T, $true) | Out-Null
  [XwWin]::ShowWindow($hodos.MainWindowHandle, $SW_RESTORE) | Out-Null
  [XwWin]::MoveWindow($hodos.MainWindowHandle, $area.Left, $area.Top, $area.Width - ($r.R - $r.L), $area.Height, $true) | Out-Null
  [XwWin]::SetForegroundWindow($emu.MainWindowHandle) | Out-Null
  [XwWin]::SetForegroundWindow($hodos.MainWindowHandle) | Out-Null
  'Hodos on the left, the emulator on the right'
}

function Stop-All([bool]$withStack) {
  Step 'Stopping the browsers'
  Invoke-HodosScript -Stop
  Get-Metro | ForEach-Object { "stopping Metro $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $serial = Get-Serial
  if ($serial) { "stopping emulator $serial ($Avd)"; Adb -s $serial emu kill | Out-Null }
  if ($withStack) { Step 'Stopping the stack (chain data is kept)'; & $stack down }
}
if ($Stop) { Stop-All $StackDown; return }

# ---- prerequisites: fail before starting anything
if (-not (Test-Path $stack)) { throw 'spv-testnet submodule is empty: git submodule update --init' }
if (-not (Test-Path $adb)) { throw "no adb at $adb (pass -AndroidHome)" }
if (-not (Test-Path "$app\node_modules")) { throw "browsers\bsv-browser is not set up (docs/cross-wallet-e2e.md)" }
if (-not (& "$AndroidHome\emulator\emulator.exe" -list-avds | Where-Object { $_.Trim() -eq $Avd })) { throw "no Android emulator named $Avd" }
New-Item -ItemType Directory -Force $out | Out-Null

# ---- 1. Docker
Step 'Docker'
if (-not (Quiet 'docker info')) {
  $desktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (-not (Test-Path $desktop)) { throw 'Docker is not running and Docker Desktop was not found' }
  'starting Docker Desktop'
  Start-Process $desktop
  Wait-For 'Docker' { Quiet 'docker info' } 300 3
}
'Docker is running'

# ---- 2. The chain stack, from the submodule
Step 'spv-testnet stack'
# Teranode's chain is in spv-testnet/stack/data, the rest (Arcade, chaintracks, postgres) in Docker
# volumes that belong to the compose project, wherever it is run from. Volumes left by a run from
# another clone of spv-testnet, next to an empty data directory here, would be two different chains.
$volumes = cmd /c 'docker volume ls -q 2>nul'
if (-not (Test-Path "$root\spv-testnet\stack\data") -and ($volumes -contains 'chainbrowsers_chaintracks-data')) {
  throw @"
spv-testnet\stack\data does not exist, but Docker holds the stack's volumes from another clone of spv-testnet.
Starting here would give Teranode a new chain and Arcade the old one. Either
  - copy that clone's stack\data directory to $root\spv-testnet\stack\data (keeps the chain and the wallets' history), or
  - run  spv-testnet\stack\stack.ps1 reset  for a new chain; the test wallets then hold headers of the old chain
    and must be recreated (delete tests\cross-wallet\out\hodos, clear the app's data in the emulator and onboard again).
"@
}
& $stack up
$rpc = @{ Uri = 'http://localhost:29292'; Method = 'Post'; ContentType = 'application/json'
  Headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('bitcoin:bitcoin')) } }
$nodeHeight = { (Invoke-RestMethod @rpc -Body '{"method":"getinfo","params":[]}').result.blocks }
Wait-For 'Teranode RPC' { try { [bool](& $nodeHeight) } catch { $false } } 180
# A new chain is too short to fund from: the test spends a coinbase 100 to 160 blocks below the tip.
$minHeight = 165
# getinfo's height lags behind `generate`, so the number to mine is worked out once.
$h = & $nodeHeight
if ($h -lt $minHeight) {
  "new chain at block $h, mining to $minHeight"
  for ($left = $minHeight - $h; $left -gt 0; $left -= 20) {
    Invoke-RestMethod @rpc -TimeoutSec 200 -Body "{`"method`":`"generate`",`"params`":[$([Math]::Min(20, $left))]}" | Out-Null
  }
  Wait-For "Teranode to report block $minHeight" { (& $nodeHeight) -ge $minHeight } 120
}
# Chaintracks learns headers only from block announcements; the block generator makes one every few seconds.
$target = & $nodeHeight
Wait-For "chaintracks to reach block $target" {
  try { ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://localhost:8083/chaintracks/v2/height').Content -match '(\d+)') -and ([int]$Matches[1] -ge $target) } catch { $false }
} 180
Wait-For 'Arcade' { try { [bool](Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://localhost:8081/health') } catch { $false } } 120
"stack is up at block $target"

# ---- 3. Android emulator (started now, it boots while Hodos starts)
Step "Android emulator ($Avd)"
$env:ANDROID_HOME = $AndroidHome
$env:ANDROID_SDK_ROOT = $AndroidHome
if (Test-Path $JavaHome) { $env:JAVA_HOME = $JavaHome }
Adb start-server | Out-Null
if (Get-Serial) { 'already running' } else { Start-Process "$AndroidHome\emulator\emulator.exe" -ArgumentList '-avd', $Avd; 'starting' }

# ---- 4. Hodos browser (its own process: the script points APPDATA at the scratch directory)
Step 'Hodos browser (spv mode)'
Invoke-HodosScript

# ---- 5. BSV Browser in the emulator
Step 'BSV Browser (spv mode)'
Wait-For 'the emulator' { [bool](Get-Serial) } 240 3
$serial = Get-Serial
Wait-For 'Android to finish booting' { ((Adb -s $serial shell getprop sys.boot_completed) | Out-String).Trim() -eq '1' } 300 3
if (-not ((Adb -s $serial shell pm list packages $package) | Out-String).Contains($package)) {
  throw "the app is not installed in $Avd (build and onboarding: docs/cross-wallet-e2e.md)"
}
if ($RestartMetro) {
  Get-Metro | ForEach-Object { "stopping Metro $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Adb -s $serial shell am force-stop $package | Out-Null
  Wait-For 'Metro to stop' { -not (Listening $MetroPort) } 30 1
}
if (-not (Listening $MetroPort)) {
  # The spv settings reach the app through Metro's environment (a .env.local would also be loaded by jest).
  $spv = @{
    CI = '1'
    EXPO_PUBLIC_CHAIN_MODE = 'spv'
    EXPO_PUBLIC_SPV_RULES = 'regtest'
    EXPO_PUBLIC_SPV_ANCHOR_HEIGHT = '0'
    EXPO_PUBLIC_SPV_ANCHOR_HASH = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
    EXPO_PUBLIC_SPV_SSE_URL = 'http://10.0.2.2:8082'
    EXPO_PUBLIC_ARC_URL = 'http://10.0.2.2:8080'
    EXPO_PUBLIC_CHAINTRACKS_URL = 'http://10.0.2.2:8083/chaintracks/v1'
    EXPO_PUBLIC_TERATEST_ARC_URL = 'http://10.0.2.2:8080'
    EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL = 'http://10.0.2.2:8083/chaintracks/v1'
  }
  $saved = @{}
  foreach ($k in $spv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $spv[$k]) }
  Start-Process cmd.exe -ArgumentList '/c', "npx expo start --dev-client --port $MetroPort > `"$out\metro.log`" 2>&1" -WorkingDirectory $app -WindowStyle Hidden
  foreach ($k in $spv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  Wait-For "Metro on $MetroPort" { Listening $MetroPort } 180
  'Metro started'
}
# Open the dev client on Metro's bundle, and wait for the app to have drawn its own screen.
Adb -s $serial shell am start -a android.intent.action.VIEW -d "bsv-browser://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A$MetroPort" $package | Out-Null
Wait-For 'the app to load its bundle' {
  if (Dismiss-NotResponding $serial) { return $false }
  $ui =(Adb -s $serial exec-out uiautomator dump /dev/tty) | Out-String
  $ui.Contains("package=`"$package`"") -and -not ($ui -match 'Development servers|Loading from|Bundling')
} 300 3
'the app is open'
Set-SideBySide

if ($NoTest) { "`nEverything is up. Run the test with: cd tests\cross-wallet; node run.mjs"; return }

# ---- 6. The test
Step 'Cross-wallet test'
if (-not (Test-Path "$root\tests\hodos-spv\node_modules")) { Push-Location "$root\tests\hodos-spv"; try { cmd /c 'npm install' } finally { Pop-Location } }
$env:ANDROID_SERIAL = $serial   # run.mjs's adb calls go to this emulator only
$env:ADB = $adb
Push-Location $xw
try {
  $log = New-Object System.IO.StreamWriter("$out\run.log", $false)   # UTF-8; Tee-Object would write UTF-16
  try { cmd /c "node run.mjs 2>&1" | ForEach-Object { $log.WriteLine($_); $_ } } finally { $log.Close() }
  $code = $LASTEXITCODE
} finally { Pop-Location }
if ($code -ne 0) { Write-Host "`nFAIL, exit $code (log: $out\run.log). Everything is left running to be looked at; stop it with .\e2e.ps1 -Stop -StackDown" -ForegroundColor Red }
elseif ($KeepOpen) { Write-Host "`nPASS (log: $out\run.log). Everything is left running; stop it with .\e2e.ps1 -Stop -StackDown" -ForegroundColor Green }
else {
  Write-Host "`nPASS (log: $out\run.log). Bringing everything down in 10 seconds (-KeepOpen leaves it running)" -ForegroundColor Green
  Start-Sleep -Seconds 10
  Stop-All $true
}
exit $code
