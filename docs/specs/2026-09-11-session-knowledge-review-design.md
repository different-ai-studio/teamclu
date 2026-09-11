# 会话结论审稿后写入知识库

- **Date**: 2026-09-11
- **Status**: APPROVED — slices 1–3 landed (`propose`/`publish`, review tab, header button). Slice 4 (block agent writes to `team-knowledge/`) is not in yet
- **Scope**: Desktop + amuxd。会话里整理结论 → 本机审稿 → 确认后写入团队 `knowledge/` vault
- **Non-scope**: 全员审批、每日自动打捞、「等待我」、iOS / Expo 写入、Ideas 打通、复用冲突解决页
- **Related**: ADR-0008、`docs/plans/2026-08-31-team-knowledge-base-program.md`、`docs/architecture/obsidian-compatible-knowledge.md`、`docs/specs/2026-09-01-team-sync-two-roots-design.md`、`apps/daemon/src/daemon/server/knowledge.rs`

---

## 0. 一句话

Agent 只能起草。人改完、选好路径、点写入，这篇东西才进入知识库。确认前 vault / Obsidian / 同步 / RAG 都看不见它。

## 1. 为什么现有 salvage 不够

`knowledge_salvage` 把草稿写到 `knowledge/00-salvage/`。那是同步前缀里的正式路径，一落盘就进团队 vault。聊天是过程，知识库是共识（ADR-0008）；未审摘要不能当共识。

`00-salvage/` 继续留给已经写进去的历史文件，**不再作为这条产品路径的草稿篮**。

## 2. 决策

| # | 决定 | 理由 |
|---|---|---|
| D1 | 审稿人是作者本人，在本机完成 | 一 user 一 team 一台 Desktop；不是全员审批 |
| D2 | 草稿放 `teams/<id>/state/knowledge-inbox/` | `state/` 本来就不进同步 |
| D3 | 确认后走现有写磁盘 + fs watcher | 和知识库里手建页同一条路 |
| D4 | 会话 agent 只暴露 `propose`，不暴露 `write` / `salvage` / `publish` | 否则审稿是摆设 |
| D5 | 普通 `write`/`edit` 落到 `team-knowledge/**` 必须拒绝或改写成 propose | 只靠 prompt 挡不住 |
| D6 | 不做 Ideas / 冲突解决复用 | 存储模型和语义都错 |

## 3. 信息流

```
会话（顶栏「整理到知识库」或对 agent 说「存知识库」）
        │
        ▼
   knowledge_propose → state/knowledge-inbox/<id>.json
        │
        ▼
   审稿 native tab（改标题 / 正文 / 落点）
        │
        ├── 丢弃 → 删 candidate
        ├── 稍后 → 留在 inbox；知识库列「待写入 · N」
        └── 写入 → knowledge_publish → knowledge/<path>.md → 打开编辑器
```

## 4. Candidate

```ts
type KnowledgeCandidate = {
  id: string
  teamId: string
  sessionId: string
  title: string
  body: string
  suggestedPath: string     // vault 相对，可空
  source: "session-header" | "agent-propose" | "message" | "unknown"
  createdAt: string         // ISO-8601
  status: "pending" | "published" | "discarded"
  publishedPath?: string
}
```

写入 vault 时由 publish 盖 frontmatter（正文以 `---` 开头则整页原样写入的规则不用于这条路径；publish 自己拼页）：

```yaml
---
type: page
source: session
session-id: <sessionId>
reviewed: YYYY-MM-DD
---
```

## 5. Daemon 动作

控制套接字仍是 `{ "cmd": "knowledge", "action": ... }`。

| action | 谁可调 | 写 vault？ |
|---|---|---|
| `propose` | 会话 agent + 桌面 | 否 |
| `inbox_list` / `inbox_get` / `inbox_discard` | 桌面 | 否 |
| `publish` | **仅桌面审稿页** | 是 |
| `search` | 会话 agent（只读，已有） | 否 |
| `write` / `create` / `salvage` | 会话里不暴露 | salvage 历史行为不变，不当产品入口 |

`publish` 规则：路径锁在 vault 内；无扩展名补 `.md`；目标已存在且 `overwrite != true` 则拒绝；成功后 candidate 标 `published`。

## 6. UI（后续切片）

- 会话顶栏，和「导出完整会话记录」并排：「整理到知识库」
- 新 native tab `knowledge-review:<id>`：来源会话、标题、知识库路径选择器、Markdown 正文、写入 / 稍后 / 丢弃
- 知识库第二列「待写入 · N」
- 不在文件树里画草稿

## 7. 切片

1. inbox + `propose` / `inbox_*` / `publish` ——确认前 vault 无新文件
2. 审稿 tab + 「待写入」
3. 会话顶栏入口（本机从消息拼草稿；模型摘要仍可走 `knowledge_propose`）
4. 接上 `knowledge_propose`，并拦住对 `team-knowledge/` 的 write

## 8. 验收

- propose 之后 `knowledge/` 下没有新文件，其他成员同步不到
- publish 后指定路径出现带 `session-id` + `reviewed` 的 `.md`
- 目标已存在且未覆盖 → 不写
- discard / 稍后 → vault 无变化
- agent 对 `team-knowledge/foo.md` 调用 write → 失败或变成 propose（切片 4）
