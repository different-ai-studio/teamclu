# Install a released TeamClu Windows installer on a GitHub windows-latest
# runner and check that it would start on a machine that has nothing else
# installed.
#
# Why this exists: the runner image is not a clean machine. It already carries
# the Visual C++ Redistributable and WebView2, so a binary that imports
# VCRUNTIME140.dll runs fine here and dies on a fresh Windows 10 with "由于找不到
# VCRUNTIME140.dll" (#1905: amuxd and teamclu-introspect had done exactly that
# since Windows support landed). This script closes that gap in two ways:
#
#   1. Static: dumpbin every .exe/.dll the installer drops and fail on any
#      import of the VC++ runtime. Deterministic, does not depend on what the
#      runner happens to have installed.
#   2. Dynamic: uninstall the VC++ Redistributables from the runner, then run
#      the sidecars and the desktop app. Best effort on the removal side (other
#      software on the image may keep its own copy in System32); the static
#      check is the gate.
#
# Then, when a test account is configured, windows-agent-smoke.ps1 drives the
# installed daemon through real agent turns (login, onboard, pi install, a
# reply, and a shell command run with Git Bash hidden).
#
# Not covered: WebView2 stays installed (it cannot be removed cleanly from the
# image), and the desktop UI itself is never logged in — the released build has
# no automation bridge and email OTP cannot be scripted.
#
# Usage: windows-install-smoke.ps1 -Installer <path to *-setup.exe> -OutDir <dir>

param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$failures = New-Object System.Collections.Generic.List[string]

function Fail([string]$msg) {
  Write-Host "::error::$msg"
  $script:failures.Add($msg)
}

# STATUS_DLL_NOT_FOUND. What a process exits with when the loader cannot
# resolve an import, before main() runs — the VCRUNTIME140 case.
$STATUS_DLL_NOT_FOUND = -1073741515

# --- 1. Silent install ------------------------------------------------------
# /S skips the installer's GUI hooks (including the Windows version guard),
# which is fine: this runner is a supported OS.
Write-Host "Installing $Installer"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }

# Tauri's NSIS default is a per-user install under %LOCALAPPDATA%\<product>;
# search Program Files too in case installMode changes. Locate by amuxd.exe,
# which every brand ships under the same name.
$amuxd = Get-ChildItem -Path $env:LOCALAPPDATA, $env:ProgramFiles -Filter 'amuxd.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $amuxd) { throw 'Installed amuxd.exe not found under LOCALAPPDATA or Program Files' }
$installDir = $amuxd.DirectoryName
Write-Host "Install dir: $installDir"
Get-ChildItem $installDir -Recurse | Select-Object FullName, Length | Format-Table -AutoSize | Out-String -Width 300 | Write-Host

$introspect = Join-Path $installDir 'teamclu-introspect.exe'
$mainExe = Get-ChildItem $installDir -Filter '*.exe' |
  Where-Object { $_.Name -notmatch '^(amuxd|teamclu-introspect|uninstall)' }
if (@($mainExe).Count -ne 1) {
  throw "Expected exactly one main exe in $installDir, found: $(@($mainExe).Name -join ', ')"
}
$mainExe = @($mainExe)[0].FullName
Write-Host "Main exe: $mainExe"

# --- 2. Static import check -------------------------------------------------
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$dumpbin = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' | Select-Object -First 1
if (-not $dumpbin) { throw 'dumpbin.exe not found via vswhere' }

# The VC++ runtime ships only with the Redistributable, never with Windows.
# (The UCRT api-ms-win-crt-* forwarders are part of Windows 10 itself.)
$forbidden = '^(vcruntime\d+|vcruntime\d+_\d+|msvcp\d+(_\w+)?|concrt\d+|vccorlib\d+|vcomp\d+)d?\.dll$|^ucrtbased\.dll$'

$binaries = Get-ChildItem $installDir -Recurse -Include '*.exe', '*.dll' |
  Where-Object { $_.Name -notmatch '^uninstall' }
foreach ($bin in $binaries) {
  $out = & $dumpbin /nologo /dependents $bin.FullName
  $deps = $out | Where-Object { $_ -match '^\s{4}\S+\.dll\s*$' } | ForEach-Object { $_.Trim() }
  $bad = $deps | Where-Object { $_ -match $forbidden }
  $rel = $bin.FullName.Substring($installDir.Length + 1)
  Write-Host ("{0}: {1}" -f $rel, ($deps -join ', '))
  if ($bad) {
    Fail "$rel imports $($bad -join ', ') — the installer does not ship the VC++ runtime, so this fails on a clean Windows. Link it statically (see #1905)."
  }
}

