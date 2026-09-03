---
status: accepted
---

# 除 auth 外，一切前端状态默认窗口局部

多窗口下（`create_workspace_window` 开出的 workspace 窗口、local-agent 面板），
每个窗口有自己的 store 图和自己的 `MqttLiveWiring`。本 ADR 把这个隐含约定变成
显式规则：

- **默认：窗口局部。** 一个 store 的状态不承诺跨窗口一致，也不需要。
- **唯一的例外是 auth。** `lib/auth/session-store.ts` 用 `BroadcastChannel`
  （`session-store.ts:38`）跨窗口同步会话，因为「一个窗口登出、另一个窗口还拿着
  旧 token 打 API」是安全问题，不是体验问题。
- **今天所有被持久化的值都属于「偏好」，允许后写者赢**：走 zustand `persist()`
  中间件的 5 个是 `agent-default-workspace-store`、`agent-model-pick-store`、
  `automation-default-model`、`client-model-mru`、`offline-send-preference-store`；
  另有几个自己手写 `localStorage`（`header-preferences-store`、`git-settings`），
  性质相同。偏好被另一个窗口覆盖，代价是用户重新选一次。
- **新增 `localStorage` 写入点默认落在上面这条**：它是偏好，不是共享状态。
  如果一个值不能接受"后写者赢"，那它就不该在 localStorage 里。

规则写进 `AGENTS.md`，因为这是一条**别人写新代码时要遵守的约定**，不是一次性
改动。

## 为什么先写规则而不是先改代码

今天没有用户报告，因为多窗口用得少。这既是"不用急"的理由，也是"现在正是时候"的
理由——趁没有既成事实，先定下规则，比等到有人报 bug 再回头统一便宜得多。

而现状正在朝错误方向漂：审计当天（2026-09-02）数到 33 处
`localStorage.setItem`，今天是 **67 处**。翻倍的过程中没有任何人做过"这个值该不该
跨窗口一致"的判断，因为没有规则可依。规则的价值就在这里——它让下一个写
`localStorage.setItem` 的人必须先回答一个问题。

## 之后逐个评估，而不是一次性搬家

规则定下之后，对这些持久化的值逐个问：这个值真的需要设备一致吗？只有
答案为「是」的才做搬家（挪到 Rust 持有、以 emit 广播变更）。候选是三个：

- **当前团队** —— 两个窗口显示不同团队，用户几乎一定会误操作
- **agent 默认 workspace** —— 影响新会话落在哪
- **模型 MRU** —— 弱候选，不一致的代价只是多选一次

每挪一个都是一次小重构，收益要单独论证。**不要为了"统一"而全搬**。

## 考虑过的其它方案

**给每个 `persist()` store 加 `BroadcastChannel` 同步。** 实现简单，但它只解决
那 5 个 store，其余手写持久化和 67 处裸 `localStorage.setItem` 仍然各写各的——而且它把"跨窗口
一致"变成默认行为，等于在没有判断的情况下替所有值做了决定。方向反了：默认应该是
局部，一致性是要论证的例外。

**把所有共享状态挪到 Rust。** 是终局形态，但在没有任何用户报告的今天，它的成本
远大于收益，而且没有规则的话，挪完之后新代码还会继续往 localStorage 里写。
