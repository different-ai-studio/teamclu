# ESP32-S3 Voice Terminal — Implementation Plan

> **Branch:** `task/stopwatch-esp32-devi`
> **Status:** Rev 4 (2026-08-24). Device runs on hardware: face, provisioning,
> MQTT and the `voice/ctl` control plane are verified end to end. The audio path
> is written but **has never run** — see §14. §13/§15 are the changelogs.
>
> Rev 1 was written blind. Rev 2 corrected it against the live amuxd/EMQX
> stack. Rev 3 corrects it against the **actual hardware and the design
> canvas** — which turned out to change more than rev 2 did.

A pocket **voice terminal** for TeamClu on the **M5Stack Core StopWatch**.
Two gestures: hold the top-right button to *talk* (the agent answers out loud),
hold the bottom-right to *note* (it saves and says nothing). amuxd routes audio
through STT → pi → OpenAI → TTS.

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
| STT / TTS | Deepgram streaming / Cartesia Sonic | Low first-audio latency |
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
                      intent=chat ──────────────────────────┐
┌────────┐  MQTT/WSS  ┌──────┐  MQTT  ┌──────────────────────┴─────────────┐
│ ESP32  │ ─────────► │ EMQX │ ─────► │ amuxd voice adapter                │
│ Stop-  │ ◄───────── │cloud │ ◄───── │  ├─ STT (Deepgram, streaming)      │
│ Watch  │            └──────┘        │  ├─ prompt channel ─► pi ─► OpenAI │
└────────┘                            │  └─ TTS (Cartesia) ─► spk          │
                      intent=note ───►│  └─ transcript ─► session store    │
                                      └────────────────────────────────────┘
                                         (note never produces spk audio)
```

pi and OpenAI see only text, exactly as today.

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

Deepgram and Cartesia bill per streamed minute and this device streams whenever
a button is held. P0-4 must produce a per-active-minute cost and a monthly
projection before both vendors are committed. Note mode needs STT but **not**
TTS, so the two intents have different unit costs — worth modelling separately.

## 9. Latency budget — still a bet

| Hop | Estimate |
|---|---|
| Device → EMQX → amuxd | ~40–90 ms |
| Deepgram final after endpoint | ~100–200 ms |
| pi → OpenAI first token | ~300–600 ms |
| Cartesia first audio chunk | ~90–200 ms |
| amuxd → EMQX → device (incl. jitter buffer) | ~80–150 ms |
| **PTT-release → first audio** | **~600–1100 ms** |

Every figure is an estimate; none has been measured. P0-4 measures it with the
fake device, no hardware involved. **If the real number lands past ~1500 ms the
product thesis needs revisiting before more firmware is written.**

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
- **M3-1** amuxd voice adapter: device-scoped topics on `MessagePublisher`
- **M3-2** Deepgram streaming → partial + final transcripts
- **M3-3** `chat`: final transcript → `send_prompt` → pi → Cartesia → `spk`
- **M3-4** `note`: transcript → session message store, **no TTS**, no reply
- **M3-5** Offline note queue on device (NVS/FAT) + drain on reconnect + queue
  depth on the retained `state` topic
- **M3-6** Endpointing + barge-in state machine; QoS 1 flush on `ctl`
- **M3-7** Full GB2312 binfont for real note text (§6.1)

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
4. Deepgram language: fixed zh-CN vs auto-detect — M3-2
5. Cartesia voice id — M3-3
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
a scope.

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