# --- 3. Strip the VC++ Redistributable from the runner ----------------------
$uninstallKeys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$redists = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'Microsoft Visual C\+\+ .* Redistributable' -and $_.UninstallString }
foreach ($r in $redists) {
  Write-Host "Removing: $($r.DisplayName)"
  # Bundle uninstallers take /uninstall /quiet; MSI entries take /x {GUID} /qn.
  if ($r.UninstallString -match 'MsiExec\.exe\s+/[IX](\{[^}]+\})') {
    Start-Process msiexec.exe -ArgumentList "/x $($Matches[1]) /qn /norestart" -Wait | Out-Null
  } elseif ($r.UninstallString -match '^"?([^"]+\.exe)"?') {
    Start-Process $Matches[1] -ArgumentList '/uninstall /quiet /norestart' -Wait | Out-Null
  }
}
$leftover = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') |
  Where-Object { Test-Path (Join-Path $env:SystemRoot "System32\$_") }
if ($leftover) {
  Write-Host "::warning::Still in System32 after removing the redistributables (kept by other software on the image): $($leftover -join ', '). The dynamic checks below cannot prove a clean-machine start; the static import check above is what gates."
} else {
  Write-Host 'VC++ runtime is gone from System32; the dynamic checks below run as on a clean machine.'
}

# --- 4. Sidecars start ------------------------------------------------------
foreach ($exe in @($amuxd.FullName, $introspect)) {
  $name = Split-Path $exe -Leaf
  if (-not (Test-Path $exe)) { Fail "$name missing from the install dir"; continue }
  $log = Join-Path $OutDir "$name.version.txt"
  $p = Start-Process -FilePath $exe -ArgumentList '--version' -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $text = (Get-Content $log -Raw -ErrorAction SilentlyContinue)
  if ($p.ExitCode -eq $STATUS_DLL_NOT_FOUND) {
    Fail "$name --version: the loader could not find a DLL it imports (0xC0000135)"
  } elseif ($p.ExitCode -ne 0 -or -not $text) {
    Fail "$name --version exited $($p.ExitCode) with output: $text $(Get-Content "$log.err" -Raw -ErrorAction SilentlyContinue)"
  } else {
    Write-Host "$name --version -> $($text.Trim())"
  }
}

# --- 5. Desktop app stays up ------------------------------------------------
$app = Start-Process -FilePath $mainExe -PassThru
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline -and -not $app.HasExited) { Start-Sleep -Seconds 3 }

if ($app.HasExited) {
  if ($app.ExitCode -eq $STATUS_DLL_NOT_FOUND) {
    Fail 'Desktop app could not start: a DLL it imports is missing (0xC0000135)'
  } else {
    Fail "Desktop app exited within 45s with code $($app.ExitCode)"
  }
} else {
  Write-Host "Desktop app still running after 45s (pid $($app.Id))"
  $webview = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue
  if (-not $webview) { Fail 'Desktop app is running but no WebView2 process started — the window never got a webview' }

  # Best effort: hosted runners have a desktop session, but a capture can come
  # back black. Uploaded as an artifact for a human to glance at.
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $OutDir 'desktop.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } catch { Write-Host "Screenshot skipped: $_" }

  & taskkill /F /T /PID $app.Id | Out-Null
}
& taskkill /F /T /IM amuxd.exe 2>$null | Out-Null
& taskkill /F /T /IM teamclu-introspect.exe 2>$null | Out-Null
Start-Sleep -Seconds 2

# --- 6. One real agent turn through the installed daemon --------------------
# Needs a test account; skipped (with a warning) when the secrets are absent,
# e.g. on a fork. Runs after the VC++ runtime was removed, so the daemon is
# exercised the way a clean machine would run it.
if ($env:SMOKE_EMAIL -and $env:SMOKE_PASSWORD) {
  & (Join-Path $PSScriptRoot 'windows-agent-smoke.ps1') -Amuxd $amuxd.FullName -OutDir (Join-Path $OutDir 'agent')
  if ($LASTEXITCODE -ne 0) { Fail 'Agent turn through the installed daemon failed (see the step log above)' }
} else {
  Write-Host '::warning::SMOKE_EMAIL / SMOKE_PASSWORD not set; skipping the login + message check.'
}

# --- 7. Silent uninstall removes the sidecars -------------------------------
# The NSIS uninstaller re-launches itself from %TEMP% and returns at once, so
# poll for the result instead of trusting -Wait.
$uninst = Join-Path $installDir 'uninstall.exe'
if (Test-Path $uninst) {
  Start-Process -FilePath $uninst -ArgumentList '/S' -Wait | Out-Null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and (Test-Path $amuxd.FullName)) { Start-Sleep -Seconds 2 }
  if (Test-Path $amuxd.FullName) { Fail 'amuxd.exe is still in the install dir 60s after a silent uninstall' }
  else { Write-Host 'Uninstall removed the sidecars' }
} else {
  Fail "uninstall.exe not found in $installDir"
}

if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) check(s) failed:"
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host "`nAll Windows install smoke checks passed."
