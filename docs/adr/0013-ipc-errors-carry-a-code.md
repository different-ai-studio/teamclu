---
status: accepted
---

# IPC 错误带一个稳定的 code，而不是靠子串匹配文案

引入一个跨 IPC 边界的错误形状：

```rust
pub struct CommandError {
    pub code: &'static str,        // 稳定标识，例如 "no_team_secret"
    pub message: String,           // 给人看的，可以随便改
    pub details: Option<Value>,    // 可选结构化上下文
}
```

配 `impl Serialize` 和 `impl From<String>`（`code = "unknown"`），让现存的
**510 个** `Result<_, String>` 可以**渐进**迁移而不是一次性重写；前端在 `invoke`
封装里统一解析。

第一批换码的对象是那些今天已经在被子串匹配的错误——它们是这条决定要解决的实际
问题，其余的可以一直挂着 `"unknown"`。

## 为什么

`apps/desktop/src` 里 510 个 `Result<_, String>`
（`grep -rE "Result<[^,]*, *String>" apps/desktop/src --include='*.rs'`，签字时重数；
审计当时是 430，这个数只会涨）、4 个 `thiserror` 枚举、**0 个错误码**。错误就是字符串，于是字符串就成了契约：

- `apps/desktop/src/commands/team_sync_proxy.rs:346` —— Rust 匹配 **daemon** 的
  文案 `contains("no OSS team secret")`，用来决定要不要重新投递团队密钥。
  daemon 那边改一次措辞，这条自愈路径静默失效，用户看到的是"同步失败"而没有任何
  线索说明本机其实存着密钥。
- `packages/app/src/lib/auth/extension-oauth.ts:52-55` —— JS 匹配 OAuth 提供方的
  英文文案（`"did not approve"`、`"canceled"`、`"cancelled"`、
  `"closed by the user"`）来区分"用户取消"和"真失败"。四个拼写并列本身就说明
  这个契约有多脆。

反例值得记下来，因为它已经是对的方向：
`packages/app/src/lib/telemetry/local-cache-error-report.ts:29-30` 匹配的是
**稳定 token** `local_cache: empty_team_id` / `local_cache: team_gate_mismatch`，
而且它们在 Rust 侧是具名常量
（`apps/desktop/src/local_cache/commands.rs:55`），注释明写「Matched as stable
tokens rather than prose so the two sides can't drift apart silently」。这条已经
不会静默漂移了——本 ADR 是把这个做法从"某个模块的好习惯"提升为整个 IPC 边界的
形状。

## 迁移顺序

1. `local_cache/commands.rs` 的两个 token → 真正的 `code`，前端消费方跟着换。
   这一步风险最低，因为两侧已经是稳定标识，只是形状换了。
2. `extension-oauth.ts` 匹配的取消/失败判定 —— 对应的 Rust 侧出错点换码。
3. `team_sync_proxy.rs:346` 匹配的是 **daemon** 的文案，要 daemon 先给错误码。
   属于 daemon 边界的后续任务，不在桌面端这条 ADR 的范围内，但它是这条决定最终
   要覆盖的目标。

## 考虑过的其它方案

**维持字符串，约定稳定前缀**（`E_NO_TEAM_SECRET: ...`）。便宜，而且
`local_cache` 已经在这么做了、确实有效。没选它的理由是：前缀就是新的子串匹配——
它靠所有人自觉不去改前缀，而没有任何机制能在改坏时报错。`code` 是一个字段，
删掉或改名会让编译或反序列化失败；前缀改错只会让一个 `if` 分支悄悄不再命中。

对 430 个返回点全部立刻迁移也不现实，所以 `From<String>` 的兜底
（`code = "unknown"`）是这个方案能落地的关键：它让"没迁移"是一个合法状态，而不是
一次性的大爆炸。
