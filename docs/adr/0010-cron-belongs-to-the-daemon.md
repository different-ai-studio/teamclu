---
status: proposed
---

# 定时任务归 daemon，桌面端只剩 UI

`apps/desktop/src/commands/cron/`（6 个文件，3,531 行）整体搬到 amuxd。调度器、
任务存储、执行、投递都在 daemon 进程内；桌面端保留设置页 UI，通过 daemon 的
HTTP API 增删改查任务。任务存储按 layout-v2 归 team：
`~/.amuxd/teams/<id>/cron/`，不再是 `dirs::config_dir()/<brand>/cron-global`。

搬家的同时把那份**不存在的 spec** 补上：`commands/cron/amuxd_client.rs:10` 的
文件头引用 `docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md`，
这个文件在仓库里不存在（已核实）。

## 为什么

cron 的用户价值恰恰是「人不在的时候跑」，而人不在的时候桌面 app 大概率也不在。
今天的形态把这个价值和「app 得开着」绑死了：

- 调度器跑在桌面进程里。关掉 app，定时任务就不跑。
- 无头运行的 daemon（gateway 场景、服务器上的 amuxd）**永远没有定时能力**，
  因为调度器根本不在那个进程里。
- daemon 只执行回合——它的两条相关路由的注释明说是为桌面 cron 服务的。也就是说
  daemon 已经承担了最难的部分（跑完一整个 agent turn），却拿不到触发权。

存储位置也偏离了 layout-v2 的第一条：`commands/cron/mod.rs:81-84` 把全局任务放在
`dirs::config_dir()/<brand storage dir>/cron-global`，这个路径不在任何 layout 文档
里；workspace 任务按 workspace 路径做键。两者都不是 team-scoped，和 ADR-0006
（daemon 状态按 team 归属）对不上。

还有第三个 cron 面：`teamclu-introspect` 的 `/cron-run`
（`crates/teamclu-introspect/src/cron.rs:161`）让 agent 自己触发任务。三个面
并存的时候，「一个任务现在到底会不会跑」没有单一答案。

## 一条必须一起搬的约束

团队记忆里有一条不在审计报告里、但会决定实现对错的事实：**cron 触发的 agent
必须默认 full access**。无人值守，等审批就等于不跑。搬到 daemon 之后这条要显式
写进 daemon 侧的执行路径，不能指望桌面端的权限 UI 兜底——那时候没有 UI 在场。

## 考虑过的其它方案

**a. 桌面端继续持有。** 零成本，但上面三条问题一条都不解决，且三个 cron 面继续
并存。

**c. 云端调度**（Cloud API 定时触发 daemon）。多设备只跑一次的语义最自然——这是
b 解决不了的：两台机器各跑一个 amuxd，同一个 team 的任务会跑两遍。但它依赖网络，
离线场景直接丢掉，而「本机定时跑一件事」不该需要公网。

选 b，把 c 留作 b 之上的可选层：调度仍在 daemon，云端只做多设备去重。先 b 后 c
的顺序是对的，反过来（先做 c）会让离线用户从「app 开着就能跑」退化到「没网就不
跑」。

## 代价

3,531 行搬家，加一份从来没写过的 spec。桌面端因此少掉一个子系统——`commands/cron/`
整个目录，以及它牵连的 `amuxd_client.rs`（一个只为 cron 存在的 Unix socket /
命名管道客户端）。
