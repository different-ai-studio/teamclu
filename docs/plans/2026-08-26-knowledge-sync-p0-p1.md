# Knowledge sync P0/P1 Implementation Plan

> **For Claude:** implement task-by-task in the order below; each task ends in its
> own commit. Do not open PRs or push unless explicitly asked (CLAUDE.md).

**Goal:** Cut cross-member knowledge latency from ~10 minutes worst case (two
independent 300s timers) to ≤10s end-to-end quiet (fs watch → MQTT hint → pull),
keep Obsidian vaults clean (`.conflicts/`), and close the remaining abuse gap
(per-team byte quota)—without block-level sync, compression, prepare rate
limiting, or activity-stream UI.

**Architecture:** Keep the existing whole-file CAS engine (`amuxd` tick → FC
`/sync/*` → presigned blob store). Add a per-team **sync scheduler** in the daemon
with two inputs (local fs events, remote MQTT hints), a **hint-only** MQTT topic
published by FC once per successful batch call, and a server-side byte guard.
Content stays **server-readable plaintext**; MQTT payloads never carry paths.

**Tech Stack:** amuxd (Rust, rumqttc, notify), FC (`services/fc/src`), EMQX ACL
baked into JWT via `amux_access_token_hook` → `amux_acl_rules_for`,
`crates/teamclu-types` MQTT topic helpers, React Knowledge UI only where the
conflict path changes.

**Scope lock:** [`docs/adr/0008-knowledge-sync-p0-p1-scope.md`](../adr/0008-knowledge-sync-p0-p1-scope.md)

**Design sources (do not re-litigate):**

- [`docs/architecture/knowledge-sync-push-notify.md`](../architecture/knowledge-sync-push-notify.md)
- [`docs/architecture/obsidian-compatible-knowledge.md`](../architecture/obsidian-compatible-knowledge.md)

**Out of scope (freeze):** block/CDC sync, on-demand download, line merge,
activity-stream UI, mobile knowledge, upload compression, prepare rate limit,
rename-time `.md` completion, lengthening the 300s timer.

