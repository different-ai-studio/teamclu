# ESP32 as ChannelDriver — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Design:** `docs/specs/2026-08-26-esp32-as-channel-design.md`
> **Branch:** `task/stopwatch-esp32-devi`

**Goal:** Fold the ESP32 voice terminal into the shared gateway core (`dedup → identity → route → command → write → turn → render`) so it gets cloud sessions, slash commands, interactive questions, and interrupt-not-queue semantics — without pushing Opus/STT/TTS into the kernel.

**Architecture:** Boundary is **final STT transcript in, text out**. `Esp32Listener` (narrowed `VoiceRouter`, daemon-side) builds `InboundMessage` and calls `CoreSink::accept`. `Esp32Driver` (gateway crate) owns `deliver`/`update` (TTS + ctl faces). Note intent bypasses the core and stays on `NoteSink`. Feature flag `[channels.esp32] use_core` (default `false`) forks after STT until cutover.

**Tech Stack:** Rust (`apps/daemon`, `crates/teamclu-gateway`), ESP-IDF C++ (`apps/esp32`), MQTT `voice/{mic,spk,ctl}`, Alibaba NLS STT/TTS.

**Known gaps vs design (must land in the named tasks):**

| Design ask | Today | Where fixed |
|---|---|---|
| Dedup key `esp32:{device}:{boot_id}:{seq}` | `seq` resets each boot; no `boot_id` | Phase 0 |
| `max_chars: 0` = no split | Cap field unused by core today; still document + guard | Task 1.2 |
| Queue depth 1 + cancel-in-flight | `SessionQueue` hardcodes `MAX_QUEUE_SIZE=5`, no cancel | Task 1.4–1.5 |
| Error ctl on `CoreError` | CoreSink only logs `Err` | Task 1.5 |
| Menu for `InteractiveQuestion` | Voice uses `PermissionPolicy::Full` to auto-cancel | Phase 3 |

**Out of this plan's first cut (Phase 4–5 later):** pairing codes / FC `/v1/devices/*`, deleting `ChatSink`, flipping `use_core` default.

---

## Phase −1: Land unrelated stability fixes first

Working tree currently has loudness + internal-RAM fixes in `apps/esp32/main/audio/voice_audio.cpp`, `hal/hal.h`, `hal/hal_audio.cpp` (PSRAM speaker queue, smaller playback stack, boot volume 100). Design §9.5: clear stability before architecture. Commit these **separately** before Phase 0 so failures are attributable.

### Task −1: Commit audio stability WIP

**Files:** already modified under `apps/esp32/main/`

**Step 1:** Review diff, then commit (only if user asks / as first commit of this plan execution):

```bash
git add apps/esp32/main/audio/voice_audio.cpp apps/esp32/main/hal/hal.h apps/esp32/main/hal/hal_audio.cpp
git commit -m "$(cat <<'EOF'
fix(esp32): free internal RAM for capture and restore full speaker volume

Speaker queue moves to PSRAM; playback stack shrinks to measured need so
capture can start. Boot volume ignores stale NVS 70 until a real control exists.
EOF
)"
```

---

## Phase 0: Firmware `boot_id` (must precede server dedup)

### Task 0.1: Generate and stamp `boot_id` on the device

**Files:**
- Modify: `apps/esp32/main/net/voice_ctl.h`
- Modify: `apps/esp32/main/net/voice_ctl.cpp`
- Modify: `apps/esp32/main/main.cpp` (or wherever net init runs — call once at boot)

**Step 1: Add boot_id storage + accessor**

In `voice_ctl.cpp`, after `g_seq`:

```cpp
// Random per-boot id (4 bytes → 8 hex chars). Combined with seq for amuxd
// dedup; seq alone resets on reboot (see voice_ctl.h comment).
std::atomic<std::uint32_t> g_boot_id{0};

void initBootId()
{
    std::uint32_t id = 0;
    // esp_fill_random is fine here; call once from net bring-up.
    esp_fill_random(&id, sizeof(id));
    if (id == 0) {
        id = 1;  // never publish 0; keeps "missing" distinguishable if needed
    }
    g_boot_id.store(id);
}
```

