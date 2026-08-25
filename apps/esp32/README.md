# TeamClu StopWatch (ESP32-S3)

Firmware for the **M5Stack Core StopWatch** — the pocket voice terminal
described in `docs/plans/2026-08-24-esp32-voice-terminal.md`.

Hardware: ESP32-S3R8, 16 MB flash / 8 MB PSRAM, 1.75" round AMOLED 466×466
(CO5300, QSPI), CST820B touch, ES8311 codec + MEMS mic + AW8737A amp, BMI270
IMU, RX8130CE RTC, M5IOE1 I/O expander, M5PM1 PMIC, vibration motor, 450 mAh.

## Status — milestone 3

**Verified on hardware:**

- 10 face screens: idle / listen / think / reply / saving / saved / notes /
  wifi / sleep / error, with CJK text on the notes screen
- Two-button gesture model: hold-to-talk vs short-press, per button
- Haptics on PTT-grab, first-reply, note-saved, error
- RTC-driven clock and battery on the idle screen
- Wi-Fi provisioning (captive portal, device token typed in), MQTT over WSS,
  retained state + LWT
- The `voice/ctl` uplink: `turn_start` / `turn_end` round-trips 1:1 with the
  broker, monotonic `seq`

**Written but never run:** the entire audio path — capture, Opus encode,
playback, and the amuxd→device ctl markers (`thinking`, `spk_start`,
`spk_end`, `note_saved`). See §14 of the plan for what to check first, in the
order it would fail.

Builds clean on ESP-IDF 5.5 (2.3 MB, 55% of the app partition free) and the
host tests pass (`./test/run.sh`).

Not started: offline note queue (M3-6), device-side endpointing (M3-7), full
GB2312 binfont for arbitrary note text (M3-8), OTA.

## Layout

```
main/
  main.cpp        entry point; wires HAL <-> face, stubs the network hooks
  face/           ours — the interaction model
    face_state.*  state machine, pure C++ (no LVGL/IDF), host-testable
    face_ui.*     LVGL scene construction + animation
    palette.h     design tokens transcribed from the canvas
  hal/            vendored from M5Stack (see Attribution)
  apps/common/    minimal slice of the demo's shared code the HAL needs
  assets/         boot sfx + clock font
```

`face_state` deliberately knows nothing about rendering or hardware. Side
effects are injected as `face::Hooks`, which is where milestone 2 plugs in
without touching the interaction logic.

## Build

Requires ESP-IDF **5.5** (the vendored `sdkconfig.defaults` was generated on
5.5.4 and pins OCT-mode PSRAM).

