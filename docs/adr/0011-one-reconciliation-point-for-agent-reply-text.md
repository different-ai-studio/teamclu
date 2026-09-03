---
status: proposed
---

# agent 回复文本只有一个对账点

CLAUDE.md 的流式规则写着「完成阶段禁止取最长」，而
`lib/agent/agent-reply-text.ts:7` 的 `pickCanonicalAgentReplyText` 恰恰是
「等价则取较长」。这条例外**保留**，但收口成唯一出处：

- `pickCanonicalAgentReplyText` 只允许 `lib/agent/agent-reply-transcript.ts`
  import。
- 该模块对外只导出 `reconcileEquivalentAgentReplyText`
  （`agent-reply-transcript.ts:174`）和 `deriveAgentReplyContent`；
  `stores/v2-stream-parts.ts` 的 finalize 路径走前者。
- `lib/__tests__/agent-reply-single-reconciliation.test.ts` 扫 `src`，
  出现第四个 importer 就让构建失败。
- CLAUDE.md 的流式段落写明这条例外的出处和理由。

以上**已经实现**（#1227）。本 ADR 记的是它为什么是决定而不是权宜，以及下一步的
前提。

## 为什么保留「取最长」

代码里的理由成立，且是两条独立的事实：

1. MQTT QoS0 会丢包。工具调用之后的 delta 丢一段，客户端拼出来的文本就短一截。
2. daemon 的最终内容有时带尾巴——它不是 delta 的简单拼接。

所以「等价则取较长」不是偷懒，是在两个都可能不完整的来源之间做的取舍。真正的问题
从来不是这个规则本身，而是它当时**住在三处**（finalize、`deriveAgentReplyContent`、
以及后者内部的第二处调用），没有单一权威，类型层面拦不住第四处。收口之后行为
一字未变，变的是「这条例外只有一个出处，而且有测试守着」。

注意 `deriveAgentReplyContent` 同时喂两条路径：`streaming-persist.ts` 的持久化
content 和 `live-agent-stream.ts` 的实时气泡。这就是为什么它必须是**同一个**
函数——两条路径若各自对账，用户会看到气泡和落库内容不一致。

## 下一步：切到「daemon 最终内容为准」的前提

真正干净的终局是：daemon 最终内容存在时一律以它为准，delta 拼接只在它缺席时兜底。
那时 `pickCanonicalAgentReplyText` 整个删掉。切之前必须在 **daemon 侧**证实三件事：

1. 最终内容是否完整覆盖工具调用之后的文本；
2. 「尾巴」到底是什么——是 daemon 多加的，还是客户端少收的；
3. 能否在 daemon 侧把尾巴去掉。

若 daemon 内容确有缺失就切，用户会看到回复被截断——这是比「偶尔多一段」更糟的
失败模式。所以顺序是：先核实，后切。

## 明确没做的事

`stores/v2-streaming-store.ts` 里 delta 与最终内容共用同一个 `outputText` 字段
（16 处调用点散在 1,869 行里）。`docs/architecture/v2.md` 说这两者"必须"物理分离，
从未落地。它不是一个可以收口的改动，留给切到「daemon 为准」时一起做——那时候
分离是必然结果，而不是一次独立的重构。
