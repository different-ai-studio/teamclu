# 权限裁剪的工具式知识检索（P0）

- **Date**: 2026-09-17
- **Status**: DRAFT — 第一期先打通检索，ACL / 多人门禁后补
- **Scope**: Desktop 会话 Agent。`teamclu-introspect` 两个只读工具、daemon `cmd: knowledge` 的 search/read、pi 文件工具拦截 `team-knowledge/` 与 `team-documents/`、会话 `knowledgeMode`、消息来源 metadata、Agent note 下来源卡片。
- **Non-scope**: FC 检索授权端点、多人会话使用受限知识、加人时的历史来源闸门、heading 切块与混合检索、向量索引、跨团队 catalog、Confluence/Drive 连接器、iOS / Expo 检索与点开原文、Cron / 网关无人值守检索、把资料库 `documents/` 纳入检索。
- **Extends**: `docs/specs/2026-09-11-session-knowledge-review-design.md` 切片 4（文件工具不得写 vault）——本设计把读也拦住，同一条边界。
- **Related**: `docs/specs/2026-08-31-knowledge-path-acl-design.md`（D2 本机一棵树、D7 不泄露受限前缀名）、`docs/plans/2026-08-31-team-knowledge-base-program.md` 附录 D、`apps/daemon/src/daemon/server/knowledge.rs`、`apps/daemon/src/daemon/server/knowledge/search.rs`、ADR-0012、ADR-0016、`docs/adr/0008-knowledge-sync-p0-p1-scope.md`

---

## 0. 一句话

Agent 需要团队知识时自己检索；少量片段进入模型。整库不得自动进上下文。

**第一期（进行中）：** 接通 `knowledge_search` / `knowledge_read`，让会话 Agent 能搜、能读、无命中时说不知道。Path ACL、人类参与者人数、加人检查、FC authorize **先不做**。

---

## 1. 为什么现在做

知识库已经能同步、能 ACL、能把会话结论审稿后写入。Daemon 也有无索引的中英文 substring 搜索。缺的是会话 Agent 真正用得上的读路径。

现状：

| 事实 | 证据 |
|---|---|
| `knowledge_search` 只存在于 manifest 和 `cmd: knowledge` | `apps/daemon/assets/knowledge-templates/mcp-manifest.json`、`knowledge/search.rs` |
| runtime 没有注册这套工具 | `teamclu-introspect` 的 `tool_definitions()` 里没有 knowledge；pi-extension 也不注册 |
| 没有受控的正文读取 | search 只返回 `path / title / snippet` |
| Agent 可以直接读软链 | `ensure_workspace_knowledge_link` 每次 workspace 激活都重建 `team-knowledge` |
| 本机所有 Agent 共用设备主人的树 | ACL 设计 D2 |
| 审稿设计要求拦住对 vault 的 write，尚未落地 | `2026-09-11-session-knowledge-review-design.md` 切片 4 |

不做「每轮把 vault 塞进 prompt」：注释里的真实规模是几百篇、约 1.2 MiB，全量进上下文既贵也没有会话级权限。也不做云端向量库：同一规模下全量扫描约几十毫秒，substring 对中文两字词已经可用。

---

## 2. 决策