**Already landed (do not redo):** default `.md` on new notes (`3d6e8fd3`,
`packages/app/src/lib/knowledge-file-names.ts` `withDefaultExtension`), ignore
rules, 25 MiB / 2000-new-files gates, server path rejection, file-count quota,
app-side `watch_directory` refresh, MQTT auth-reject backoff (#1073).

---

## Phase map

Ordered by **risk, low → high**. Each phase is independently shippable.

| Phase | What | User-visible? |
|---|---|---|
| 0 | Narrative fix (plaintext, not E2E) — docs + `CLAUDE.md` | Docs only |
| A | `.conflicts/` sidecar directory | Yes (Obsidian hygiene) — **before or with B** |
| B | Daemon sync scheduler + knowledge fs watch | Yes (my edits go out in seconds) |
| C | Topic helper + FC per-call hint publish | No (nobody subscribed) |
| D | ACL migration `sync/+` | No (self-heals ≤1h after daemon ships) |
| E | Daemon `node_id` + optional subscribe + hint → scheduler | Yes (others' edits arrive in seconds) |
| F | Byte quota | Yes only when over limit |

C may go out any time after 0. D and E may ship in the same release **only
because** E's subscribe is tolerant (Task 8). F parallelizes with anything.

---

### Task 0: Correct security narrative in docs

> **Done on branch `docs/knowledge-sync-p0-p1-roadmap`:** ADR-0008, this plan,
> push-notify §5/§7/§8/§9/§11/§12/§13 rewrite, obsidian doc header + §2.1 + §5.2 +
> §5.3 + §6 + §8, root `CLAUDE.md` team-secret paragraph. Commit when asked.

**Files:**

- Create: `docs/adr/0008-knowledge-sync-p0-p1-scope.md`
- Create: `docs/plans/2026-08-26-knowledge-sync-p0-p1.md`
- Modify: `docs/architecture/knowledge-sync-push-notify.md`
- Modify: `docs/architecture/obsidian-compatible-knowledge.md`
- Modify: `CLAUDE.md` (the "team secret decides whether a team can sync" paragraph
  — `dispatch.rs:198-205` no longer requires a secret)

**Residue for the implementation PRs (grep already done, these are the only hits):**

- `packages/app/src/locales/{en,zh-CN}.json` `cloudVersion.unreadable` — drop the
  "…or encrypted with a team secret this device does not have" half (knowledge
  blobs are no longer encrypted on upload; `KnowledgeCloudVersion.tsx:201-206`).
- `apps/daemon/src/sync/oss/engine.rs:817-822` — `Stage 0: encrypt + hash` label
  and the `[oss_sync] encrypt {p}` warn are stale names; rename to hash/prepare.

**Commit** (when explicitly requested):

```bash
git add docs/adr/0008-knowledge-sync-p0-p1-scope.md \
  docs/plans/2026-08-26-knowledge-sync-p0-p1.md \
  docs/architecture/knowledge-sync-push-notify.md \
  docs/architecture/obsidian-compatible-knowledge.md \
  CLAUDE.md
git commit -m "$(cat <<'MSG'
docs: lock knowledge sync P0/P1 scope and fix E2E narrative

ADR-0008 freezes product scope after a code-verified grill; architecture
docs and CLAUDE.md stop claiming end-to-end encryption or a secret
precondition for knowledge sync (uploads are plaintext).
MSG
)"
```

---

### Task 1: Move conflict sidecars under `.conflicts/` (Phase A)

**Files:**

- Modify: `apps/daemon/src/sync/oss/conflict.rs` (`conflict_filename`,
  `original_from_conflict`, `conflict_timestamp` — path now mirrors the original's
  relative dir under `.conflicts/`)
- Modify: `apps/daemon/src/sync/oss/scanner.rs` — **hard-skip** the `.conflicts/`
  directory next to the existing `is_conflict_file` skip (not via `IgnoreRules`,
  so a team `.amuxignore` `!.conflicts/` cannot re-include it); `scan_conflict_files`
  walks `.conflicts/` instead of the whole tree
- Modify: pull path in `engine.rs` — skip any manifest entry under `.conflicts/`
  with `continue`, never `return Err` (§4.5 lesson)
- Modify: `apps/daemon/src/http/team_sync.rs` `conflict_entries` / resolve handler
  (sidecar path is now under `.conflicts/`)
- Modify: `packages/app/src/stores/team-conflicts.ts` — delete
  `isConflictSidecarName` (`.includes('.conflict.')` disagrees with the daemon's
  numeric-timestamp check and hides `merge.conflict.md`);
  `packages/app/src/lib/knowledge-tree-pruning.ts` prunes the `.conflicts/`
  directory instead; `KnowledgeConflictResolver.tsx` + tests still open both sides

**Layout (chosen in ADR):**

```text
knowledge/a/foo.md
knowledge/.conflicts/a/foo.conflict.<ts>.<hash>.md
```

**Step 1: Daemon unit tests** — new path ↔ original mapping (nested dirs, no
extension, CJK names); scanner never yields anything under `.conflicts/`; a team
rule `!.conflicts/` still does not re-include it.

**Step 2: Implement writer + readers.**

**Step 3: Legacy sidecars — move-on-scan.** Sidecars were never uploaded (scanner
skips them), so this is a local rename with no tombstone side effect: when the
scanner meets `<stem>.conflict.<ts>.<hash>[.<ext>]` beside a note, move it to the
mirrored `.conflicts/` path and continue.

**Step 4: Frontend tests** — tree hides `.conflicts/`, shows `merge.conflict.md`;
conflict tabs still resolve.

**Step 5: Commit** `fix(sync): store knowledge conflict sidecars under .conflicts/`

---

### Task 2: Per-team sync scheduler (Phase B, part 1)

**Files:**

- Create: `apps/daemon/src/sync/scheduler.rs` (pure logic, no I/O; driven by a
  clock trait so tests are deterministic)
- Modify: `apps/daemon/src/sync/dispatch.rs` — own one scheduler per team; the
  scheduler's "fire" calls `sync_team(team_id, TickOptions { force: false, allow_bulk_add: false, .. })`
- Do **not** touch `apps/daemon/src/sync/timer.rs` — the 300s timer and the
  manual `POST /v1/team/sync` (force) bypass the scheduler

**Semantics (ADR):**

- Inputs: `Trigger::Local` (fs event) and `Trigger::Remote { seq: i64 }` (hint).
- Coalescing window: first trigger opens a fixed **2s** window; further triggers
  inside it are merged; the window **never resets** (this is the "continuous
  writes still sync" property — a debounce fails it).
- Floor: earliest next tick = `last_tick_end + floor(kind)`, `Local` = 5s,
  `Remote` = 15s. When both kinds are pending, use the smaller floor. If the
  window closes before the floor, schedule at the floor, never drop.
- Floor is measured from the **end** of the previous tick (a slow tick must not
  queue the next one back-to-back).

**Step 1: Failing tests**

- quiet: one `Local` → fires at +2s
- burst: 50 triggers in 1.5s → exactly one fire
- continuous: a trigger every 500ms for 60s → fires at ~2s, then every 5s (not zero)
- floor: `Remote` right after a tick ends → fires at +15s, not +2s
- mixed pending: `Local` + `Remote` pending → floor 5s
- a tick that takes 20s → next fire ≥ 15s after it **ends**

**Step 2: Implement.**

**Step 3: Commit** `feat(sync): per-team coalescing scheduler for sync triggers`

---

### Task 3: Daemon fs watch on knowledge root (Phase B, part 2)

**Files:**

- Create: `apps/daemon/src/sync/watch.rs` — independent of
  `runtime/refresh_watch.rs` (that classifier feeds runtime refresh; do not add a
  Knowledge kind there). Copy its patterns: parent-dir watch for atomic saves,
  drop `EventKind::Access`, 2s reconcile loop for roots that appear later
  (team join / re-onboard).
- Root: `<content root>/knowledge` per team from `global_team_store`
- Reuse `IgnoreRules::is_ignored_with_ancestors` to **filter events** (it cannot
  limit `notify`'s recursive registration)
- Self-write suppression: the pull phase records the set of paths it wrote;
  events on those paths within **3s** are dropped. Not a time-window blanket
  suppression — a user's real edit during a pull must still schedule a tick.
- Failure mode: watcher creation error or runtime error → `warn!` **once**, stop
  watching that team, rely on the 300s timer. No retry loop.
- Wire: surviving events → `scheduler.trigger(team, Trigger::Local)`

**Step 1: Unit tests** — ignored subtree storm schedules nothing; pull-written
paths within 3s schedule nothing but a foreign path during the same pull does;
watcher error leaves the daemon running.

**Step 2: Implement spawn next to the sync timer** (`sync/timer.rs` neighbor).

**Step 3: Acceptance** — Obsidian save on A (TeamClu app closed) → push within
~2s window + tick; a `node_modules/` inside `knowledge/` does not crash the daemon
(Linux inotify limits) and the rest still syncs.

**Step 4: Commit** `feat(daemon): watch knowledge dir to trigger sync`

**Release gate:** Task 1 ships **before or with** Tasks 2–3 (ADR consequence).

---

### Task 4: Shared MQTT topic helper (Phase C, part 1)

**Files:**

- Modify: `crates/teamclu-types/src/mqtt.rs` — `Topics::sync(resource)` +
  free `sync_topic(team_id, resource)`; extend `shared_topic_functions_match_wire_paths`
- Mirror: `services/fc/src/lib/mqtt-topics.ts` (create) + unit test on the literal
- Swift mirror (`apps/ios/.../MQTTTopics.swift`) is **not** required now — iOS has
  no knowledge sync; parity is by convention (each side asserts its own literal)

**Step 1: Failing test** — `sync_topic("TEAM", "knowledge") == "amux/TEAM/sync/knowledge"`.
Resource segment **last** (`sync/+` ACL forever).

**Step 2: Implement. Step 3: Commit** `feat(mqtt): add amux/<team>/sync/<resource> topic helper`

---

### Task 5: FC publishes one hint per successful batch call (Phase C, part 2)

**Files:**

- Modify: `services/fc/src/lib/sync-handlers.ts` — after `handleSyncUploadCompleteBatch`
  and the delete-batch handler have processed their items, publish **once** with
  the highest `changeSeq` among the successful items (single-item complete/delete
  publish too — that path is only reached by old daemons)
- Publish via the existing `createMqttPublisher` singleton
  (`services/fc/src/lib/mqtt-client.ts`, wired in `push-deps.ts`)
- Test: `services/fc/test/` — one batch of N completes → exactly one publish;
  payload `{ v: 1, changeSeq, originNodeId, at }`; **no** `path`; publish failure or
  missing `MQTT_BROKER_URL` does not change the HTTP result

**Rules:**

- **No coalescing timer.** The daemon already batches 200 per call, so a tick
  produces ≤10 hints (2000-new-file gate). A timer would also be unreliable on the
  Alibaba FC target (frozen instance after response).
- `await` the publish with a **500ms** timeout; on timeout `warn!` and still
  return 200 — the hint is best-effort, the 300s timer is the fallback.
- `originNodeId` = the request body's `nodeId` (one caller per call, no ambiguity);
  `null` when absent.
- QoS 1, **not** retain.
- FC's service token has no `acl` claim and EMQX has no authz source, so the
  publish side needs **no** ACL change.

**Step 1: Failing test. Step 2: Implement. Step 3: `cd services/fc && npm test`.**

**Step 4: Commit** `feat(fc): broadcast knowledge sync hints per batch call`

**Step 5: Deploy/observe (ops)** — `mosquitto_sub` on `amux/+/sync/knowledge`
confirms messages and payload shape. No daemon subscribe yet → zero user risk.

---

### Task 6: ACL migration for `sync/+` (Phase D)

**Files:**

- Create: `services/supabase/migrations/YYYYMMDDHHMMSS_acl_sync_topic.sql`
- Modify: `public.amux_acl_rules_for` (current definition:
  `20260706120000_member_sub_own_rpc_req.sql`)
- pgTAP test following the existing ACL pattern

**Step 1: Write migration** — for **both** `member` and `agent`:

```sql
('sub', format('amux/%s/sync/+', p_team))
```

**Step 2: Migration comment states the facts:**

- ACL is baked into the JWT by `amux_access_token_hook`; existing connections keep
  their old claim until the token rotates (3600s) — the daemon rebuilds its MQTT
  connection 5 min before expiry, so **≤1h** after this migration every daemon can
  subscribe.
- Because Task 8's subscribe is tolerant, shipping this migration and the daemon
  in the same release is acceptable; "migrate first" is advice, not a gate.
- The Postgres/Better-Auth backend mints no `acl` claim and the all-in-one image
  runs NanoMQ without ACL — this migration only matters on the Supabase backend;
  do not validate it against all-in-one.

**Step 3: Commit** `fix(db): allow sub amux/<team>/sync/+ for member and agent`

---

### Task 7: Daemon passes `daemon_device_id` as upload `node_id` (Phase E, part 1)

**Files:**

- Modify: `apps/daemon/src/sync/oss/engine.rs` — `engine.rs:837` (`PrepareBatchItem`),
  `:1186` (`DeleteBatchItem`), `:1316-1323` (`upload_prepare`), `:1409` (`delete_file`)
  all pass `None` today
- Read: `apps/daemon/src/device_id.rs:47` `daemon_device_id()`
- Test: prepare/delete payload contains `nodeId == daemon_device_id()`

**Verify at implement time:** whether the daemon updates its server high-water
seq from its own `complete-batch` response or only from manifest pulls. If only
from pulls, the echo filter in Task 8 is what prevents a wasted tick after every
own push — not just an optimization.

**Step 1: Failing test. Step 2: Plumb. Step 3: Commit**
`fix(daemon): set created_by_node_id on knowledge uploads`

---

### Task 8: Optional subscribe + hint → scheduler (Phase E, part 2)

**Files:**

- Modify: `apps/daemon/src/mqtt/supervisor.rs` — `MqttCommand::Subscribe` gains
  `optional: bool` (or a sibling `SubscribeOptional`); tracked subscriptions carry
  the flag; on SUBACK failure for an optional topic: `warn!` once, **no**
  `forced_rebuild`, **no** `PublisherError::Unavailable` escalation; the restore
  loop after CONNACK (`supervisor.rs:1624-1634`, `:1717-1746`) applies the same rule
- Modify: `apps/daemon/src/daemon/server.rs` `mqtt_resubscribe_after_connack`
  (`:886-915`) — subscribe `amux/<team>/sync/+` as optional, never `return Err` for it
- Modify: `apps/daemon/src/mqtt/subscriber.rs` `parse_frame` — new family:
  4 segments, `parts[2] == "sync"`, `parts[3]` = resource; unknown resource → ignore
- Modify: `apps/daemon/src/sync/dispatch.rs` — on accepted hint:
  drop if `originNodeId == daemon_device_id()`; drop if `changeSeq <= high-water`;
  drop unknown `v` (warn once); else `scheduler.trigger(team, Trigger::Remote { seq })`
- Test: parse tests; filter tests; supervisor test that a rejected optional
  subscribe does not schedule a rebuild while a rejected required one still does

**Retry cadence:** optional subscribes are retried only on the next (re)connect —
token rotation guarantees one within 1h. No dedicated timer.

**Manual / integration checklist (ADR + push-notify §12):**

1. A saves in Obsidian → B sees it in Obsidian within ≤10s (Tasks 2–3 + 5 + 8 all live)
2. A pushes 2000 files in one tick → ≤10 hints, not 2000
3. A does not re-tick on its own echo once `nodeId` is set
4. Kill EMQX → sync continues on the 300s timer; daemon logs warn; **no worker
   rebuild loop** beyond the existing 5→30s backoff; RPC recovers when EMQX returns
5. Daemon with a **pre-migration token** → `sync/+` denied → one warn, worker not
   rebuilt, RPC/session-live unaffected; subscribe succeeds after rotation (≤1h)
6. Broker capture: payload has no paths
7. 10 people editing for an hour → each device ticks ≤ `3600/15` from remote hints
8. Continuous typing in Obsidian for 10 min on A → A ticks ≤ `600/5`, B keeps
   receiving throughout (coalesce, not debounce)
9. A pull that writes 50 files does not trigger a second local tick on the receiver

**Commit** `feat(daemon): pull knowledge on MQTT sync hints`

---

### Task 9: Per-team byte quota (Phase F)

**Files:**

- Modify: `services/fc/src/lib/sync-guards.ts` — `maxBytesPerTeam()` (env
  `SYNC_MAX_BYTES_PER_TEAM`, default `2 * 1024 ** 3`), `liveByteSum(teamId, sumBytes)`
  with the same "cannot establish → `null` → allow" policy as the file count
- Modify: `services/fc/src/lib/sync-handlers.ts` — `handleSyncUploadPrepareBatch`
  fetches the live sum **once per batch call** and keeps a running total across
  the batch; the item that crosses the line and every item after it get 422
  `{ code: 'QuotaExceeded', kind: 'bytes' }`. Single prepare: `sum + size`.
  **Charge only new paths (`parentVersion === 0`), and only after the item
  succeeded.** An edit's old bytes are already inside the sum, so charging its
  full size double-counts the file and refuses writes a team is nowhere near its
  limit; a rejected item never becomes bytes at all. The bounded under-count
  (growth on an edit goes uncharged until the next call re-reads the sum) is the
  right direction for this guard — see ADR-0008 P1 #1.
- Migration: partial covering index for the sum —
  `(team_id) INCLUDE (size) WHERE deleted = false`. Without it the aggregate
  heap-fetches every live row on the write path, up to 10× per tick per device.
- Repository: `sum(size)` over live files on both backends — pg-repo via drizzle,
  Supabase via a new RPC `amux.amuxc_team_live_bytes(team_id)` (migration)
- Env: declare in `deploy/self-host/docker-compose.yml` (fc `environment:`, indent 6),
  `services/fc/s.yaml` (`environmentVariables:`, indent 8), `.env.example` —
  `deploy-env-parity.test.ts` also requires the source to actually read it
- Test: `services/fc/test/sync-guards.test.ts` + handler test for the batch running total

**Not disk protection:** physical usage also holds historical version blobs;
reclaiming them is `amux.oss_sync_gc_orphan_blobs()` on the FC cron, which lives
under the compose `cron` profile that self-host does not enable. Enabling it is an
**ops ticket outside this plan** (watch for the drizzle `search_path` failure noted
in memory). Until it is closed, do not describe the quota as disk protection.

**Step 1: Failing tests** — over-quota single prepare → 422; batch that crosses at
item k → items ≥ k rejected, < k accepted; sum failure → allow.

**Step 2: RPC + guard + env parity.**

**Step 3: Commit** `feat(fc): enforce per-team knowledge byte quota`

---

### Task 10: Final verification checklist

Run (docs/daemon/FC as applicable in the executing worktree — **no cargo in
parallel worktrees**; use the `rust:*` wrappers):

- [ ] ADR-0008 matches shipped behavior
- [ ] No docs or locale strings claim knowledge encryption / E2E
- [ ] MQTT payload fixtures contain no paths
- [ ] Optional-subscribe rejection does not rebuild the worker (regression test)
- [ ] Obsidian: conflict files invisible under `.conflicts/`; `merge.conflict.md` visible
- [ ] Timer still 300s; manual Sync Now still bypasses the scheduler
- [ ] `SYNC_MAX_BYTES_PER_TEAM` on **both** compose and `s.yaml` and `.env.example`
- [ ] Freeze items untouched (no block store, no compression writer, no activity UI,
      no prepare rate limit, no rename `.md` completion)

**Stop.** Do not lengthen the timer here. Do not start P2/P3.

---

## Suggested PR slicing

1. Docs + ADR + `CLAUDE.md` (Task 0) — this branch ships alone
2. `.conflicts/` (Task 1)
3. Scheduler + fs watch (Tasks 2–3) — **after or with** PR 2
4. Topic helper + FC per-call publish (Tasks 4–5)
5. ACL migration (Task 6)
6. Daemon nodeId + optional subscribe + hint wiring (Tasks 7–8)
7. Byte quota (Task 9)

## Open knobs (do not block implementation)

- Floors 5s (local) / 15s (remote) and the 2s window are hardcoded starting
  points; tune in a follow-up PR with tick-rate data from Task 8's checklist #7–8
- `SYNC_MAX_BYTES_PER_TEAM` default 2 GiB — revisit once the GC ticket is closed
  and real team sizes are known
