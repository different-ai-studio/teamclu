# ESP32-S3 Voice Terminal — Implementation Plan

> **Branch:** `task/stopwatch-esp32-devi`
> **Status:** Rev 6 (2026-08-25). Device runs on hardware: face, provisioning,
> MQTT and the `voice/ctl` control plane are verified end to end. The full
> voice round trip — mic → STT → agent → TTS → speaker — is written on both
> sides. **Speech now works against the live vendor**: Alibaba NLS recognises
> and synthesises through amuxd's own code (§13.9). What has still never run is
> the device half — no audio has left or entered the hardware (§14).
> §13/§15/§16 are the changelogs.
>
> Rev 1 was written blind. Rev 2 corrected it against the live amuxd/EMQX
> stack. Rev 3 corrects it against the **actual hardware and the design
> canvas** — which turned out to change more than rev 2 did. Rev 4 added the
> ctl control plane. Rev 5 closes the daemon-side audio loop. **Rev 6 withdraws
> self-hosted STT/TTS in favour of hosted Alibaba NLS behind an FC-minted
> credential (§13.9) — read that before §13.5/§13.6, whose vendor choice it
> supersedes.**

A pocket **voice terminal** for TeamClu on the **M5Stack Core StopWatch**.
Two gestures: hold the top-right button to *talk* (the agent answers out loud),
hold the bottom-right to *note* (it saves and says nothing). amuxd routes audio
through STT → the agent runtime → TTS.

## 0. What the device is

The board is **not** a custom build. It is a shipping M5Stack product, and
that single fact removes most of rev 2's hardware risk.