Expose `void initBootId();` and `std::uint32_t bootId();` in the header. Call `initBootId()` once when MQTT/net starts (same place seq is meaningful).

**Step 2: Put `boot_id` on `turn_start` only**

```cpp
bool sendTurnStart(face::Mode mode)
{
    char buf[160];
    std::snprintf(
        buf, sizeof(buf),
        R"({"type":"turn_start","intent":"%s","seq":%llu,"boot_id":"%08lx"})",
        mode == face::Mode::Chat ? "chat" : "note",
        static_cast<unsigned long long>(++g_seq),
        static_cast<unsigned long>(g_boot_id.load()));
    return publish(buf);
}
```

Do **not** require `boot_id` on every ctl — only `turn_start` feeds the dedup key.

**Step 3: Flash and verify**

On device log / MQTT inspect: `turn_start` JSON contains `"boot_id":"........"`. Reboot → new hex; `seq` restarts at 1.

**Step 4: Commit**

```bash
git add apps/esp32/main/net/voice_ctl.h apps/esp32/main/net/voice_ctl.cpp apps/esp32/main/main.cpp
git commit -m "$(cat <<'EOF'
feat(esp32): stamp per-boot id on turn_start for gateway dedup

seq alone resets across reboot; amuxd will key messages as
esp32:{device}:{boot_id}:{seq}.
EOF
)"
```

### Task 0.2: Parse `boot_id` in daemon ctl

**Files:**
- Modify: `apps/daemon/src/voice/ctl.rs`
- Test: same file `#[cfg(test)]`

**Step 1: Failing test**

```rust
#[test]
fn parses_boot_id_on_turn_start() {
    let v = VoiceCtl::parse(
        br#"{"type":"turn_start","intent":"chat","seq":1,"boot_id":"a1b2c3d4"}"#,
    )
    .unwrap();
    assert_eq!(v.boot_id.as_deref(), Some("a1b2c3d4"));
}

#[test]
fn boot_id_optional_for_old_firmware() {
    let v = VoiceCtl::parse(br#"{"type":"turn_start","intent":"chat","seq":1}"#).unwrap();
    assert!(v.boot_id.is_none());
}
```

**Step 2: Run**

```bash
cargo test -p amuxd --lib voice::ctl::tests -- --nocapture
```

Expected: FAIL (unknown field / missing field).

**Step 3: Add field**

```rust
/// Per-boot random id from the device (hex). Part of the gateway dedup key.
/// Absent on pre-migration firmware — caller must refuse core-path dedup
/// or fall back carefully (see Esp32Listener).
#[serde(default)]
pub boot_id: Option<String>,
```

**Step 4: Re-run tests — PASS. Commit.**

```bash
git commit -m "feat(daemon): parse voice ctl boot_id for ESP32 dedup keys"
```

---

## Phase 1: Inbound + driver skeleton behind `use_core`

Acceptance (design §8.1): `/help` answered on device; daemon restart keeps session; same `external_message_id` runs once. Downlink may stay one-shot `deliver` (no streaming yet).

### Task 1.1: Config — `[channels.esp32]`

**Files:**
- Modify: `apps/daemon/src/config/daemon_config.rs` (Channels struct + new type)
- Modify: `apps/daemon/src/config/team_config.rs` (load/save round-trip test)
- Modify: `apps/daemon/src/config/mod.rs` (re-export)

