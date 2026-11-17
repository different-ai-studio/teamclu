# Drive the installed amuxd through one real agent turn: a test account logs
# in, mints an agent invite, the daemon onboards with it, installs the pi
# runtime, starts, and must answer a message that mentions it.
#
# This is what a user's first conversation exercises on their machine — the
# daemon's network stack (TLS roots, MQTT, Cloud API), the managed Node + pi
# install, spawning the pi host, and the reply making it back. It does NOT log
# the desktop UI in: the released build has no automation bridge, and email
# OTP cannot be scripted. The account logs in with a password through FC
# (/v1/auth/signin-password), which only test accounts have.
#
# Targets the self-host test environment by default, never production. Each
# run creates one agent actor and one session and deletes both at the end.
#
# Usage: windows-agent-smoke.ps1 -Amuxd <path> -OutDir <dir>
# Env:   SMOKE_EMAIL, SMOKE_PASSWORD   test account (password login enabled)
#        SMOKE_CLOUD_API_URL           default https://api.teamclu-dev.ucar.cc

param(
  [Parameter(Mandatory = $true)][string]$Amuxd,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$api = if ($env:SMOKE_CLOUD_API_URL) { $env:SMOKE_CLOUD_API_URL.TrimEnd('/') } else { 'https://api.teamclu-dev.ucar.cc' }
$runTag = "win-smoke-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$replyTimeoutSec = 300

# Pin the daemon's home instead of guessing it: the default is ~/.amuxd or
# ~/.amuxd-<brand> depending on the build, and the desktop app launched earlier
# in the smoke may already have written an unclaimed state there. Outside
# $OutDir: the pi install puts Node + node_modules under it, which must not
# ride the artifact upload.
$tmpRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$env:AMUXD_HOME = Join-Path $tmpRoot 'amuxd-home'
New-Item -ItemType Directory -Force -Path $env:AMUXD_HOME | Out-Null

function Invoke-Api([string]$Method, [string]$Path, $Body = $null, [hashtable]$Headers = @{}) {
  $h = @{ 'content-type' = 'application/json' } + $Headers
  if ($script:token) { $h['authorization'] = "Bearer $script:token" }
  $req = @{ Method = $Method; Uri = "$api$Path"; Headers = $h }
  if ($null -ne $Body) { $req.Body = ($Body | ConvertTo-Json -Depth 8 -Compress) }
  try { Invoke-RestMethod @req }
  catch {
    $detail = $_.ErrorDetails.Message
    throw "$Method $Path failed: $($_.Exception.Message) $detail"
  }
}

# --- Minimal protobuf, for the daemon's local /v1/rpc ----------------------
# A session created through the Cloud API has no runtime on the daemon, and a
# message alone does not start one ("route_session_message: no runtime for
# session; dropping message"): a client has to send RuntimeStart first, which
# is what the desktop does over this loopback endpoint and iOS does over MQTT.
# The body is a teamclu.RpcRequest (proto/teamclu.proto). Only strings and
# varints are involved, so encode by hand rather than pull in a protobuf
# library.
function PbVarint([UInt64]$v) {
  $out = New-Object System.Collections.Generic.List[byte]
  do {
    $b = [byte]($v -band 0x7F); $v = $v -shr 7
    if ($v -ne 0) { $b = $b -bor 0x80 }
    $out.Add($b)
  } while ($v -ne 0)
  return , $out.ToArray()
}
function PbBytes([int]$field, [byte[]]$bytes) {
  return , ([byte[]]((PbVarint (($field -shl 3) -bor 2)) + (PbVarint $bytes.Length) + $bytes))
}
function PbString([int]$field, [string]$value) { PbBytes $field ([System.Text.Encoding]::UTF8.GetBytes($value)) }
function PbEnum([int]$field, [UInt64]$value) { return , ([byte[]]((PbVarint ($field -shl 3)) + (PbVarint $value))) }

# Flat decode of one message level: field number -> last value (UInt64 for
# varints, byte[] for length-delimited). Enough for RpcResponse.
function PbDecode([byte[]]$buf) {
  $fields = @{}; $i = 0
  while ($i -lt $buf.Length) {
    $key = [UInt64]0; $shift = 0
    do { $b = $buf[$i++]; $key = $key -bor ([UInt64]($b -band 0x7F) -shl $shift); $shift += 7 } while ($b -band 0x80)
    $field = [int]($key -shr 3); $wire = [int]($key -band 7)
    if ($wire -eq 0) {
      $v = [UInt64]0; $shift = 0
      do { $b = $buf[$i++]; $v = $v -bor ([UInt64]($b -band 0x7F) -shl $shift); $shift += 7 } while ($b -band 0x80)
      $fields[$field] = $v
    } elseif ($wire -eq 2) {
      $len = [UInt64]0; $shift = 0
      do { $b = $buf[$i++]; $len = $len -bor ([UInt64]($b -band 0x7F) -shl $shift); $shift += 7 } while ($b -band 0x80)
      $fields[$field] = [byte[]]$buf[$i..($i + [int]$len - 1)]
      if ($len -eq 0) { $fields[$field] = [byte[]]@() }
      $i += [int]$len
    } else { throw "unexpected protobuf wire type $wire in RpcResponse" }
  }
  return $fields
}
function PbText($fields, [int]$field) {
  if ($fields.ContainsKey($field)) { [System.Text.Encoding]::UTF8.GetString($fields[$field]) } else { '' }
}

$AGENT_TYPE_PI = 4

# The daemon's loopback API, with the error body kept in the exception.
function Invoke-Local([string]$Method, [string]$Path, [string]$Bearer, [string]$JsonBody) {
  try {
    Invoke-RestMethod -Method $Method -Uri "http://127.0.0.1:$script:port$Path" `
      -Headers @{ authorization = "Bearer $Bearer" } -ContentType 'application/json' -Body $JsonBody
  } catch {
    throw "local $Method $Path failed: $($_.Exception.Message) $($_.ErrorDetails.Message)"
  }
}

$token = $null
$teamId = $null
$agentId = $null
$sessionId = $null
$daemon = $null
$failed = $null

try {
  # --- Log in and find the account's team ----------------------------------
  $auth = Invoke-Api POST '/v1/auth/signin-password' @{ email = $env:SMOKE_EMAIL; password = $env:SMOKE_PASSWORD }
  $token = $auth.access_token
  $userId = $auth.user.id
  if (-not $token) { throw 'signin-password returned no access_token' }

  $team = Invoke-Api POST '/v1/teams/bootstrap' @{ displayName = 'Windows smoke' }
  $teamId = $team.id
  $member = Invoke-Api GET "/v1/directory/current-member-actor?teamId=$teamId&userId=$userId"
  Write-Host "Logged in; team $teamId, member actor $($member.id)"

  # --- Onboard the installed daemon as a fresh agent -----------------------
  $invite = Invoke-Api POST "/v1/teams/$teamId/invites" @{
    kind = 'agent'; agentKind = 'daemon'; displayName = $runTag; ttlSeconds = 3600
  }
  $inviteUrl = "amux://invite?token=$([uri]::EscapeDataString($invite.token))&cloud_api_url=$([uri]::EscapeDataString($api))"

  $initOut = & $Amuxd init $inviteUrl 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "amuxd init exited $LASTEXITCODE`n$initOut" }
  if ($initOut -notmatch 'actor_id\s*=\s*([0-9a-fA-F-]{36})') { throw "amuxd init printed no actor_id:`n$initOut" }
  $agentId = $Matches[1]
  Write-Host "Daemon onboarded as agent $agentId"

  # Install the managed Node + pi explicitly so a failure here is reported as
  # an install failure, not as a missing reply five minutes later.
  $piOut = & $Amuxd install-pi 2>&1 | Out-String
  $piOut | Set-Content (Join-Path $OutDir 'install-pi.txt')
  if ($LASTEXITCODE -ne 0) { throw "amuxd install-pi exited $LASTEXITCODE`n$piOut" }
  (& $Amuxd doctor 2>&1 | Out-String) | Set-Content (Join-Path $OutDir 'doctor.json')

  $daemon = Start-Process -FilePath $Amuxd -ArgumentList 'start' -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $OutDir 'amuxd.stdout.txt') `
    -RedirectStandardError (Join-Path $OutDir 'amuxd.stderr.txt')

  $portFile = Join-Path $env:AMUXD_HOME 'run\amuxd.http.port'
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $portFile) -and -not $daemon.HasExited) { Start-Sleep -Seconds 2 }
  if ($daemon.HasExited) { throw "amuxd start exited with $($daemon.ExitCode) before it was up" }
  if (-not (Test-Path $portFile)) { throw 'amuxd did not write its HTTP port file within 90s' }
  $port = (Get-Content $portFile -Raw).Trim()
  Invoke-RestMethod "http://127.0.0.1:$port/v1/healthz" | Out-Null
  Write-Host "amuxd up on port $port"

  # --- One turn ------------------------------------------------------------
  $session = Invoke-Api POST '/v1/sessions' @{
    teamId = $teamId; title = $runTag; mode = 'solo'
    primaryAgentActorId = $agentId; participantActorIds = @($member.id, $agentId)
  }
  $sessionId = $session.id

  # Start the agent's runtime on this session, as a client would.
  $rootToken = (Get-Content (Join-Path $env:AMUXD_HOME 'run\amuxd.http.token') -Raw).Trim()
  $local = Invoke-Local POST '/v1/auth/exchange' $rootToken `
    (@{ scopes = @('sessions:read', 'sessions:write', 'workspace:write'); ttl_seconds = 900; label = 'windows-smoke' } | ConvertTo-Json)

  # A runtime needs a cloud-registered workspace; a freshly onboarded daemon
  # has none ("workspace identity resolution failed"). Register a project
  # directory the way the desktop does after onboarding — outside the amuxd
  # home, which this endpoint refuses.
  $wsPath = Join-Path $tmpRoot 'smoke-workspace'
  New-Item -ItemType Directory -Force -Path $wsPath | Out-Null
  $ws = Invoke-Local POST '/v1/workspaces' $local.token (@{ path = (Resolve-Path $wsPath).Path } | ConvertTo-Json)
  Write-Host "Workspace $($ws.workspace_id) registered at $($ws.path)"

  $startReq = [byte[]]((PbEnum 1 $AGENT_TYPE_PI) + (PbString 4 $ws.workspace_id) + (PbString 6 $sessionId) + (PbString 10 'full_access'))
  $rpcReq = [byte[]]((PbString 1 ([guid]::NewGuid().ToString())) + (PbString 4 $member.id) + (PbBytes 30 $startReq))
  $rpcRes = Invoke-WebRequest -Method POST -Uri "http://127.0.0.1:$port/v1/rpc" `
    -Headers @{ authorization = "Bearer $($local.token)" } -ContentType 'application/octet-stream' -Body $rpcReq
  $res = PbDecode ([byte[]]$rpcRes.Content)
  $start = if ($res.ContainsKey(20)) { PbDecode $res[20] } else { @{} }
  if (-not $res[2] -or -not $start[1]) {
    throw "RuntimeStart rejected: $(PbText $res 3) $(PbText $start 4) [$(PbText $start 5)]"
  }
  Write-Host "Runtime $(PbText $start 2) started on session $sessionId"

  $pong = "pong-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $msgId = [guid]::NewGuid().ToString()
  Invoke-Api POST "/v1/sessions/$sessionId/messages" @{
    id = $msgId; teamId = $teamId; senderActorId = $member.id
    content = "This is an automated install check. Reply with exactly this word and nothing else: $pong"
    metadata = @{ mention_actor_ids = @($agentId) }
  } @{ 'idempotency-key' = $msgId } | Out-Null
  Write-Host "Message sent; waiting up to ${replyTimeoutSec}s for the agent"

  $reply = $null
  $deadline = (Get-Date).AddSeconds($replyTimeoutSec)
  while ((Get-Date) -lt $deadline -and -not $reply) {
    Start-Sleep -Seconds 5
    if ($daemon.HasExited) { throw "amuxd exited with $($daemon.ExitCode) while the turn was running" }
    $page = Invoke-Api GET "/v1/sessions/$sessionId/messages?limit=50"
    $reply = $page.items | Where-Object { $_.senderActorId -eq $agentId -and $_.content } | Select-Object -Last 1
  }
  if (-not $reply) { throw "No reply from the agent within ${replyTimeoutSec}s" }
  Write-Host "Agent replied ($($reply.kind)): $($reply.content)"
  # A provider failure still lands as an agent_reply — a placeholder marked
  # metadata.turn_status (turn_aggregator.rs). Anything but a real answer
  # fails: the gateway, credits or model config is broken for a new install.
  $status = $reply.metadata.turn_status
  if ($status) { throw "The turn ended as '$status', not with an answer: $($reply.content)" }
  if ($reply.content -notmatch [regex]::Escape($pong)) {
    # A model paraphrasing is not an install failure; the turn completed.
    Write-Host "::warning::The reply does not contain $pong — the turn ran, the model just did not follow the instruction."
  }
}
catch {
  $failed = $_.Exception.Message
}
finally {
  if ($daemon -and -not $daemon.HasExited) {
    & $Amuxd stop 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    if (-not $daemon.HasExited) {
      # /T takes the pi host and its children with it; elsewhere (a local run
      # of this script on macOS) Stop-Process is enough.
      if ($IsWindows) { & taskkill /F /T /PID $daemon.Id 2>$null | Out-Null }
      else { Stop-Process -Id $daemon.Id -Force -ErrorAction SilentlyContinue }
    }
  }
  # Cleanup is best effort: a leftover agent or session in the test team is
  # noise, not a reason to hide the real result.
  if ($sessionId) {
    try { Invoke-Api PATCH "/v1/sessions/$sessionId" @{ archived = $true } | Out-Null }
    catch { Write-Host "::warning::Could not archive session ${sessionId}: $_" }
  }
  if ($agentId -and $teamId) {
    try { Invoke-Api DELETE "/v1/teams/$teamId/members/$agentId" | Out-Null }
    catch { Write-Host "::warning::Could not delete agent ${agentId}: $_" }
  }
  $logs = Join-Path $env:AMUXD_HOME 'logs'
  if (Test-Path $logs) { Copy-Item $logs (Join-Path $OutDir 'amuxd-logs') -Recurse -Force }
}

if ($failed) {
  Write-Host "::error::Agent turn failed: $failed"
  exit 1
}
Write-Host 'Agent turn passed.'