| # | 决定 | 为什么不是另一个 |
|---|---|---|
| D1 | 两个只读工具：`knowledge_search`、`knowledge_read` | 搜索摘要和正文必须分开。search 的 snippet 若直接当答案来源，工具结果会进会话消息，权限裁剪来不及发生。 |
| D2 | 工具放现有 `teamclu-introspect`，经 control socket 调 daemon `cmd: knowledge` | 与 `send_channel_message` 同模式。不复活已退休的 `amuxd mcp-server`，不新增长驻 MCP 进程。 |
| D3 | 会话 Agent **只**暴露 search + read（外加已有的 `propose`）。不挂整份 `mcp-manifest.json` | manifest 里还有 `write` / `salvage` / `scaffold`。挂上去会把审稿设计 D4 拆掉。 |
| D4 | Agent 文件工具（read / write / edit / grep / glob / find / list / bash）不得碰 `team-knowledge/**`、`team-documents/**`，以及解析后落在团队 `shared/team-sync/{knowledge,documents}` 里的绝对路径 | 只靠 system prompt 不够。软链留给人和 Obsidian、文件树。写路径继续走 `propose`，不在文件工具里改写成 propose。 |
| D5 | P0 只检索 `knowledge/`，不检索 `documents/` | 资料库是有归属的文件；知识库是团队共识。ACL UI 也只给 documents。把 documents 纳入 RAG 是独立范围。文件工具对两边都拦，避免 Agent 改走资料库绕过。 |
| D6 | **第一期不做。** 人类参与者人数、Cron 拒绝、FC path ACL 交集留给后续 | 先让 vault 能被 Agent 搜到、读到。多人泄漏面仍在（search snippet 会进 tool result），后续再收。 |
| D7 | 会话级只有 `auto` / `off`。`@知识库` 是本轮覆盖，不做成第三种持久模式 | 「本轮使用」若存进会话，下一轮语义不清。自动/关闭才是会话偏好。 |
| D8 | `knowledgeMode` 落在 `amux.sessions.knowledge_mode`，经 Cloud API 同步。来源落在该轮 `agent_reply` 的云端 `metadata.knowledge`，不进 `parts_json`，不进 `localStorage` | 会话表今天没有 metadata jsonb；加专用列比发明通用 metadata 更干净。`parts_json` 是本机流式恢复。跨设备引用必须在消息 metadata。ADR-0012：不能容忍 last-writer-wins 的值不进 localStorage。 |
| D9 | 来源由 runtime 从本轮成功的 `knowledge_read` 结果收集，不靠模型在正文里抄 `sourceRef` | 模型漏引是常态。卡片是宿主契约，不是 prompt 礼貌。search 命中不算引用，read 过的才算。 |
| D10 | P0 不调 FC 做 path ACL 交集。本机 vault 已是主人的 ACL 视图 | 同步层已经不把无权文件放上这台机器。单人会话里「磁盘上有」=「这个主人能看」。多人授权、加人检查留给 P1。 |
| D11 | 第一版继续 substring 搜索。不建索引，更不把索引写进 `knowledge/` | 旧 FTS 写进 vault 后被同步给全队。将来若有索引，只许放 `teams/<id>/state/knowledge-index-v2/`。 |
| D12 | 不发明整数版本号。引用钉 `contentHash`（文件 UTF-8 字节的 sha256 hex） | 知识页没有 v12。同步层和 blob 用的就是 contentHash。卡片在 hash 变化时说「回答引用的是当时内容，当前文件已更新」。 |
| D13 | `sourceRef` 可解析、每次 read 都重验，不当能力令牌 | Agent 可以猜测 path。read 必须再次确认文件在 vault 内且本会话门禁仍通过。 |

---

## 3. 信息流

```
用户消息（会话 knowledgeMode=auto | off；本轮可带 @知识库）
        │
        ├─ off 且未 @知识库 ──► 不检索；工具若被调用则拒绝
        ├─ 人类参与者 ≠ 1 ────► 工具拒绝（P0 不检索）
        ▼
knowledge_search（本机 vault，substring，limit≤8）
        │
        ▼
knowledge_read（仅 vault 内已存在的 path；总字符硬限制）
        │
        ▼
模型根据 chunks 作答；不得把未 read 的 search 命中写成事实
        │
        ▼
turn_aggregator 把本轮成功 read 的来源写入 agent_reply.metadata.knowledge
        │
        ▼
UI 在 Agent note 正文下渲染「参考来源」卡片；点击打开 vault 文件并定位 heading
```

无匹配时工具返回空列表。Prompt 要求 Agent 明确说不知道，不编造条目。

---

## 4. 工具契约