| | |
|---|---|
| Product | [M5Stack Core StopWatch](https://shop.m5stack.com/products/m5stack-stopwatch-dev-kit-esp32-s3) (C152), $45, 52 mm ⌀, 39 g |
| MCU | ESP32-S3R8, 16 MB flash, 8 MB PSRAM (OCT), Wi-Fi 4 / BT 5 |
| Display | 1.75" round AMOLED **466×466**, CO5300 over QSPI |
| Touch | CST820B |
| Audio | ES8311 codec, MEMS mic, 1 W speaker via AW8737A |
| Other | BMI270 IMU, RX8130CE RTC, M5IOE1 I/O expander, M5PM1 PMIC, vibration motor, 450 mAh |
| Buttons | KeyA `G2` (yellow), KeyB `G1` (blue), power (via M5PM1) |

**Pin map** ([source](https://docs.m5stack.com/en/core/StopWatch)):

| Bus | Pins |
|---|---|
| Display QSPI | CS `G39`, SCK `G40`, TE `G38`, D0–D3 `G41`/`G42`/`G46`/`G45` |
| I²C (shared) | SCL `G47`, SDA `G48` — touch, ES8311 `0x18`, BMI270 `0x68`, RX8130 `0x32`, M5PM1, M5IOE1 |
| I²S | MCLK `G18`, BCLK `G17`, DOUT `G16`, LRCK `G21`, DIN `G15` |
| Touch INT | `G13` |
| Expansion | HY2.0-4P `G10`/`G11`; rear bus `G0`, `G3`–`G9` |

**The M5IOE1 trap.** Display reset, touch reset, speaker enable and the
vibration motor are **not on GPIOs** — they hang off M5IOE1, a proprietary I²C
expander with no ESP-IDF driver. Anyone bringing this board up from scratch
loses days here. We do not: see §1.

## 1. Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| Board | M5Stack Core StopWatch | Was rev 2's blocking unknown; resolved |
| Firmware stack | **ESP-IDF 5.5 + LVGL 9.5 + M5GFX** | Matches the reference project exactly (§2) |
| HAL | **Vendored from `m5stack/M5StopWatch-UserDemo` (MIT)** | Official ESP-IDF reference for this exact board |
| Chain | `ESP32 → MQTT → EMQX(cloud) → amuxd → pi → OpenAI` | Reuses the existing agent/session/MQTT stack |
| Intents | **Two: `chat` and `note`** | From the design canvas; rev 2 had only one |
| STT / TTS | ~~Deepgram / Cartesia~~ → ~~FunASR / CosyVoice self-hosted~~ → **Alibaba NLS, hosted** | Self-hosting was a dead end (§13.9); FC mints a short-lived token, amuxd connects direct |
| Brain | pi (`local_agent = "pi"`), gpt-4o-mini | Speed/cost fit |
| Audio codec | Opus, 16 kHz mono, 20 ms, 24 kbps VBR, QoS 0 | Pinned in rev 2 |
| Transport | **WSS via Caddy :443 → EMQX ws :8083** | The only working TLS path (§8) |
| Device auth | Device secret in NVS → `/v1/devices/token` → short-lived MQTT JWT | A static token cannot work (§8.1) |
| Topic scope | Device-scoped `.../voice/{mic,spk,ctl}`, intent in payload | Device can't subscribe to a session that doesn't exist yet |
| UI | 10 screens, geometric face; **no transcript except the notes list** | Per the design canvas (§5) |
| Latency tier | ~600–1100 ms PTT-release→first-audio, **unmeasured** | Still the core untested bet (§9) |

## 2. The reference project changes the shape of this work

`m5stack/M5StopWatch-UserDemo` is an **MIT-licensed ESP-IDF project for this
exact board**, with a complete HAL:

```
hal_ioe.cpp      M5IOE1        hal_display.cpp  CO5300 via M5GFX
hal_pmic.cpp     M5PM1         hal_audio.cpp    ES8311 record/play
hal_button.cpp   A/B/Pwr       hal_rtc.cpp      RX8130CE
hal_imu.cpp      BMI270        drivers/cst820/  touch
utils/config_ap/               captive AP portal  ← our provisioning path
```

Rev 2 costed all of this as net-new firmware. It is now **vendored**, not
written. What remains genuinely new on the device is the app layer, the
network layer, and power management.

Its dependency set is also our stack, already proven to build together:
ESP-IDF 5.5, LVGL 9.5, M5GFX, `smooth_ui_toolkit`, `mooncake`, M5IOE1, M5PM1,
BMI270, ArduinoJson — fetched by `fetch_repos.py`, not vendored.

> ⚠️ Its `sdkconfig.defaults` was generated on **5.5.4** and pins OCT-mode
> PSRAM. Building on 5.4 invites `esp_lcd` API drift. Use 5.5.

## 3. Architecture chain

```
                      intent=chat ────────────────────────────┐
┌────────┐  MQTT/WSS  ┌──────┐  MQTT  ┌────────────────────────┴───────────┐
│ ESP32  │ ─────────► │ EMQX │ ─────► │ amuxd voice adapter                │
│ Stop-  │ ◄───────── │cloud │ ◄───── │  ├─ STT (Alibaba NLS, hosted)      │
│ Watch  │            └──────┘        │  ├─ chat sink ─► agent runtime     │
└────────┘                            │  │    └─ token deltas ─┐           │
                                      │  └─ TTS (Alibaba NLS)  ◄┘          │
                      intent=note ───►│       └─ Opus 20 ms ─► spk (paced) │
                                      │  └─ transcript ─► session store    │
                                      └────────────────────────────────────┘
                                         (note never produces spk audio)
```

pi and OpenAI see only text, exactly as today. Speech credentials are minted by
FC and the audio goes straight from amuxd to the NLS gateway — it never
transits the Cloud API (§13.9).

### 3.1 amuxd is local — the deployment consequence

`amuxd` runs on the **user's own machine**. The device routes through cloud
EMQX to *that machine*, which must be awake and online. A closed laptop makes
the device inert.

Accepted for v1; it is the price of reusing the local agent stack. But it is a
**product constraint, not a detail** — and it is why the device must show a
distinguishable "电脑没醒着" error rather than hanging (§5). Exits, both out of
scope here: run amuxd on the always-on self-host box (which already runs an
`amuxd` compose service), or build a cloud-side adapter.

## 4. Reuse vs new — rev 3

| Layer | Status |
|---|---|
| amuxd ↔ EMQX, ↔ pi, prompt/session machinery | ✅ reused (`RuntimeManager::send_prompt`, `runtime/manager.rs:1033`) |
| **Board HAL** (display, touch, audio, IOE, PMIC, RTC, IMU, buttons, captive AP) | ✅ **vendored (MIT)** — was net-new in rev 2 |
| Firmware app layer (face state machine + 10 LVGL screens) | ✅ **written, host-tested, compiles** — not yet run on hardware |
| Device credential exchange (FC endpoints + NVS + refresh) | 🆕 new, blocking (§8.1) |
| EMQX authorization / topic ACLs | 🆕 new, cross-cutting (§8.2) |
| amuxd voice adapter (STT/TTS, endpointing, barge-in, **note queue**) | 🆕 new |
| Device Wi-Fi + MQTT + Opus + power management | 🆕 new |
| CJK font pipeline | 🆕 new (§6.1) |

## 5. Device behaviour — from the design canvas

Source: `StopWatch Agent.dc.html` (Claude Design project *Stopwatch Agent
设备交互设计*). Geometry is transcribed 1:1 — the artboard's screen is 466×466,
the panel's native resolution, so nothing is scaled.

**Gestures**

| Control | Hold | Short press |
|---|---|---|
| KeyA `G2` (对话) | Talk → agent replies aloud | Interrupt playback |
| KeyB `G1` (记录) | Note → saves, no reply, queues offline | Show today's notes |
| Power | Long: power off | Toggle sleep |

**Screens (10).** idle (clock + eyes + quip) · listen (eyes closed + waveform)
· think (bobbing squares + drifting dots) · reply (chewing mouth) · saving ·
saved (smile + count) · notes · wifi (pairing code + `192.168.4.1`) · sleep
(two dashes) · error.

**The face is the whole UI.** Two rectangles as eyes plus, sometimes, a mouth;
every state reshapes the same two eye slots, which is what makes it read as one
character rather than eight screens. The reply state shows **no text at all** —
"全程无字" is a deliberate latency-perception decision, not an omission.

**Colour** carries the mode: chat listens in accent `#EC3013`, note listens in
white `#F3F2F2`. That swap is the only thing telling the user which button they
are holding.

**Notes is the one screen with text**, contradicting rev 2's blanket "no
transcript ever". Rev 2's rule was right about the *reply* path only.

### 5.1 Divergences we deliberately encoded

| Divergence | Resolution |
|---|---|
| Canvas has no error screen | Added, reusing the canvas's shape vocabulary. Must distinguish: no Wi-Fi / no broker / **no amuxd** / upstream |
| Canvas ignores A/B while asleep; rev 2 said "wake on PTT" | Canvas wins (newer artifact). One `if` in `FaceState::onButtonDown` — still open |
| Canvas prototype's A-short toggles the reply screen | That is a preview affordance. Firmware implements the canvas's own copy: "短按打断朗读" |
| Canvas topics `dev/{id}/audio` | Rejected — see §7 |

The canvas's single `wifi` screen turns out to be **exactly right**, because the
pairing code is typed *into* the device (§8.1) rather than displayed by it. The
screen shows the SoftAP SSID suffix (last two MAC bytes) and the portal URL, and
never shows a secret. Had we gone the other way — device displays a code, user
types it into the app — the canvas would have needed a second screen.

## 6. Firmware layout

```
apps/esp32/
  main/face/     ours    face_state.*  pure C++, no LVGL/IDF, host-testable
                         face_ui.*     LVGL scenes + animation
                         palette.h     design tokens, transcribed 1:1
  main/hal/      MIT     vendored board HAL
  main/main.cpp  ours    wires HAL ↔ face; network hooks stubbed MILESTONE 2
  test/          ours    host tests, no toolchain or hardware needed
```

`face_state` knows nothing about rendering or hardware; side effects are
injected as `face::Hooks`. That is the seam milestone 2 plugs into — adding
MQTT should not touch the interaction logic.

### 6.1 Fonts — a real gap

The clock is Latin (`CommissionerMedium108`). The Chinese UI strings need a
subset font built by `tools/gen_fonts.sh` (node + Noto Sans SC). `face_ui.cpp`
detects it via `__has_include` and falls back to Montserrat, so the firmware
builds either way — but every Chinese glyph renders as a box until it is run.

**The subset only covers fixed strings.** Real note text (milestone 3) is
arbitrary Chinese and cannot be subset ahead of time. The fix is a full GB2312
binfont on the 4 MB `storage` FAT partition via `lv_binfont_create`; the
partition and `CONFIG_LV_USE_FS_STDIO` are already in place.

### 6.2 What we removed from the vendored HAL — and where Wi-Fi actually comes from

Two files from the upstream demo were deleted:

- **`hal_badge.cpp`** — the demo's badge-image feature. It needs
  `assets/assets.h` (part of the 9 MB of watch-face artwork we did not copy),
  and we do not ship badges.
- **`hal/utils/config_ap/`** — deleted with it, because it is its *only*
  consumer.

**`config_ap` is not a Wi-Fi provisioning portal.** Despite the name it is a
badge-image **upload** portal: it raises a SoftAP and serves `/upload`,
`/badge/state`, `/badge/image`, `/badge/active`. It never collects Wi-Fi
credentials. An earlier revision of this plan assumed we could repurpose it for
provisioning; that was wrong.

Wi-Fi provisioning comes instead from **`78/esp-wifi-connect`**, already a
managed dependency of the reference project:

| Class | Role |
|---|---|
| `WifiConfigurationAp` | SoftAP + DNS hijack + captive portal + AP scan list; `SetSsidPrefix()` brands the SSID |
| `SsidManager` | Multi-network credential storage in NVS, with a default |
| `WifiStation` | Connect and reconnect |

So provisioning is close to free: set the SSID prefix to `TeamClu-<MAC suffix>`
and wire the connection state to the `wifi` screen. **Pairing** — binding the
device to a `team/actor` — is a separate problem and is unsolved; see §8.1.

### 6.3 Defects found by the first compile

Recorded because two of the three are latent traps that would recur:

1. `hal_badge.cpp` → missing `assets/assets.h` (fixed by deletion, §6.2).
2. **`LV_FONT_DECLARE` inside an anonymous namespace.** Font tables compile as
   C, so their symbols are unmangled; declaring them inside `namespace { }` in
   a C++ TU gives them internal C++ linkage. This fails at **link** time with
   an undefined reference, not at compile time, so it is easy to misread. Font
   declarations must be at global scope inside `extern "C"`.
3. The same bug, latent, in the header `tools/gen_fonts.sh` emits — it would
   have detonated identically the first time anyone generated the CJK font.
   Fixed with an `#ifdef __cplusplus extern "C"` guard.

### 6.4 Sleep policy and power profiling

**Before this, there was no power management at all.** "Sleep" set the backlight
to 0 and changed nothing else: CPU pinned at 240 MHz
(`CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240`), no `CONFIG_PM_ENABLE`, no tickless
idle, the 60 fps loop still spinning, and `stopLvglUpdate()` present but never
called. Roughly 40–50 mA with the screen off — under 10 h standby on 450 mAh.

One thing the design already gets right: the face is black-dominant, and on an
AMOLED black pixels are off. The idle screen lights maybe 5% of the panel, so
the display is *not* the dominant cost — the idle SoC is.

Implemented tiers (`power/sleep_policy.*` decides, `power/power_hw.*` applies):

| Tier | Trigger | Effect |
|---|---|---|
| Active | interaction | full brightness, LVGL at 60 fps |
| Dim | 15 s idle | 25% of the user's brightness, animations continue |
| ScreenOff | 60 s idle | backlight off, **`stopLvglUpdate()`**, 250 ms poll loop |
| LightSleep | 180 s idle (10 s after an explicit power press) | `esp_light_sleep_start()` in 250 ms slices |

Precedence is `busy` > `userAsleep` > inactivity. `busy` covers
Listen/Think/Reply/Saving — the device must never dim or sleep with audio in
flight — and it also keeps the idle clock fed, so releasing a button does not
drop straight into Dim.

**Two upstream defects had to be fixed first, and both are worth knowing about:**

1. `hal_button.cpp` had `btnPwr.setRawState(...)` **commented out** — the power
   button was never read at all, so every power gesture was dead code.
2. `pmic_get_pwr_btn_state()` did `return _pm1->btnGetState(&result)`, returning
   the `m5pm1_err_t` instead of the state. With `M5PM1_OK == 0` that reports
   "not pressed" on success and "pressed" on failure — exactly inverted, and
   almost certainly why (1) was commented out.

**Why light sleep needs a timer wake.** The power button is on the PMIC and
reachable only over I²C — its IRQ pins are `M5PM1_GPIO_NUM_*`, i.e. GPIOs on
the PMIC, with no interrupt line to the ESP32. So the only way to notice a
power press while asleep is to wake and look. `lightSleepSlice()` therefore
always arms a 250 ms timer alongside the GPIO wakes on KeyA/KeyB (`G2`/`G1`,
active low). That doubles as a safety net: a wrong GPIO wake config can never
leave the device looking dead.

DFS (`CONFIG_PM_ENABLE`) is deliberately **not** enabled yet — it interacts with
OCT-mode PSRAM and peripheral clocks, and explicit tiers are more predictable.
Worth revisiting once light sleep is measured on hardware.

**Profiling is voltage-only.** The M5PM1 has no current sense and no coulomb
counter — only `readVbat`. So drain is inferred from the voltage slope
(`power/battery_log` emits `BATT,ms,mv,pct,charging,state` labelled by
screen *and* tier; `tools/battery_watch.py` fits it). That imposes a protocol:
one state at a time for 30–60 min, comparable starting SoC (80%→60% is the most
linear stretch), USB unplugged. For absolute mA, use an inline USB power meter.
The tooling reports mAh/h as a derived estimate for *ranking* tiers, not as a
measurement.

None of this has run on hardware yet — it is blocked on M1-6.

## 7. MQTT topic design

| Topic | Direction | Payload | QoS |
|---|---|---|---|
| `amux/{team}/{actor}/voice/mic` | device→amuxd | Opus 20 ms frames + `intent=chat\|note` | 0 |
| `amux/{team}/{actor}/voice/spk` | amuxd→device | Opus frames (chat only) | 0 |
| `amux/{team}/{actor}/voice/ctl` | both | JSON: session id, turn start/stop, flush/barge-in, error, queue depth | 1 |
| `amux/{team}/{actor}/state` | device→broker | retained: battery, offline-queue length, LWT | 1 |

The canvas's flat `dev/{id}/…` scheme was rejected: amuxd does not route it, and
it would need a new device→actor mapping layer plus its own ACL design.

Session id travels in `ctl`, never in the path — the device cannot subscribe to
a session it has not yet caused. Control markers are QoS 1 because a dropped
flush is exactly the failure that cannot be tolerated.

## 8. Cloud services — corrected against the live deployment

**Authentication** exists: one JWT (HS256) authenticator reading the token from
the MQTT **password** field. Clients pass their Supabase `access_token`.

**Authorization does not exist.** No `authorization` block, `verify_claims =
[]`. Any authenticated client can publish or subscribe anywhere under `amux/#`.

**Transport.** `listeners.wss.default` is disabled; the :8883 TLS listener has
been broken since 2026-08-09 (Caddy stores certs `0700 root:root`, EMQX runs as
uid 1000 — it binds, then drops every connection at handshake). Working paths:
Caddy WSS :443 → ws :8083, and plaintext :1883. **A pocket device on public
Wi-Fi must use WSS :443**, even though existing clients use 1883.

### 8.1 Pairing and credential exchange — DECIDED

The MQTT password is a short-lived JWT. `daemon/server.rs:1697` refetches every
connect cycle and `credential_in_proactive_refresh_window` forces a refresh
before expiry. A static NVS token drops off within one token lifetime and never
returns. FC has **no device-auth concept at all** — no device routes, and
nothing on the FC side signs with the EMQX secret.

**Decision: the pairing code is generated by amuxd and typed into the device's
captive portal alongside the Wi-Fi credentials — one form, one trip.**

```
1. amuxd generates the code
   amuxd already holds a backend token and knows team + actor.
   It mints a random single-use code and registers it:
     POST /v1/devices/pairing-codes        (bearer: amuxd's own token)
     { code, teamId, actorId, ttlSeconds: 600 }
   Desktop surfaces the code to the user.

2. Device captive portal collects SSID + password + pairing code  → NVS

3. Device connects Wi-Fi, then redeems  — against FC, NOT amuxd:
     POST /v1/devices/redeem               (unauthenticated, rate-limited)
     { code, deviceId, model, fw }
     → 200 { deviceSecret, teamId, actorId }   code burned
     → 409 expired / already redeemed

4. Steady state
     POST /v1/devices/token { deviceSecret } → short-lived MQTT JWT
     Device refreshes proactively, mirroring the daemon's window.

5. Revocation — a physical device can be lost. This is the only recovery.
```

**Why redemption goes through FC even though amuxd mints the code.** The
obvious shortcut — have the device redeem straight against amuxd on the LAN,
requiring no FC work at all — does not survive contact with the daemon:

- `HttpConfig::bind` defaults to **`127.0.0.1:0`** — loopback only, and an
  *ephemeral* port written to `<config_dir>/amuxd.http.port`.
- There is **no mDNS or discovery of any kind** in the daemon.
- Its own config doc says: *"Defaults are tuned for 'localhost browser
  connecting to a single user's daemon'; cross-host deployments must set `bind`
  + a TLS terminator in front."*

Making the device reach it would mean binding the **agent control API** — which
can drive an agent that executes things — to `0.0.0.0` over plain HTTP, on a
port the device cannot discover. That is not a trade worth making for setup
convenience. amuxd stays loopback-only; FC brokers the redemption.

**Security posture of typing the code into the device portal.** The earlier
objection to this direction was that the device's open SoftAP would receive a
credential. What it actually receives is a **single-use, 10-minute capability**,
not a bearer token — a much weaker thing to leak, and it grants exactly one
binding to one team/actor. Residual risk is the setup window: someone in Wi-Fi
range could join the open AP, sniff the plaintext POST to `192.168.4.1`, and
race the redeem. Mitigations, all cheap:

- **WPA2 on the SoftAP** (device-specific password shown on screen) — closes
  the sniffing path entirely and is the one that matters
- Short TTL, single use, rate-limited `redeem`
- A lost race is **visible, not silent**: the real device gets a 409 and the
  user retries with a fresh code

**Implementation note.** `78/esp-wifi-connect`'s captive portal serves fixed
HTML (`wifi_configuration.html`) with no hook for extra form fields, so the
pairing-code input requires vendoring it into `components/` via `repos.json`
plus a patch — the same mechanism already used for M5IOE1 and M5PM1.

**Signing — RESOLVED: a dedicated secret and a second EMQX authenticator.**

Not on general principle, but because of what is actually deployed. FC does
**not** currently hold the Supabase/EMQX JWT secret — the `fc` service's compose
env has `SUPABASE_SERVICE_ROLE_KEY`, `TRUSTED_EXTERNAL_JWT_SECRET` and
`AGENT_MANAGEMENT_GRANT_SECRET`, and no JWT signing secret. "Reuse the Supabase
secret" therefore means *adding* it to FC, which would newly grant FC the
ability to mint a valid token for any user.

The repo already has this exact pattern and an explicit position on it.
`services/fc/src/lib/agent-management-grant.ts` mints a scoped, short-TTL grant
with a dedicated key, and says why:

> Dedicated key only. […] whoever can mint external login JWTs would otherwise
> be able to mint management grants too, and issuer/audience separation does
> nothing against a holder of the key itself.

So: a new `DEVICE_MQTT_JWT_SECRET`, shared only between FC (which signs) and
EMQX (which validates via a **second** `authentication` entry alongside the
existing one). Declare it in both `s.yaml` and the compose `environment:` map,
or it silently goes missing on one deploy target.

### 8.4 Pairing data model

`services/supabase/migrations/20260824000000_device_pairing.sql`:

- `amux.device_pairing_codes` — single-use, TTL'd, unique on `code_hash`
- `amux.devices` — one row per paired device, `secret_hash`, `revoked_at`

**Neither the pairing code nor the device secret is stored in the clear**; both
are sha256 hashes used as lookup keys, so a dump of these tables does not let
the holder pair a device or reach the broker. The hashes are unsalted *on
purpose* — they must stay deterministic lookup keys, and the inputs are
high-entropy random values rather than user-chosen passwords, so the
rainbow-table argument for salting does not apply.

RLS is enabled with **zero policies** (deny-all) and both tables are revoked
from `anon`/`authenticated`: only FC's service role touches them. Note that
`service_role` still needs explicit table `GRANT`s — BYPASSRLS alone is not
enough, a lesson already paid for by
`20260821100000_marketplace_service_role_grants.sql`.

### 8.2 EMQX authorization is cross-cutting

Enabling it affects desktop, iOS, expo and amuxd simultaneously — all of which
currently rely on a fully open topic space, whether they know it or not. Turning
ACLs on without auditing every client's subscription set breaks them silently
(subscribe succeeds, messages stop). Own task, own rollout, **ahead** of the
device.

### 8.3 Cost model

**Live again.** An earlier revision marked this "largely moot" on the premise
that both vendors were self-hosted; §13.9 withdrew that premise. Alibaba NLS
bills per usage and this device streams whenever a button is held, so P0-4 must
produce a per-active-minute cost and a monthly projection before the device
ships to more than a handful of people.

Note mode needs STT but **not** TTS, so the two intents have genuinely
different unit costs — model them separately. Barge-in also matters here: the
daemon paces `spk` frames and stops synthesising on cancel (§13.6), so an
interrupted reply is not billed for its whole length.

Because the credential is minted per team (§13.9), per-team attribution is
available if it is ever needed — the same place LiteLLM already does it for
LLM spend.

## 9. Latency budget — still a bet

| Hop | Estimate |
|---|---|
| Device → EMQX → amuxd | ~40–90 ms |
| NLS ASR final after endpoint | ~100–250 ms (hosted; one WAN hop) |
| Agent runtime first token | ~300–600 ms |
| NLS TTS first audio chunk | ~90–200 ms (hosted; unmeasured) |
| amuxd → EMQX → device (incl. 200 ms prebuffer) | ~200–300 ms |
| **PTT-release → first audio** | **~700–1400 ms** |

Every figure is an estimate; none has been measured. P0-4 measures it with the
fake device, no hardware involved. **If the real number lands past ~1500 ms the
product thesis needs revisiting before more firmware is written.**

Two notes. The vendor hops are back after §13.9 withdrew self-hosting, but a
hosted GPU almost certainly beats laptop CPU inference by more than the WAN hop
costs — the self-hosted variant traded a network hop for a much worse compute
one. And the downlink figure includes the 200 ms prebuffer from §13.6, which is
deliberate spend bought to make barge-in and jitter behave; dropping it would
shave the budget and break both.

Escape hatch, documented not built: swap the brain to OpenAI Realtime (native
audio, no STT/TTS) behind the same MQTT/EMQX/device layer.

## 10. Task breakdown

### Milestone 1 — offline bring-up 🟡 in progress
- **M1-1 ✅** Project scaffold on the reference's build glue; HAL vendored
- **M1-2 ✅** `face_state` — gestures, 10 screens, error taxonomy, note list
- **M1-3 ✅** Host tests, 10/10 green (`apps/esp32/test/run.sh`)
- **M1-4 ✅** `face_ui` — LVGL scenes + animations for all 10 screens
- **M1-5 ✅** Compiles clean on ESP-IDF 5.5. 1.33 MB binary, 74% of the app
  partition free. Three defects found and fixed — §6.3.
- **M1-6 ✅** Flashed and **running on hardware** (1,344,752 bytes at `0x20000`,
  hashes verified). Confirmed live over the serial console:
  - face state machine drives real transitions (`reply` → `saved` → `idle`)
  - vibration motor fires (`M5IOE1_PWM duty=2866 … duty=0`)
  - battery telemetry emits the documented CSV, labelled `screen/tier`
  - **sleep ladder works**: `active → dim → screenoff` at the configured
    15 s / 60 s thresholds, with `[power] tier -> screenoff` on the edge

  The board will not auto-reset into the bootloader — every `--before` mode
  fails with "No serial data received". **It has no BOOT button** (`G0` is on
  the rear header); an earlier revision of this plan said to hold BOOT, which
  was wrong. The real procedure is **hold Power ~2 s until the green LED
  lights**. Equally: esptool's closing `Hard resetting via RTS pin` is a no-op
  here — RTS is not wired to reset — so the device stays in download mode and
  the console stays silent until Power is short-pressed.
- **M1-7** CJK subset font (§6.1)
- **M1-8** Tune animation timing against the canvas on the real panel

### Milestone 2 — link up (hardware-free work first)
- **M2-1** Fake device: desktop process publishing canned Opus on `.../voice/mic`
- **M2-2** Device credential exchange (§8.1), incl. the signing decision
- **M2-3** EMQX authorization audit (§8.2) — enumerate, design, stage. **Do not enable yet**
- **M2-4** End-to-end text loop + **latency measurement** + **cost model**
- **M2-5** Gate: review §9 actual vs estimate before more firmware
- **M2-6** On-device provisioning: vendor `78/esp-wifi-connect` into
  `components/` via `repos.json` + a patch adding the **pairing-code field** to
  its captive portal (its HTML has no extension hook), brand the SSID
  `TeamClu-<MAC suffix>`, and put **WPA2 on the SoftAP** (§8.1)
- **M2-7** amuxd: mint pairing codes + `POST /v1/devices/pairing-codes`;
  FC: `redeem` / `token`; device-side JWT refresh + WSS MQTT
- **M2-8** Opus encode/decode on device; measure CPU headroom — the one figure
  that can still invalidate the codec choice

### Milestone 3 — the two intents end to end
- **M3-1** ✅ amuxd voice adapter: `VoiceRouter`, ctl→turn lifecycle, sink seam
- **M3-2** ✅ Streaming STT → partial + final transcripts (FunASR, not Deepgram — §13.5)
- **M3-3** ✅ `chat`: final transcript → `send_prompt` (§13.7)
- **M3-5** ✅ Reply → TTS → Opus → `spk`, with `thinking`/`spk_start`/`spk_end`
  ctl and paced frames (CosyVoice, not Cartesia — §13.6)
- **M3-4** ✅ `note`: transcript → session message store, **no TTS**, no reply
  (§13.8). Includes the firmware half: `note_saved` ctl, and the `Saved` cue
  no longer fires on a timer when a backend is bound.
- **M3-6** Offline note queue on device (NVS/FAT) + drain on reconnect + queue
  depth on the retained `state` topic
- **M3-7** Endpointing + barge-in state machine; QoS 1 flush on `ctl`.
  Barge-in's daemon half is done (router `cancel` → speaker stops mid-reply,
  which is why `spk` paces frames); device-side endpointing is not.
- **M3-8** Full GB2312 binfont for real note text (§6.1)

None of M3-1..M3-5 has run against a real device or a real STT/TTS server —
see §13.5, §13.6 and §14.

### Milestone 4 — hardening
- Power budget vs 450 mAh; light sleep + wake path
- Reconnect / partial-uplink recovery, token refresh across a disconnect
- Error UX end to end: every §5.1 error class renders correctly
- Enable EMQX authorization (M2-3) and verify no client regressed

### Deferred
OTA · OpenAI Realtime swap · always-on amuxd (§3.1) · BMI270 wake-on-motion ·
RX8130CE scheduled wake · touch input (CST820B is present and entirely unused)

## 11. Out of scope

- Always-on wake-word full-duplex (we do push-to-talk)
- On-device STT/TTS/LLM
- Text on the reply screen (deliberate — §5)
- Audio archival (transcript only)
- Removing the local-amuxd dependency (§3.1) — deferred, not solved
- Fixing EMQX's broken :8883 listener — we route around it via WSS :443

## 12. Open sub-decisions

1. MQTT JWT signing: reuse Supabase HS256, or a second EMQX authenticator (§8.1) — P0/M2-2
2. Device→actor granularity: one device one actor, or re-claimable; interacts with revocation — M2-2
3. Sleep + PTT: canvas (inert) vs rev 2 (wake on PTT) — §5.1
4. ~~Deepgram language~~ → FunASR `lang`: fixed `zh` today, auto-detect untested — M3-2
5. ~~Cartesia voice id~~ → CosyVoice `spk_id`: defaults to `中文女`, unvalidated
   against a real server — M3-5
5b. Where TTS/STT endpoints are configured. Both read env
   (`TEAMCLU_COSYVOICE_*`) with hardcoded localhost defaults. Deployment-shaped
   and secret-free, so env is defensible — but team-scoped routing (§7's facade
   philosophy) would want config, and neither backend is reachable from a
   team's settings today.
6. Whether audio is ever stored (default: no)
7. EMQX broker rate limits vs 50 frames/s/direction/device — M2-4
8. Touch: the panel has it and the design uses none. Leave unused, or let it
   replace a button gesture?

## 13.5 STT — FunASR client implemented (M3-2)

`voice/funasr.rs` is now a real streaming client, not a stub. It connects to a
`funasr-wss-server`, forwards the device's Opus frames **verbatim** (the server
ingests Opus, so nothing decodes anywhere on this path), and parses
`2pass-online` / `2pass-offline` messages into partial/final transcripts.

Three decisions worth knowing:

- **The socket is not closed when the user releases PTT.** Dropping the frame
  channel sends `{"is_speaking":false}` and then *keeps reading* — the offline
  final arrives after that marker. Closing at that point, which is the obvious
  reading of "the utterance ended", loses the transcript entirely.
- **`note` downgrades to offline-only.** A note is read back, not spoken, so it
  can trade first-partial latency for accuracy. `chat` stays 2pass.
- **Parsing is deliberately lenient.** FunASR builds differ on whether the final
  is signalled by `is_final` or only by a `…-offline` mode string; either counts.
  An empty *final* is kept (the user said nothing, and the router needs it to
  close the turn); an empty partial is dropped as bookkeeping.

**Not verified against a real server.** No `funasr-wss-server` is deployed yet,
and the protocol above is transcribed from documentation rather than observed on
the wire — which is exactly why `parse_transcript` is unit-tested against the
shapes it might receive rather than one assumed shape.

M3-1 (subscriber → router) was already wired: `mqtt::subscriber` parses the
5-segment voice topics and `daemon/server/rpc.rs` forwards `VoiceMic`/`VoiceCtl`
into `VoiceRouter`.

**Still missing for a working turn:** a deployed FunASR server, and the
`TranscriptSink` implementations that turn a final transcript into
`send_prompt` (chat, M3-3) and a stored note (M3-4). The default sink only logs.

## 13.6 TTS and the speech downlink — implemented (M3-5)

The chain is now closed end to end in code:

```
device → mic → STT → transcript → agent          ✅ M3-1/2/3
                                    ↓
                        token deltas → sentences → TTS → PCM   ✅ tts.rs / cosyvoice.rs
                                    ↓
                        resample 24k→16k → Opus 20 ms          ✅ resample.rs / spk.rs
                                    ↓
device ← spk ← ──────────────────────────────────             ✅ paced publish
```

**The vendor decision, made.** Plan §1 pins Cartesia; its API key does not
exist, exactly as with Deepgram. The default is **CosyVoice** running locally,
for the same three reasons FunASR won the STT slot: no key, no per-minute
billing, no audio egress, and it is the same ModelScope family — a deployment
that already runs FunASR is not taking on a second ecosystem. `Cartesia` and
`AliyunTts` remain as [`TtsBackend`] variants that the factory refuses with a
clear error, so switching later is a config change rather than a rewrite.

**Four things worth knowing about the implementation:**

- **The device contract already existed.** `ctl_parse.cpp` has recognised
  `session` / `thinking` / `spk_start` / `spk_end` / `error` since the firmware
  ctl work, and `main.cpp` acts on all five. The daemon was sending *none* of
  them. These are load-bearing, not decoration: the face arms a deadline when
  it enters Think and falls to the `NoAgent` error screen if nothing arrives,
  so a daemon that synthesises perfect audio but never sends `thinking` /
  `spk_start` shows the user an error and then talks over it.
- **A resampler was mandatory and is not in any earlier revision of this plan.**
  CosyVoice2 synthesises at 24 kHz (CosyVoice1 at 22.05 kHz); the device's Opus
  decoder is 16 kHz. Feeding 24 kHz samples to a 16 kHz encoder does not fail —
  it plays back 1.5× fast and chipmunk-pitched. `resample.rs` is a windowed-sinc
  streaming resampler with the cutoff at the lower Nyquist, tested with tones
  rather than by eye.
- **Frames are paced at wall-clock speed** after a 200 ms prebuffer, rather than
  published as fast as they encode. Two reasons: barge-in means nothing if a
  ten-second reply already sits in the device's play queue, and `onSpkFrame`
  hands every decoded buffer to the HAL play task, so a burst becomes queue
  pressure counted in `framesDroppedRx`.
- **Subscribe happens before the prompt is sent.** `ReplySpeaker::begin` runs
  ahead of `send_prompt` and keeps only the *live* half of the subscription. A
  subscription opened afterwards races the first token deltas (the reply starts
  mid-sentence); replaying the backlog instead would speak the previous turn's
  answer.

**Still unverified.** No CosyVoice server is deployed, so the HTTP protocol here
is transcribed from the repo's `server.py` rather than observed on the wire —
the same caveat as the FunASR client in §13.5. `CosyVoiceConfig::sample_rate`
is the highest-risk field: getting it wrong does not error, it just plays back
at the wrong speed, so it is the first thing to check when hardware audio sounds
off.

## 13.7 Chat sink — a transcript becomes a prompt (M3-3)

`voice/chat_sink.rs` turns a final `chat` transcript into
`RuntimeAdapter::send_prompt`. Three choices worth knowing:

- **One session per device, not per turn.** The device is a conversational
  object — "what did I just ask you" has to work — and sessions already carry
  history. Created lazily on the first transcript, so a device that is powered
  on but never spoken to does not hold a runtime.
- **The device's session id is a hint, not an instruction.** `turn_start` may
  carry one, but it is adopted only when we have no session of our own *and*
  the runtime confirms it exists. A device that remembers an id across a
  reflash must not be able to prompt into somebody else's session.
- **A rejected prompt drops the session**, so a restarted daemon does not leave
  the device wedged against a dead id forever.

It does not wait for the answer itself: `send_prompt` returns once the turn is
accepted, and the reply arrives as session events. The sink starts the speech
downlink (§13.6) through the `ReplySpeaker` seam *before* prompting, and calls
`fail` if the runtime rejects the prompt — otherwise the speaker would watch a
session that never answers while the device sat on Think until its own deadline
expired.

## 13.8 Note sink — the second intent (M3-4)

`voice/note_sink.rs` turns a final `note` transcript into one stored message.
It is the smaller half of the two intents by design: no agent, no TTS, no
reply.

**Where a note goes.** Into the session message store via
`Backend::insert_message`, as one `text` message attributed to the *device's*
actor (not the daemon's — that would file every user's note under whichever
machine relayed it). Two alternatives were rejected:

- **Ideas** (`teamclu::Idea`) sound note-shaped but are task objects — status,
  claims, submissions, parent links. "周会挪到周四" is not a work item.
- **`send_prompt`**, the way chat does it, starts a runtime and produces an
  answer. `insert_message` writes the row without waking an agent, which makes
  "no reply" structural rather than a promise.

**The device was lying, and now isn't.** `commitHold(Mode::Note)` showed
`Saving` then `Saved` on a **timer** (`SavingToSavedMs`), whether or not
anything had been stored — the same defect the chat path had before §13.6 gave
it real markers. Fixed the same way and with the same `_agentExpected` switch:

- **Unbound** (no MQTT session): the timer stays, so the gesture is still
  demonstrable offline.
- **Bound**: `Saving` waits for amuxd's `note_saved`, and falls to the
  `NoAgent` error screen after `AgentTimeoutMs` if nothing arrives. Silence now
  means "it did not save", which for a capture device is the one thing that
  must not be misreported.

A late `note_saved` — arriving after the deadline already showed Error —
replaces the error with `Saved`. Leaving the error up would be the same lie
pointing the other way.

**The transcript comes back with the marker.** `note_saved` carries
`{time, text}`, because the device never had the text: it shipped Opus frames
and only amuxd knows what they transcribed to. This is what lets the Notes
screen show real entries instead of the three placeholders `main.cpp` seeds.
Rendering them still needs the GB2312 font (M3-8) — the wire is done, the
glyphs are not.

**`FanOutSink`.** The router holds one sink but there are now two consumers, so
both receive every final and each ignores the intent that is not theirs. Adding
a third intent later means adding a sink, not editing a `match` in the routing
layer.

**Open piece.** `BackendNoteStore` takes its session id at construction,
because the daemon has no per-device notes session to resolve yet. That arrives
with M2-2 pairing — the same gap that means nothing is subscribed to
`voice/mic` to deliver a note in the first place. The write itself is complete
and tested against `MockBackend`. The device's `turn_start` session hint is
deliberately *not* used, for the reason §13.7 gives about chat.

## 13.9 Speech goes hosted, via an FC-minted credential (supersedes §13.5/§13.6's vendor choice)

**The self-hosted plan was wrong and is withdrawn.** §13.5 and §13.6 chose
local FunASR and CosyVoice, and the stated reason — "no API key exists" — was
an operational fact doing an architect's job. It produced a design where every
user hosts a 0.5B autoregressive TTS and a Paraformer ASR. That is a dev-machine
hack, not a product.

The numbers, once actually checked:

| | FC's ECS box | a dev laptop |
|---|---|---|
| CPU | 4 vCPU Xeon | Apple M4, 10 cores |
| RAM | 14 GB | 16 GB |
| free disk | **8 GB** (79% used) | 321 GB |
| GPU | **none** | M4 / MPS |

Two independent blockers on the shared box: the images alone (~7–10 GB FunASR,
~10–15 GB CosyVoice) do not fit in 8 GB, and with no GPU a 0.5B autoregressive
TTS runs far slower than real time on 4 cores — §9's 90–200 ms first chunk is
not reachable. Moving inference to the laptop dodges both but assumes hardware
no user has.

**Decision: hosted Alibaba NLS, reached with a credential FC mints.** The same
Paraformer and CosyVoice models, without hosting them.

The remaining choice was *how* "via Cloud API" works, and the repo already
answered it:

- **Rejected — proxy the audio through FC.** It would put a WebSocket audio
  relay inside a container that serves JSON REST, on the same 4-vCPU box as
  Postgres, EMQX and MinIO, and add a hop to a tight latency budget.
- **Chosen — FC mints, amuxd connects direct.** Exactly what
  `POST /v1/teams/:id/litellm/setup` already does for LLM traffic. NLS's
  `CreateToken` fits perfectly: the AccessKey never leaves FC, and what reaches
  the daemon expires on its own. Audio never touches FC.

DashScope/百炼 was the other vendor candidate and lost on this specific point:
it authenticates with a long-lived `sk-` key and has no short-lived token to
mint, so "hand out a credential" would mean handing out the real key.

**Shipped:** `POST /v1/teams/{teamId}/voice/credentials` (OpenAPI +
`lib/aliyun-nls.ts` + both repo backends + route), returning
`{ gatewayEndpoint, appKey, token, expiresAt, sttModel, ttsVoice }`.

Three things worth knowing:

- **Voice reads its own `VOICE_*` AccessKey and never inherits
  `ACCESS_KEY_ID`**, which on self-host is the *MinIO root credential*. That
  inheritance is what broke app deploys before (`provisioning/apps-oss.ts`), and
  signing an NLS request with a MinIO key fails upstream naming nothing.
- **503 vs 502 are kept distinct.** 503 `voice_unavailable` means "not
  configured" and names the empty variable; 502 `voice_upstream_failed` means
  "configured, vendor call failed". Collapsing them sends whoever is on call to
  the wrong place.
- **Membership is checked before the upstream call**, so a non-member cannot
  spend the deployment's NLS quota or learn whether voice is configured.

**What this does and does not invalidate in §13.5/§13.6:**

- *Unaffected* — everything device-facing: `spk.rs`'s Opus framing, pacing and
  ctl timing, `chat_sink`, `note_sink`, `FanOutSink`, `SentenceChunker`,
  `mqtt_publisher`, and both provider traits. The vendor sits behind the trait.
- *Superseded* — `cosyvoice.rs` and `funasr.rs`, the two self-hosted clients.
  Keep them only if private deployment becomes a requirement.
- *Still needed, probably* — `resample.rs`. A hosted API may let us request
  16 kHz directly, but Opus only accepts 8/12/16/24/48 kHz and vendors commonly
  emit 22.05 or 44.1 kHz. Do not delete it before the real output rate is known.
- *Reinstated* — the §8.3 cost model. It was marked "largely moot" on the
  self-hosted premise; NLS bills per usage and this device streams whenever a
  button is held.

**amuxd side, and it has been run for real.** `SttBackend::AliyunNls` and
`TtsBackend::AliyunTts` are implemented (`voice/nls.rs` for the shared
envelope, `voice/aliyun_stt.rs`, `voice/aliyun_tts.rs`,
`voice/credentials.rs`). A console-issued token made it possible to exercise
the live gateway without an AccessKey pair, and the closed-loop test —
synthesise a sentence, Opus-encode it the way the device does, feed it back at
20 ms, transcribe — returns the sentence verbatim.

Three things the live run settled that no amount of local testing could:

1. **Audio before `TranscriptionStarted` is rejected outright**:
   `TaskFailed 40000002 Gateway:MESSAGE_INVALID:Invalid binary message while
   server state is 'ROUTING'`. The first implementation streamed frames as soon
   as it had sent `StartTranscription`, which on hardware would have failed
   *every* turn — mic frames arrive milliseconds after `turn_start`. Frames are
   now buffered across the handshake and flushed in order.
2. **`longxiaochun` is not an NLS voice.** It is a CosyVoice/DashScope name and
   the gateway answers `TtsClientError: Engine return error code: 418`. Working
   voices are `zhixiaobai`, `xiaoyun`, `siqi`, `aixia`; the default moved to
   `zhixiaobai` on both sides.
3. **16 kHz PCM comes back directly**, so `resample.rs` really is out of this
   path — measured, not assumed. It stays in the tree because the rate is a
   *request* and a future voice or vendor may not honour it.

Also observed: synthesis frames vary in size (8000 bytes typically, but 320 and
296 both appeared), which is why the PCM decode carries a straddling byte
rather than trusting alignment.

Live tests live in `voice::aliyun_{stt,tts}::live`, `#[ignore]`d because they
need a credential and spend vendor quota:

```sh
set -a; . deploy/self-host/.env; set +a
TEAMCLU_VOICE_APPKEY=$VOICE_NLS_APPKEY \
  cargo test -p amuxd --bin amuxd voice::aliyun -- --ignored --nocapture
```

**Still not run:** FC's `CreateToken` path. That needs an AccessKey pair, which
does not exist yet — the console token bypasses it. The signing is pinned
against Alibaba's documented worked example, which remains the strongest check
available without a key.

## 14. Audio path — written, unverified

Everything in `main/audio/` and the codec changes in `hal_audio.cpp` were
written while the device was unavailable. It compiles and is wired end to end;
none of it has produced a sound. The specific things to check first, in the
order they would fail:

1. **Does reopening the codec actually change the rate?** The ES8311 is opened
   at 44.1 kHz for the UI sounds, and Opus does not support 44.1 kHz at all —
   only 8/12/16/24/48 kHz. 44100→16000 is not an integer ratio, so it cannot be
   decimated cheaply. A turn therefore calls `esp_codec_dev_close` +
   `open(16000)` and restores 44.1 kHz afterwards. **The I2S channel's own clock
   is configured once at init** (`I2S_STD_CLK_DEFAULT_CONFIG(sample_rate)`), so
   if `esp_codec_dev_open` does not also reprogram it, capture will still be at
   44.1 kHz and everything downstream is garbage. This is the single largest
   unverified assumption in the audio path.
2. **Are back-to-back 20 ms reads gap-free?** `audioRecord` blocks on
   `esp_codec_dev_read` against an already-open device, so consecutive calls
   should come off one running DMA stream. If speech sounds clipped or
   time-compressed, this is why.
3. **CPU headroom for Opus at 16 kHz.** Complexity is set to 5 as a guess; the
   device is simultaneously driving LVGL. `plan §10 M2-8` wanted this measured
   and it still is not.
4. **Does close/open click?** A codec reconfigured twice per turn may pop.

`audio::stats()` counts captured / published / dropped frames and is logged at
`spk_end`, which is the cheapest way to tell whether frames flow at all without
a scope. Now that the daemon actually sends `spk_end` (§13.6), that log line
fires for the first time.

### 14.1 Downlink — what to check when the first reply plays

The daemon half is written and unit-tested but has never driven a speaker. In
the order these would fail:

1. **Is playback armed before the first frame?** `spk_start` must arrive before
   any `voice/spk` publish, because `onSpkFrame` drops everything while
   `g_playing` is false — the symptom is a clipped first syllable, or total
   silence if the ctl is lost. The daemon publishes ctl at QoS 1 and audio at
   QoS 0 specifically for this, and `spk_start` is only emitted once real audio
   exists. `framesDroppedRx` counts what got dropped.
2. **Is the sample rate right?** `CosyVoiceConfig::sample_rate` must match what
   the server really emits (24 kHz for CosyVoice2, 22.05 kHz for CosyVoice1).
   Wrong value = correct words at the wrong speed and pitch. This does not error
   anywhere and no test can catch it.
3. **Does pacing match consumption?** Frames go out at 20 ms intervals after a
   200 ms prebuffer. If the device underruns (choppy audio), the prebuffer is
   too small; if `framesDroppedRx` climbs, the HAL play queue is overflowing and
   it is too large.
4. **Does the face follow?** `thinking` → Think, `spk_start` → Speaking,
   `spk_end` → idle. A face that sits on Think while audio plays means the ctl
   topic is not being delivered even though `spk` is.

A `funasr-wss-server` and a CosyVoice fastapi server both still need deploying
before any of this can run at all.

## 16. Changelog — rev 4 → rev 5

Daemon-side only; no firmware changed and nothing new ran on hardware.

**Built:**

- `voice/tts.rs` — `TtsProvider` trait mirroring `SttProvider`, plus
  `SentenceChunker`, which turns per-character token deltas into sentence-sized
  synthesis requests.
- `voice/cosyvoice.rs` — local CosyVoice client. One HTTP request per sentence,
  streaming raw i16 PCM back, so sentence N+1 synthesises while N plays.
- `voice/resample.rs` — windowed-sinc streaming resampler. **Not in any earlier
  revision, and not optional:** CosyVoice emits 24 kHz and the device decodes
  16 kHz.
- `voice/spk.rs` — Opus 20 ms framing, paced publish to `voice/spk`, and the
  `session`/`thinking`/`spk_start`/`spk_end`/`error` ctl the firmware has been
  waiting for since rev 4.
- `chat_sink` now drives the downlink through a `ReplySpeaker` seam, and
  `VoiceRouter` cancels in-flight speech on `barge_in` and on a new `turn_start`.

**Decisions made:**

- TTS vendor: **CosyVoice local**, not Cartesia (§13.6). Same reasoning as
  FunASR over Deepgram, and no API key exists for either hosted option.
- Frames are **paced**, not blasted (§13.6). Barge-in is meaningless otherwise.
- `ReplySpeaker::begin` runs **before** `send_prompt`, and drops the
  subscription backlog. Either half wrong loses or duplicates the reply.

**Found while building:**

- The firmware's inbound ctl vocabulary already existed and the daemon was
  sending none of it. The face's Think-screen deadline means that was not a
  cosmetic gap: a working audio path with no `thinking`/`spk_start` would show
  an error and then talk over it.
- `teamclu_mqtt_rearchitecture.rs` pulled in all of `voice/mod.rs` for one type,
  so it broke the moment a module there reached for `crate::http`. Narrowed to
  the three files it actually needs. `--bin` builds never showed this;
  `--all-targets` did.

**Still not done:** M3-4 (note sink), deploying either server, and every
hardware verification in §14.

## 15. Changelog — rev 3 → rev 4

**Verified on hardware this round:**

- Face, provisioning portal, Wi-Fi, device token, MQTT connect, retained state
  and LWT — all confirmed from both the serial console and the broker.
- The `voice/ctl` uplink: `turn_start`/`turn_end` with the right intent,
  monotonic `seq`, exact 1:1 delivery between device and broker.
- Sleep tiers active→dim→screenoff→lightsleep, and wake.

**The bug that cost the most time, and why:** a `sys_evt` stack overflow. The
Wi-Fi event callback did NVS reads, base64, JSON parsing and MQTT client
startup on a 2304-byte task stack. The device associated, got an IP, then
rebooted — 27 times in one capture. Externally this looked *exactly* like a
flaky network, and several rounds were spent on the radio (country code, scan
method, power save, listen interval) before the crash was even visible. Fixed
by moving everything to `net::poll()` on the main loop, stripping the callback
to atomic flag writes, and raising the stack to 6144.

Three diagnostic traps made the crash invisible and are worth remembering:
- Capturing serial through `grep | tail` loses the buffer when the process is
  killed — and `grep` here is rewritten by a shell hook that swallowed even
  `-c` output. Log to a file, analyse with Python.
- **ELF SHA256 is not a build identity.** ESP-IDF embeds the compile time, so
  every rebuild changes the hash even with identical source. Comparing it
  produced a false "the device is running old firmware". Use the app
  descriptor's compile time.
- `Hard resetting via RTS pin` is a **no-op on this board**, so "flash
  succeeded" and "the new code is running" are different claims.

**Also this round:**

- Pairing reduced to a pasted long-lived JWT (§8.1), signed with a dedicated
  `DEVICE_MQTT_JWT_SECRET` and verified by a second EMQX authenticator added
  live via `emqx ctl conf load` — no restart, no client disconnected.
- The device `voice/ctl` protocol follows amuxd's shape, not this plan's
  original: **intent travels on `turn_start`, not on every mic frame**, so
  `voice/mic` stays pure Opus.
- A silent turn now reports `NoAgent` rather than faking a reply — but only when
  MQTT is actually connected. Unbound, the old placeholder timer still runs so
  the face stays demonstrable with no backend.
- Fixed in the daemon's new `voice` module: five integration-test binaries
  failed to compile because `mqtt::subscriber` references `crate::voice` and the
  test crate roots did not declare it. `cargo build` does not surface this.
- Fixed in `ctl_parse`: the scanner matched a field name anywhere, so
  `{"type":"session","session":"s-1"}` read the *value* of `type` as the key and
  silently dropped the session id.

## 13. Changelog — rev 2 → rev 3

Rev 2 was written before anyone looked at the hardware or the design canvas.

- **Board identified** (§0). Was rev 2's explicit Phase-B blocker. It is a
  shipping M5Stack product with a published pin map.
- **M5IOE1 discovered** (§0). Display reset, touch reset, speaker enable and the
  motor are behind a proprietary I²C expander with no ESP-IDF driver — the
  single biggest bring-up trap on this board.
- **MIT reference project found** (§2). Rev 2 costed the entire board HAL as
  net-new firmware. It is now vendored. This is the largest scope reduction in
  the plan's history.
- **Stack pinned to ESP-IDF 5.5 + LVGL 9.5 + M5GFX** (§1), matching the
  reference. Rev 2 named no GUI stack at all.
- **A second intent appeared** (§5). Rev 2 had one voice path; the canvas has
  two, and `note` has different plumbing (no TTS, offline queue, its own cost
  profile). Rev 2 under-scoped the device by a whole feature.
- **Screen count 5 → 10**, and the notes screen shows text (§5) — narrowing rev
  2's "no transcript ever" to the reply path only.
- **Canvas's `dev/{id}/…` topics rejected**; intent moved into the payload (§7).
- **Phase order re-cut into milestones** (§10), with milestone 1 partly done.
- **Font pipeline added** (§6.1) — rev 2 never mentioned text rendering, which
  turns out to be a real gap for a Chinese-first device.
- **Flashing needs a human** (§10, M1-6) — an operational fact rev 2 could not
  have known.

Unchanged from rev 2 and still true: the credential exchange is net-new and
blocking (§8.1); EMQX authorization does not exist and is cross-cutting (§8.2);
the transport correction (§8); the latency budget is unmeasured (§9); amuxd's
locality is a product constraint (§3.1).
