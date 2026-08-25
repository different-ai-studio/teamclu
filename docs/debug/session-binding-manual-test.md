# Session Binding 手工验收 — accounting 环境

**环境**

| 项 | 值 |
|---|---|
| 启动方式 | `pnpm tauri:dev:daemon` |
| 团队 | `9159f762-bd35-40fe-a348-0ed2637c4986` |
| Agent actor | `e08fb571-4498-44db-a5cf-b20d0c10c6cb` (KFC / opencode) |
| Workspace | `e2d66039-dc54-4ccf-b869-8a5406183faf` |
| Cloud API | `https://copilot.accounting.i.test.shopee.io` |
| MQTT | `wss://copilot.accounting.i.test.shopee.io/mqtt` |
| HTTP | `http://127.0.0.1:{port}` — port 读 `~/.amuxd/run/amuxd.http.port` |
| Bindings 文件 | `~/.amuxd/teams/{team}/state/runtimes.toml` |

**Harness**

```bash
# Vitest 集成测试（推荐，需 daemon 已启动）
SESSION_BINDING_LIVE=1 pnpm --filter @teamclu/app exec vitest run src/lib/__tests__/session-binding-live.test.ts

# Rust 单元测试（TC-06/07，无需 live daemon）
node scripts/daemon-cargo.js test -p amuxd --bin amuxd config::session_store:: -- --quiet
node scripts/daemon-cargo.js test -p amuxd --bin amuxd session_resume:: -- --quiet
```

**Supabase MCP**：accounting MCP 仅暴露 `orgs/plans/users`，无 TeamClu `sessions` 表；会话/参与者以 Cloud API + 本地 `sessions/index.toml` 为准。

---

## 用例矩阵

| ID | 场景 | 操作 | 预期 | 结果 | 备注 |
|---|---|---|---|---|---|
| TC-00 | Daemon 存活 | `health` + `info` | healthz=ok，mqtt phase=Ready | ✅ | vitest |
| TC-01 | Binding 存在时可 resume | 对已有 binding 的 session `runtime-start` | accepted，runtime_id=session_id | ✅ | session `58969a79-...` |
| TC-02 | Detach 不删 binding | `runtime-stop`（无 purge）→ 查 runtimes.toml | binding 行仍在 | ✅ | count 未减 |
| TC-03 | 冷启动 resume | stop 后再 `runtime-start` | accepted | ✅ | ~1s |
| TC-04 | purge_binding 精确删除 | `runtime-stop --purge --workspace` | 对应行删除 | ✅ | disposable `41851d94-...` |
| TC-05 | purge 全 session | `runtime-stop --purge`（无 workspace） | 所有 binding 行删除 | ✅ | disposable `5f333f13-...` |
| TC-06 | reset_backend_binding | stale acp → NOT_RESUMABLE → reset | reset 换新 acp；NOT_RESUMABLE 见下方 | ⚠️ | live 验 reset；NOT_RESUMABLE 需 amuxd 重启后手测 |
| TC-07 | Legacy [[sessions]] 迁移 dedup | `cargo test load_legacy_sessions_alias` | 同键只保留最新 acp | ✅ | `config::session_store::` 6 tests |
| TC-08 | 非默认 agent_type 冷 resume | binding agent_type=2(opencode) | 冷 resume 成功且 agent_type 不变 | ✅ | vitest 读 TOML 断言 |
| TC-09 | idle eviction 后 binding 仍在 | detach（等同 idle sweeper）→ 再 start | binding 不变，resume 成功 | ✅ | 与 TC-02+03 同路径 |

**图例**：✅ 通过 · ❌ 失败 · ⏳ 待测 · ⚠️ 部分

---

## TC-06 NOT_RESUMABLE 手测（需 amuxd 重启）

运行中 daemon 的 SessionStore 在内存，**改磁盘 TOML 无效**。验证 `BACKEND_SESSION_NOT_RESUMABLE`：

1. 对测试 session `runtimeStart` → `runtimeStop`（detach）
2. 编辑 `runtimes.toml`，将该 session 的 `acp_session_id` 改为 `ses_INVALID_...`
3. **重启 amuxd**（或整个 `pnpm tauri:dev:daemon`）
4. `runtimeStart`（无 reset）→ 应返回 `error_code=BACKEND_SESSION_NOT_RESUMABLE`
5. `runtimeStart(reset_backend_binding=true)` → accepted，且 `acp_session_id` 更新

Desktop 客户端在收到 NOT_RESUMABLE 后会自动带 reset 重试（`session-create.ts`）。

---

## 执行记录

**2026-08-25 00:38–00:44** — 完整 vitest + rust 单元测试

| 用例 | 结果 |
|---|---|
| TC-00 | ✅ mqtt phase=Ready |
| TC-04 | ✅ purge+workspace 删除 1 行（`41851d94-...`） |
| TC-05 | ✅ purge 无 workspace 删除 session 全部 binding（`5f333f13-...`） |
| TC-06 live reset | ⚠️ daemon 在破坏性重启实验后需用户重启 `tauri:dev:daemon` |
| TC-06/07 rust | ✅ `config::session_store::` 6 passed；`session_resume::` 1 passed |
| TC-01–03 | ✅ 冷 resume / detach 保留 binding |
| TC-08 | ✅ binding agent_type=2，冷 resume accepted |
| TC-09 | ✅ detach 后 binding 不变 + resume 成功 |

**注意**：TC-06 的 amuxd kill 重启实验会打断 `tauri:dev:daemon` 托管的 sidecar，已改为安全的 live reset 测试 + 上述手测步骤。

**Supabase MCP**：accounting 实例无 `sessions` 表，会话数据以 Cloud API / 本地 `~/.amuxd/teams/.../state/sessions/` 为准。