**Shape:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Esp32Channel {
    #[serde(default)]
    pub enabled: bool,
    /// When true, final chat transcripts go to CoreSink instead of ChatSink.
    /// Default false until Phase 1 acceptance (§5.8).
    #[serde(default)]
    pub use_core: bool,
    #[serde(default)]
    pub devices: Vec<Esp32DeviceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Esp32DeviceEntry {
    pub device_id: String,
    pub name: String,
    #[serde(default)]
    pub paired_at: Option<String>,
}
```

Wire into `Channels { ..., pub esp32: Option<Esp32Channel> }`. No secrets.

**Test:** toml round-trip with `use_core = true` and one device row.

**Commit:** `feat(daemon): add [channels.esp32] config with use_core flag`

### Task 1.2: `Esp32Driver` skeleton in gateway crate

**Files:**
- Create: `crates/teamclu-gateway/src/esp32.rs`
- Modify: `crates/teamclu-gateway/src/lib.rs` (`pub mod esp32;`)

**Driver (Phase 1: deliver speaks full text once; update is stub until Phase 2):**

```rust
pub struct Esp32Driver {
    // Injected from daemon: how to speak + publish ctl.
    // Keep trait objects here so the gateway crate stays free of MQTT/NLS.
    pub downlink: Arc<dyn Esp32Downlink>,
    pub team_id: String,
}

#[async_trait]
pub trait Esp32Downlink: Send + Sync {
    async fn speak(&self, device: &Esp32Target, text: &str) -> Result<(), DriverError>;
    async fn publish_ctl(&self, device: &Esp32Target, json: &str) -> Result<(), DriverError>;
}

pub struct Esp32Target {
    pub team_id: String,
    pub actor_id: String,   // conversation.id
    pub device_id: String,  // from reply_context or binding side-table — see below
}
```

`ChannelDriver` impl:

| Method | Return |
|---|---|
| `id` | `"esp32"` |
| `caps` | `streaming_edit: false` (Phase 1), `interactive: true`, `media_upload: false`, `threading: Inline`, `max_chars: 0`, `turn_timeout_secs: 60` |
| `binding` | `format!("esp32://{}/{id}", self.team_id, conversation.id)` |
| `sender_urn` | `format!("esp32:{}", sender.external_id)` |
| `session_title` | `format!("StopWatch {}", short_device(sender.external_id))` |
| `deliver` | if `msg.question.is_some()` → Phase 3; else speak `msg.text`; return `DeliveryId(device_turn_id)` |
| `update` | Phase 1: `Ok(())` no-op **or** Err until caps flip |

**`max_chars: 0`:** Core does not currently split on `max_chars` (field is advisory). Add a one-line comment on `ChannelCaps` that `0` means unlimited / no split, and a unit test on the driver that `caps().max_chars == 0`. If any future splitter is added, it must treat `0` as skip.

**Unit tests** with a `FakeDownlink` recording `speak` calls — mirror `FakeDriver` style in `apps/daemon/src/channels/core/tests.rs`.

**Commit:** `feat(gateway): add Esp32Driver skeleton (text deliver, no stream)`

### Task 1.3: Daemon downlink adapter

**Files:**
- Create: `apps/daemon/src/voice/esp32_downlink.rs` (or `channels/esp32_downlink.rs`)
- Modify: `apps/daemon/src/voice/mod.rs`

Wrap existing `SpeechSynthesizer` / `VoicePublisher` / ctl helpers so `Esp32Downlink` can:

1. Map `Esp32Target` → `DeviceKey { team_id, actor_id }`
2. Call synthesizer for full-text speak (reuse today's chat-path TTS)
3. Publish ctl JSON on the device's `voice/ctl` topic (`from: amuxd`)

**Commit:** `feat(daemon): adapt voice speaker/publisher as Esp32Downlink`

### Task 1.4: Interrupt-friendly accept path (no queue notices)

Design §5.3: depth 1, second press **cancels** current turn — never queue, never speak "排在第 N 位".

**Do not** change global `MAX_QUEUE_SIZE` for all channels.

**Approach (matches design §7.1):** handle at the listener, before `CoreSink::accept`:

1. Keep `active: Mutex<Option<ActiveEsp32Turn>>` on the listener (`session_id`, cancel handle).
2. On new chat final while active: `runtime.cancel(session_id, None)`, `downlink.cancel_speak(device)`, clear active, then `accept` the new message.
3. Construct `CoreSink` **or** a thin `Esp32CoreSink` that:
   - still uses `Core::handle`
   - **skips** queue notify texts (override `accept` to `tokio::spawn(process)` only when a turn is already running after cancel — or use a `SessionQueue` with `mpsc::channel(0)` / depth 0 so `try_send` → Full, then treat Full as "should have cancelled already")

Simplest honest Phase 1: **bypass `SessionQueue` for esp32** — `Esp32InboundSink` wraps `Core` + `Esp32Driver` and always `tokio::spawn(process)`, while the listener serialises by cancelling. Document why in the module rustdoc.

**Files:**
- Create: `apps/daemon/src/voice/esp32_sink.rs` (or under `channels/`)
- Test: cancel-then-accept ordering with fake runtime

**Commit:** `feat(daemon): ESP32 inbound sink cancels in-flight turn instead of queuing`

### Task 1.5: Map `CoreError` → device `error` ctl

**Files:**
- Modify: `apps/daemon/src/voice/esp32_sink.rs` (process outcome)
- Reference: design §5.5 table

On `Err(e)` after `core.handle`:

| `CoreError` | ctl `code` / face |
|---|---|
| Route / Identity / Write | `NoBroker` — 连不上服务器 |
| Turn | `NoAgent` — 电脑没醒着 |
| Render | `Upstream` — 它那边出错了 |

Publish via downlink. Never silent.

Also on successful accept start: listener already sent `thinking` (§5.4).

**Commit:** `feat(daemon): map CoreError to ESP32 error ctl faces`

### Task 1.6: Narrow `VoiceRouter` → listener fork after STT

**Files:**
- Modify: `apps/daemon/src/voice/adapter.rs`
- Modify: `apps/daemon/src/daemon/server.rs` (`spawn_voice_router`)
- Keep: `ChatSink` path when `!use_core`

**After final transcript for `Intent::Chat`:**

```rust
if use_core {
    // 1. publish thinking ctl immediately
    // 2. build InboundMessage (see below)
    // 3. esp32_sink.accept(msg).await
} else {
    chat_sink.on_final(...).await  // existing
}
```

`Intent::Note` → always `NoteSink` (design §7.3), both flags.

**`InboundMessage` construction (design §5.1):**

```rust
InboundMessage {
    conversation: Conversation {
        channel: "esp32",
        bot_id: None,
        kind: ConversationKind::Direct,
        id: actor_id.clone(),  // pairing product, not MAC
    },
    sender: ExternalSender {
        external_id: device_id.clone(),
        display_name: device_name,  // from roster or device_id
        email: None,
    },
    external_message_id: format!(
        "esp32:{device_id}:{boot_id}:{seq}"
    ),
    text: final_transcript,
    attachments: vec![],
    addressed_to_bot: true,
    quoted_text: None,
    // Carry device_id (and actor) so deliver can address MQTT topics
    reply_context: Some(format!("{team_id}/{actor_id}/{device_id}")),
}
```

If `boot_id` missing and `use_core`: log error, send device error ctl, **do not** accept (avoid false dedup collisions). Old firmware stays on `use_core = false`.

**Wire in `spawn_voice_router`:** read `config.channels.esp32`, build `Esp32Driver` + sink when `enabled`, pass `use_core` into router.

**Commit:** `feat(daemon): fork voice final transcript to CoreSink behind use_core`

### Task 1.7: Core-path tests (design §5.7)

**Files:**
- Create or extend: `apps/daemon/src/voice/esp32_core_tests.rs` (cfg test)
- Reuse: fake `SttProvider` / fake runtime patterns from `adapter.rs` / `chat_sink.rs`

**Minimum cases:**

1. Duplicate `external_message_id` → one turn only (`MemoryDedup`).
2. Second `turn_start` while busy → cancel previous, start new (not queued; no queue notice speak).
3. `Core::handle` `Err(Turn)` → device receives `NoAgent` error ctl.
4. Binding stable across "restart" (new sink, same store) → same session id.

**Run:**

```bash
cargo test -p amuxd --lib voice:: -- --nocapture
cargo test -p teamclu-gateway --lib esp32:: -- --nocapture
```

**Commit:** `test(daemon): ESP32 core-path dedup, interrupt, and error ctl`

### Task 1.8: Manual acceptance checklist (Phase 1)

With `[channels.esp32] enabled = true` and `use_core = true`, device on new firmware:

- [ ] Say `/help` → spoken help (CommandRunner path)
- [ ] Restart amuxd → next utterance continues same cloud session
- [ ] Replay same ctl seq+boot_id (or inject duplicate id in test) → one turn
- [ ] `use_core = false` still uses ChatSink (rollback)

No commit — note results in PR / chat.

---

## Phase 2: Streaming downlink

### Task 2.1: Move cursor + `SentenceChunker` into driver `update`

**Files:**
- Modify: `crates/teamclu-gateway/src/esp32.rs` — set `streaming_edit: true`
- Modify: downlink trait — `speak_delta(device, text_slice)`, `end_turn(device, TurnEnd)`
- Relocate / call: `apps/daemon/src/voice/tts.rs` `SentenceChunker` from synthesizer path used by ChatSink into driver-owned playback cursor (design §4.3)

Semantics:

```
deliver(text)                → cursor=0; speak sentence-complete prefix; advance
update(id, text, None)       → speak text[cursor..] sentence-complete; advance
update(id, text, Some(end))  → flush remainder; spk_end; TurnEnd::NoAnswer → error face
```

**Acceptance:** first-audio time ≤ today's ChatSink path (design §8.2).

**Commit:** `feat(esp32-channel): stream TTS via deliver/update cursor`

---

## Phase 3: Interactive menu (repay §1.1 tuition)

### Task 3.1: `menu` / `menu_reply` ctl + firmware UI

**Files (daemon):**
- `apps/daemon/src/voice/ctl.rs` — parse/build menu types
- Driver `deliver`: if `msg.question.is_some()`, speak **prompt only**, publish:

```json
{"type":"menu","question_id":"...","prompt":"...","options":["A","B","C"],"from":"amuxd"}
```

**Files (firmware):**
- `apps/esp32/main/net/ctl_parse.h` / face UI — list + encoder + KeyA
- Reply: `{"type":"menu_reply","question_id":"...","index":1,"seq":N,"boot_id":"..."}`

Listener maps `menu_reply` → `InboundMessage { text: options[index], ... }` with quoted/pending-question context as other channels do (`pending_question.rs`).

### Task 3.2: Drop voice `PermissionPolicy::Full`

**Files:**
- `apps/daemon/src/voice/chat_sink.rs` (and core-path session create)
- Remove auto-cancel of `question` once menu works

**Acceptance:** agent `question` tool shows menu; selecting an option completes the turn; session not stuck `SessionBusy`.

**Commit:** `feat(esp32): InteractiveQuestion as on-device menu; drop Full permission hack`

---

## Phase 4–5 (later plans — stub only)

Do **not** expand here until Phase 3 ships.

4. **Pairing:** FC `POST /v1/devices/pairing-codes` / `redeem` / `token`; provisioning page uses code; roster-only `[[channels.esp32.devices]]`.
5. **Cutover:** default `use_core = true`; one release later delete flag + `chat_sink.rs` memory map + Full-permission leftovers (design §10).

Open risks to revisit then: device 8s `AgentTimeoutMs` vs caps 60s (design §9.2); lightsleep / idle session bugs (§9.5).

---

## Execution order (checklist)

| # | Task | Depends |
|---|---|---|
| −1 | Commit audio stability WIP | — |
| 0.1 | Firmware `boot_id` | −1 optional |
| 0.2 | Parse `boot_id` | — (parallel with 0.1) |
| 1.1 | Config | — |
| 1.2 | Esp32Driver | — |
| 1.3 | Downlink adapter | 1.2 |
| 1.4 | Interrupt sink | 1.2 |
| 1.5 | Error mapping | 1.4 |
| 1.6 | Listener fork | 0.2, 1.1, 1.3–1.5 |
| 1.7 | Tests | 1.6 |
| 1.8 | Manual accept | 0.1 + 1.7 |
| 2.x | Streaming | Phase 1 green |
| 3.x | Menu | Phase 2 green |

---

## Commands cheat sheet

```bash
# Daemon / gateway unit tests
cargo test -p amuxd --lib voice:: -- --nocapture
cargo test -p teamclu-gateway --lib esp32:: -- --nocapture
cargo test -p amuxd --lib channels::core:: -- --nocapture

# Prefer repo wrappers when doing full check builds
pnpm rust:check
```

Firmware: follow existing `apps/esp32` flash workflow used on this branch (IDF 5.5).