两个工具加入 `teamclu-introspect` 的 `tool_definitions()`，并列入 `SESSION_SCOPED_MCP_TOOLS`（必须显式 `session_id`，与 `manage_participants` 相同）。实现走 `daemon_sock`：

```json
{ "cmd": "knowledge", "action": "search" | "read", "session_id": "...", ... }
```

不经过 desktop loopback 读文件。Cron 没有合格会话门禁，工具在 daemon 侧直接拒绝。

### 4.1 `knowledge_search`

```ts
knowledge_search({
  session_id: string,
  query: string,
  limit?: number,        // 默认 8，上限 8
  pathPrefix?: string    // vault 相对，禁止 '..' 与绝对路径
}) => {
  ok: true,
  results: Array<{
    sourceRef: string
    path: string          // vault 相对，posix 斜杠
    title: string
    heading: string | null
    snippet: string       // 纯文本，不含 <b>
    contentHash: string   // 当时整页 UTF-8 字节 sha256 hex
    updatedAt: string | null  // frontmatter `updated` 或 `last-verified`，没有则 null
  }>,
  vaultExists: boolean
  engine: "substring"
}
```

现有 `search` action 的返回形状对旧调用者保持：`path / title / snippet`（snippet 可继续带 `<b>`）。新字段和纯文本 snippet 由 **新的 introspect 工具** 适配，或 daemon 在 `action: "search"` 上**只增不改**地多返回 `sourceRef` / `contentHash` / `heading` / `snippetPlain`。禁止改掉现有 `snippet` 的 `<b>` 语义——那是 manifest 对已有调用者的承诺，即使今天没有运行时调用方。

`heading`：命中落在某个 ATX heading（`#`–`######`）之下则取该 heading 文本，否则 `null`。P0 不做切块索引，只在读到的整页上算一次。

排序维持现状：标题命中优先，然后 path。`last-verified` / `updated` / 页面类型不进 P0 排序。

### 4.2 `knowledge_read`

```ts
knowledge_read({
  session_id: string,
  sourceRefs: string[],  // 1..8
  maxChars?: number      // 默认 8000，硬上限 12000
}) => {
  ok: true,
  chunks: Array<{
    sourceRef: string
    path: string
    title: string
    heading: string | null
    content: string
    contentHash: string
  }>,
  omitted: Array<{ sourceRef: string, reason: "not_found" | "invalid_ref" | "budget" | "not_in_vault" }>
}
```

规则：

- 解析 `sourceRef`，path 必须落在当前团队 `shared/team-sync/knowledge/` 内（沿用 `resolve_in_vault`）。
- 文件不存在 → 该条进 `omitted`，不报整个工具失败。
- 有 heading 则取该 heading 到下一个同级或更高级 heading 的正文；没有则从正文开头取。
- 所有 chunk 的 `content` 字符数合计不得超过 `maxChars`。超出的条目进 `omitted.reason=budget`，已读的保留。
- 每次 read 现算 `contentHash`。与 search 时不同不视为错误，按当前字节返回，并把当前 hash 交给引用层。
- 只处理 UTF-8 文本（与现有 search 的 `read_to_string` 相同）。读失败的文件当 `not_found`。hash 是成功读出的那串 UTF-8 字节的 sha256，不是磁盘上可能存在的非 UTF-8 原文。

### 4.3 `sourceRef`

```
kb:v1:{teamId}:{percent-encode(path)}[#{percent-encode(heading)}]
```

- `teamId` 必须等于 daemon 当前团队，否则 `invalid_ref`。
- path / heading 用百分号编码，避免 path 里的 `#` 拆坏。
- 不含 contentHash。hash 是引用钉，不是身份。

### 4.4 门禁（每个 search/read 都做）

顺序：

