---
status: accepted
---

# pi 是唯一的本地 agent runtime

daemon 只运行 pi。`agents.local_agent`、`agent_discover`、`runtime_resolution` 的
四路分发、`create_backend()` 的工厂 match、设置页与首启向导里的 runtime 选择、
`build.config.localAgent`、doctor 里 opencode / cursor / claude 三行——全部删除
（#1250 删选择机制，#1247 删后端本体）。

`AgentType` 枚举**保留**：存量数据里到处是它（`agents.default_agent_type`、
`agent_types`、cron job、iOS / Expo 的 picker 值）。daemon 对任何非 `PI` 的
输入在 **一处**（`daemon/runtime_resolution.rs`）打一条 warn 后按 pi 跑，不拒绝——
拒绝等于让每个 `default_agent_type = 'opencode'`（今天的大多数）的 agent 在升级后
全挂。team.toml 里的 `local_agent` 读到即忽略、存盘时原样保留，给降级留路。

## 为什么

2026-09-04 owner 决定（#1247）。四个后端的代价是一个 17 参数的 `attach_session`、
四份命令循环、`runtime/` 里 14K 行随 copilot361 进来的 sidecar 代码，以及每个客户端
都在替 daemon 猜 agent_type 再被 daemon 用配置推翻。pi 已经具备单后端所需的全部
能力（多会话 host、MCP 桥、permission、AnswerQuestion、fork、team provider），缺的只
是把它从"四选一"变成"唯一"。

## 后果

- 存量 opencode 会话的 `backend_session_id` 没有 `pi:` 前缀，resume 时新开 pi 会话
  绑回同一个 TeamClu session：聊天记录在云端不丢，agent 的上下文记忆丢。
- 安装面变了：opencode 是单二进制，pi 需要 Node —— 见 ADR-0015。
- copilot361 的 cursor / claude 用户随本决定切到 pi。
