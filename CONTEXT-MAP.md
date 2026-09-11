# Context Map

TeamClu 是一个多端协同的 AI Agent 平台，本仓库划分为以下 bounded contexts。
每个 context 拥有自己的领域语言（`CONTEXT.md`）与本地架构决策（`docs/adr/`）。
跨 context 的共享术语和决策放在根 `docs/adr/`。

## Contexts

| Context | 路径 | 关注点 |
|---|---|---|
| desktop | `apps/desktop/`, `packages/app/` | Tauri 桌面端：UI、editor、chat、RAG、streaming、命令网关 |
| daemon | `apps/daemon/` | amuxd：ACP runtime、session/agent 生命周期、MQTT/Supabase 桥接 |
| ios | `apps/ios/` | iOS 客户端：Outbox、dedup key、SwiftData/libsql 同步 |
| mobile-rn | `apps/expo/` | React Native / Expo 客户端 |
| team-api | `services/fc/` | 容器化 Cloud API：team、member、budget、managed-git；同时管理用户 Apps 的 Alibaba FC runtime |
| data | `services/supabase/` | Supabase 数据层：schema、RLS、migrations |
| pocketbase | `services/pocketbase/` | PocketBase 持久化（daemon runtime） |
| proto | `proto/`, `crates/teamclu-proto/`, `crates/teamclu-types/`, `crates/teamclu-transport/` | 跨端共享 schema 与传输 |
| gateway | `crates/teamclu-gateway/` | 通道网关（neutralized supabase boundary） |

## 文件位置

- 每个 context 的 `CONTEXT.md` 放在其根目录下（懒创建 —— 出现第一个需要沉淀的术语时再建）
- 每个 context 的本地 ADR 放在其 `docs/adr/`
- 系统级 ADR（跨 context）放在仓库根 `docs/adr/`