1. daemon 已 onboard 到团队，否则 `no_team`。
2. `session_id` 能在 daemon 会话表里解析，否则 `unknown_session`。
3. `source=cron` 的会话 → `knowledge_unavailable`（「scheduled runs cannot retrieve team knowledge」）。
4. 人类参与者人数 ≠ 1 → 同一错误码。人类 = actor 不是 personal/role agent（沿用 `participant_is_agent` 的补集，含 `member` 与 `external`）。
5. 会话 `knowledge_mode=off` 且**开启本轮的那条用户消息**没有 `metadata.knowledge.requested=true` → `knowledge_disabled`。看的是当前 turn 的用户消息，不是会话里任何一次历史 `@知识库`。Daemon 从自己的会话消息里取这条，不信工具参数里的布尔值。
6. 通过后才读磁盘。

错误 JSON 与现有 knowledge handler 一致：`{ ok: false, error, errorCode }`。工具层把它变成 MCP `isError`。

`tools/list` 始终挂出这两个工具（introspect 的列表是进程级的，不能按会话裁）。关闭时靠第 5 步拒绝，prompt 也要求不要调用。

---

## 5. 文件工具拦截

落点：`apps/daemon/assets/pi-extension/teamclu.ts` 的 `tool_call` hook，**在**权限询问之前。命中则 `{ block: true, reason }`，reason 写明改用 `knowledge_search` / `knowledge_read`（写操作改用会话里的 propose / 顶栏「整理到知识库」）。

拦截的工具名：`read`、`write`、`edit`、`grep`、`glob`、`find`、`list`，以及 `bash`。

路径判定（任一为真则拦）：

- 参数里的 path / paths / target 相对 cwd 后，第一段是 `team-knowledge` 或 `team-documents`。
- `realpath`（或逐级解析软链）落在当前团队 `sync_content_root/{knowledge,documents}` 下。
- `bash`：command 字符串含 `team-knowledge`、`team-documents`，或含上述绝对根。这是尽力而为；主防线是专用文件工具。第三方 filesystem MCP 不在 P0 拦截范围，文档里写明。

不删除 workspace 软链。文件树、wiki link、Obsidian 继续走它们。

这同时关闭审稿设计切片 4：write 进 vault 会被同一 hook 拒绝，不会在文件工具里改写成 propose。

---

## 6. 会话与消息

### 6.1 会话 `knowledgeMode`

`amux.sessions` 增加列：

```sql
ALTER TABLE amux.sessions
  ADD COLUMN IF NOT EXISTS knowledge_mode text NOT NULL DEFAULT 'auto';

ALTER TABLE amux.sessions
  ADD CONSTRAINT sessions_knowledge_mode_check
  CHECK (knowledge_mode IN ('auto', 'off'));
```

只加列、带默认值、可重入。旧 daemon 不读这个列，行为不变（它们也没有知识工具）。符合 ADR-0016。

`GET` 会话返回 `knowledgeMode`。`PATCH /v1/sessions/{sessionId}` **只增**可选字段 `knowledgeMode`：`auto | off`。不接受其它 metadata 袋。

缺省 / `null` / 旧行 = `auto`。

Composer：输入条底部、Agent pill 一侧，一个低调按钮，**不用 coral**。两种状态：

- `知识库 · 自动`
- `知识库 · 关闭`

切换即 `patchSession`。失败时按钮回到上一次成功值，并 toast。

### 6.2 本轮 `@知识库`

Composer 提及 `@知识库`（或从 mention 列表选同一项）时，该条用户消息 metadata 增加：

```json
{ "knowledge": { "requested": true } }
```

这只覆盖**这一轮**：即使会话是 `off`，本轮工具门禁第 5 步放行。不改 `sessions.knowledge_mode`。

发送路径已有 `mention_actor_ids` 的 metadata 合并；这里是再并一个对象，不是换字段。

### 6.3 Agent 回复来源

`turn_aggregator` 在写入云端的那条 turn-final `agent_reply` 上，把本轮成功的 `knowledge_read` chunks 去重后写入 metadata。允许与现有 `turn_status` 并存（「新键可加，旧键不删」）：