```bash
# One-time: fetch the component repos listed in repos.json
python3 fetch_repos.py

# Every shell
. $IDF_PATH/export.sh

idf.py set-target esp32s3
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

`components/` is gitignored — `fetch_repos.py` populates it from `repos.json`
(M5GFX, LVGL 9.5, smooth_ui_toolkit, mooncake, M5IOE1, M5PM1, BMI270,
ArduinoJson) and applies the patches under `patches/`.

### Adding a source file

`main/CMakeLists.txt` uses `file(GLOB_RECURSE ...)`, which CMake evaluates at
**configure** time. A newly added `.cpp` is silently not compiled until CMake
reconfigures — and the failure surfaces as `undefined reference` at link time,
not as a missing file. After adding a source file:

```bash
touch main/CMakeLists.txt && idf.py build     # or: idf.py reconfigure
```

### Entering download mode

This board exposes the ESP32-S3's native USB Serial/JTAG (`0x303A:0x1001`) and
**does not reset into the bootloader on its own**. Every `--before` mode
(`default_reset`, `usb_reset`, `no_reset`) fails with `No serial data received`
until it is put into download mode by hand.

> **There is no BOOT button.** `G0` is on the rear 2.54 mm header, not a key.
> The only buttons are Power, KeyA (yellow) and KeyB (blue).

Procedure ([M5Stack docs](https://docs.m5stack.com/en/core/StopWatch)):

| Action | How |
|---|---|
| **Download mode** | USB-C connected, **press and hold Power ~2 s until the green LED lights**, then release |
| Power on / reset | short press Power once |
| Power off | press Power twice quickly |

After flashing, esptool prints `Hard resetting via RTS pin...` — **this does
nothing here**, because RTS is not wired to reset on a USB-Serial/JTAG-only
board. The device stays in download mode and the serial console stays silent.
Short-press Power to actually boot the new firmware.

## Fonts

The clock uses `CommissionerMedium108` (Latin digits, from the M5Stack demo).

The Chinese UI strings use a generated subset font:

```bash
./tools/gen_fonts.sh    # needs node; run ./fetch_repos.py first
```

It needs no download: the source face is the **Source Han Sans SC** (SIL OFL)
that LVGL already bundles at
`components/lvgl/scripts/built_in_font/SourceHanSansSC-Normal.otf`. Drop a TTF
at `tools/fonts/NotoSansSC-Medium.ttf` to override.

The glyph set is **extracted from the source**, not hand-maintained — the
script scans every string literal under `main/face`, `main/power` and
`main/main.cpp` for non-ASCII characters. Add a Chinese string, re-run, done.

`face_ui.cpp` selects it via `__has_include` and falls back to Montserrat if
absent, so the firmware builds either way.

> **Two silent traps the script now handles for you.** A `__has_include` that
> *misses* records no dependency edge, so generating the header later does not
> invalidate `face_ui.cpp.obj` — the stale object keeps its Montserrat
> fallback. And the CMake glob is evaluated at configure time, so the new `.c`
> files are not compiled until CMake re-runs. Both fail with a *successful
> build* that renders tofu, which is why `gen_fonts.sh` touches
> `face_ui.cpp` and `main/CMakeLists.txt` itself.

**Known gap:** this subset only covers the *fixed* strings. Real note text
(milestone 2, once STT exists) is arbitrary Chinese and cannot be subset ahead
of time. The intended fix is a full GB2312 binfont on the 4 MB `storage` FAT
partition loaded via `lv_binfont_create` — the partition and
`CONFIG_LV_USE_FS_STDIO` are already in place for it.

## Attribution

`main/hal/` and `main/apps/common/`, plus `partitions.csv`,
`sdkconfig.defaults`, `repos.json`, `fetch_repos.py` and `patches/`, are
derived from **[m5stack/M5StopWatch-UserDemo](https://github.com/m5stack/M5StopWatch-UserDemo)**,
MIT © 2026 M5Stack Technology CO LTD. `main/face/` and `main/main.cpp` are ours.

Removed from the upstream demo: its `apps/` (launcher, alarm clock, badge, FFT,
IMU, lucky wheel, setup); `hal/hal_badge.cpp`; and `hal/utils/config_ap/`.

> Note: `config_ap` is **not** a Wi-Fi provisioning portal despite the name —
> it is a badge-image *upload* portal and never collects Wi-Fi credentials. It
> was deleted along with its only consumer. Wi-Fi provisioning comes from the
> `78/esp-wifi-connect` component (`WifiConfigurationAp` / `SsidManager` /
> `WifiStation`). See plan §6.2.

## Design source

`StopWatch Agent.dc.html` in the Claude Design project *Stopwatch Agent 设备交互设计*.
Geometry and timing constants in `palette.h` are transcribed 1:1 from it — the
artboard's device screen is 466×466, the panel's native resolution, so nothing
is scaled. Re-transcribe rather than re-derive if the canvas changes.

### Known divergences from the canvas

- **Error screen** — the canvas has none. Added per plan rev2 §4, reusing the
  canvas's own shape vocabulary.
- **Sleep + PTT** — the canvas ignores A/B while asleep; plan rev2 §4 says
  "wake on PTT". The canvas wins for now; the guard is one `if` in
  `FaceState::onButtonDown`.
- **A short-press** — the canvas prototype toggles the reply screen (a preview
  affordance). The firmware implements what the canvas's own copy says:
  "短按打断朗读", i.e. interrupt playback.
- **MQTT topics** — the canvas shows `dev/{id}/audio`. The firmware will use
  `amux/{team}/{actor}/voice/…` so amuxd's existing routing applies. See plan
  rev2 §6.