```json
{
  "knowledge": {
    "mode": "auto",
    "requested": false,
    "sources": [
      {
        "sourceRef": "kb:v1:{teamId}:40-runbooks%2Fpayment-callback.md#%E5%9B%9E%E6%BB%9A%E6%AD%A5%E9%AA%A4",
        "path": "40-runbooks/payment-callback.md",
        "title": "支付回调故障处理",
        "heading": "回滚步骤",
        "contentHash": "…"
      }
    ]
  }
}
```

- `mode` 取该轮开始时的会话 `knowledgeMode`。
- `requested` 取触发该轮的用户消息是否带 `knowledge.requested`。
- 无成功 read → 不写 `sources`，或写 `sources: []`。没有卡片。
- 不要让模型把整段 chunk 再抄进 `content`；卡片是追溯，正文是答案。

用户消息的 `requested` 与助手消息的 `sources` 分工：前者是意愿，后者是实际用过的材料。

---

## 7. Prompt

沿用 pi-extension 已有的 `fetchSessionPromptAppend`。追加一段短指令，不把任何知识正文放进 system prompt。

`auto`：

> 团队知识在 Markdown vault 里。需要流程、口径、runbook、已记录的决策时，先 `knowledge_search` 再 `knowledge_read`。不要用 read/grep/bash 打开 `team-knowledge/` 或 `team-documents/`。只把 read 过的片段当事实；search 摘要不够。没有命中就说不知道，不要编造。

`off` 且本轮未 `@知识库`：说明本会话关闭了知识检索；不要调用这两个工具。

本轮 `requested`：在上面之外加一句：用户要求本轮查阅知识库，回答前必须 search（无命中则明确说没有）。

不在 P0 做自动 query rewrite 循环。模型可以自己再调一次 search。

---

## 8. UI

### 8.1 来源卡片

Agent note 正文下方，左对齐，与 note 同一 33px gutter。不用 coral。

```
参考来源 · 2
[支付回调故障处理 · 回滚步骤]  [渠道接入规范 · 超时策略]
```

- 纸色底、细边框、8px 圆角、`text-[12px]`。
- 无 heading 则只显示 title。
- 点击：打开该页在本机 vault 中的绝对路径（与知识列同一根，不要经 `team-knowledge` 软链再开一份，以免 wiki link 双 tab），并滚到对应 ATX heading。
- 当前文件 sha256 ≠ 引用 `contentHash`：卡片下一条 `text-faint` `text-[11.5px]`：「回答引用的是当时内容，当前文件已更新」。
- 本地没有该文件：卡片仍在，点击 toast「本地没有这份知识，等同步完成后再打开」。

iOS / Expo / 其它客户端：必须能解析未知 metadata 键（忽略即可）。P0 不要求它们画卡片或打开文件。

### 8.2 Composer 按钮视觉

`--panel` 底、`--border` 线、`--muted-foreground` 字。不要放在 coral 发送按钮上，也不要用品牌色表示「已开启」。知识检索不是未读，也不是主操作。

---

## 9. OpenAPI / FC / 数据库

P0 **不**新增 `/v1/teams/{teamId}/knowledge/retrieval/authorize`。那是 P1。

P0 要做的加法：

1. 迁移：`amux.sessions.knowledge_mode`，默认 `'auto'`。
2. OpenAPI：`Session.knowledgeMode`、`patchSession` 可选 `knowledgeMode`。
3. repository contract + `business-api` + `supabase-repo.patchSession` 读写该列。
4. 列出/详情/同步会话的映射带上该字段；旧库缺列的过渡不需要——迁移与 FC 同发。
5. 消息 `metadata` 仍是自由 jsonb。RFC 把 `knowledge` 对象形状写在这里，不单独建模 Message 子 schema，以免把现有自由 metadata 收窄。

Daemon 读 `knowledge_mode`：Cloud API `getSession` 已有的字段。本地会话缓存要带上，避免每轮打网。离线时：工具仍可 search/read 本机 vault；若缓存没有 mode，按 `auto`。关不掉离线会话的知识检索可以接受——关是 UX，单人磁盘视图仍是主人的。

---

## 10. 切片

| # | 范围 | 完成标准 |
|---|---|---|
| 1 | daemon `search` 只增字段；新 `read`；session 门禁 | 单人会话 search/read 有结果；双人/cron 拒绝；path 逃逸拒绝 |
| 2 | introspect 注册两工具，走 sock | `tools/list` 可见；`tools/call` 打到同一 handler |
| 3 | pi-extension 拦截 vault 读写 | `read team-knowledge/foo.md` 被 block；`knowledge_read` 仍可用 |
| 4 | `knowledge_mode` 列 + patch + Composer 自动/关闭 | 换设备后模式仍在；`off` 时工具拒绝 |
| 5 | `@知识库` 本轮覆盖 + prompt append | `off` + `@知识库` 本轮可检索；下一轮仍 off |
| 6 | turn_aggregator 打来源；note 下来源卡片；点开定位 | 只出现 read 过的来源；hash 变化有安静提示；无命中无卡片且回答认不知道 |

每片可单独 PR。3 必须不晚于 2 合入：只加工具不加拦截，等于教模型走更好用的泄漏路径。

---

## 11. 验收

P0 上线门禁：

1. 单人会话问一件 vault 里有的事：会 search、会 read、回答下来源卡片，点击打开对应 heading。
2. 同一句问一件 vault 里没有的事：空结果，回答明确说不知道，不编 path。
3. 会话里再加一个人类参与者之后，知识工具拒绝；已有卡片仍按历史 metadata 渲染（P0 不重写历史，也不在加人时分叉——那是 P1）。
4. `knowledgeMode=off`：不检索。`@知识库` 只让本轮恢复。
5. Agent `read` / `grep` / `bash cat` 指向 `team-knowledge/` 或真实 vault 根：被拒，提示用知识工具。
6. Agent `write` 指向同一棵树：被拒（审稿切片 4）。
7. 改知识页内容后，旧回答卡片提示内容已更新，仍打开当前文件。
8. 离线（Cloud API 不可达）：本机 vault 仍可 search/read；不写新的 FC 依赖。
9. 工具结果与来源只含 `knowledge/` 下的页；`documents/` 不进检索。
10. 不把索引文件写进 `knowledge/`。

明确不在 P0 验收：ACL 矩阵跨人、撤权后的云端拦截、未授权者看不见历史 tool result、混合检索指标。

### 已知限制（P0 故意留下）

单人会话里，`knowledge_search` 的 snippet 仍会作为 `agent_tool_result` 写入会话。这在「恰好 1 个人类」时可以接受。加人之后工具会拒绝**新的**检索，但**不会**改写或隐藏已经落库的 tool result 和来源卡片。P1 必须把「先授权路径再返回 snippet」和「加人检查 / 分叉」补上；P0 不得以「已经有来源卡片」为由宣称多人安全。

---

## 12. P1 起（本文不实施）

写在这里只为避免 P0 实现把后路堵死：

- `POST /v1/teams/{teamId}/knowledge/retrieval/authorize`：body 为 `sessionId` + candidate **paths**（不要把 contentHash 当授权输入）。FC 自己解析当前人类参与者，算 ACL 交集。客户端不准传 `actorIds`。
- 先授权路径集合，再返回 search snippet。Snippet 也是正文，不能先 search 再授权。
- 多人 MVP：只允许无 Path ACL 规则的公共 `knowledge/` 前缀。
- 会话用过受限知识之后再加人：检查历史 `metadata.knowledge.sources`；不满足则拒绝加入并要求分叉。
- 工具结果对未授权参与者不可见——卡片不是唯一泄漏面。
- heading 切块、新鲜度排序、`state/knowledge-index-v2/`、命中率/无结果率/引用点击率。

P0 的 `sourceRef`、消息 `metadata.knowledge.sources`、文件工具拦截，按上面的形状做，P1 才能接着用。
