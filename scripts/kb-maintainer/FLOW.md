# kb-maintainer 流程

把团队 `documents/` 白名单中的原文，在本机沙箱编译成互相链接的 Wiki 页；只有通过确定性校验的批次，才会发布到 `knowledge/wiki/`。

人维护的 `knowledge/30-decisions/`、`40-runbooks/` 等目录完全不碰。

产品交互是两下：

1. **检查并编译**（prepare）— 只改本机工作区，不写知识库
2. **确认发布**（publish）— 通过校验后，才覆盖 `knowledge/wiki/`，再触发团队同步

设计原文见 [`docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md`](../../docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md)。想看**一份文件从原文变成知识库页面**的中间产物，读 [`WALKTHROUGH.md`](WALKTHROUGH.md)。

---

## 1. 总览

```mermaid
flowchart TB
  subgraph Product["产品：维护 Wiki"]
    A[勾选 documents/ 资料目录] --> B[检查并编译<br/>prepare]
    B --> C{摘要 canPublish?}
    C -->|否：红字 blockers| A
    C -->|是| D[确认发布<br/>publish]
    D --> E[knowledge/wiki/<br/>团队可检索]
  end

  subgraph Trees["三棵目录，互不混写"]
    T1["documents/<br/>原文 · 人改 / 同步"]
    T2["本机工作区 kb-maintainer/team/<br/>raw + wiki.git + state<br/>Agent 只许改这里的 wiki/"]
    T3["knowledge/wiki/<br/>已发布产物 · 只有发布脚本写"]
  end

  B -.-> T1
  B -.-> T2
  D -.-> T2
  D --> T3
```

| 位置 | 角色 | 谁能写 |
| --- | --- | --- |
| `documents/` | 原文（删除资料就是删这里） | 人 / 团队同步 |
| 本机工作区 `kb-maintainer/<team>/` | 沙箱：`raw/` 抽取稿 + `wiki/` Git 库 + `state.json` | 维护器 + 编译 Agent |
| `knowledge/wiki/` | 已发布、全团队可检索的 Wiki | **只有发布脚本** |

桌面端工作区实际落在：

```text
~/Library/Application Support/teamclu/kb-maintainer/<team-id>/
├── raw/                 # 标准化原文，Agent 只读
├── wiki/                # 待发布 Wiki，本地 Git
├── state/state.json     # 增量状态
└── config.json          # 本次运行的白名单与节点 id
```

Agent **永远不直接写**知识库。编译在沙箱里完成，发布脚本才拷到 vault。

---

## 2. 「检查并编译」全链路

```mermaid
flowchart TB
  START([用户点击 检查并编译]) --> ACL

  subgraph S1["① 发现与门禁 · 不调模型"]
    ACL[拉团队 ACL] -->|受限目录 ∩ 白名单| STOP1([整批拒绝])
    ACL --> KNOWN[listKnown + 本地磁盘]
    KNOWN --> FETCH{路径状态?}
    FETCH -->|本地没有且从未导入| DL[daemon fetch 下载]
    FETCH -->|已导入但磁盘没了| DELQ[进入 delete 撤回队列<br/>禁止重新拉回]
    FETCH -->|磁盘上还在| KEEP[进入 add/update/unchanged]
    DL --> PLAN
    DELQ --> PLAN
    KEEP --> PLAN
    PLAN[dry-run 对账]
  end

  PLAN --> EST[③ 视觉费用估算]
  EST --> INGEST

  subgraph S4["④ 逐份 ingest · 串行 · 一份一个干净 Pi 会话"]
    INGEST[队列: add → update → delete] --> ONE
    ONE[处理一份资料] --> TX{Git 事务}
  end

  TX --> GC[孤儿页清理]
  GC --> LINT[⑤ 批次 lint]
  LINT --> SUM[⑥ 摘要回 UI]
  SUM --> END1([仍不写知识库])
```

进度事件顺序：`plan` → `estimate` → `ingest`（带当前文件）→ `lint` → `done`。

---

## 3. 每一份资料的 Git 事务

```mermaid
flowchart TB
  SRC[一份 documents 文件] --> EX[抽取 → raw/<br/>带 source-locator 注释]
  EX --> SNAP[记下 beforeCommit]
  SNAP --> PI[Pi 会话 cwd = 工作区 wiki/<br/>工具仅 read/write/edit/find]
  PI --> WRITE[模型改 pages/*.md 和 index.md]
  WRITE --> IDX[程序 rebuildIndex]
  IDX --> GATE{单来源校验}

  GATE -->|通过| COMMIT[git commit<br/>state.sources 标 imported]
  GATE -->|失败| ROLL[git reset --hard beforeCommit<br/>记 failures 继续下一份]

  COMMIT --> NEXT[下一份]
  ROLL --> NEXT
```

Pi 只能用 read / write / edit / find，不能 bash，不能碰 `raw/`、`state/`、真正的知识库。程序不相信模型说「导入成功」，只看 Git diff + 校验结果。

模型约定：

1. 先读 `index.md`
2. 能更新已有主题页就更新
3. 没有等价页才新建
4. 页与页用 Wiki Link 连起来
5. 每个事实带来源路径、sha256、locator（能在 raw 里对上）

---

## 4. 单来源校验（失败就整笔丢掉）

```mermaid
flowchart LR
  V1[只能改 pages/ 和 index.md] --> V2[frontmatter 可解析]
  V2 --> V3["链接必须是 [[pages/slug]]<br/>且目标存在或本轮同创"]
  V3 --> V4[index 每页一次<br/>摘要 = 页内 summary 逐字相同]
  V4 --> V5[locator 能在 raw 里找到]
  V5 --> V6[无 PII / 复制比过高 / 超页数]
```

实现入口：`scripts/kb-maintainer/validator.js` 的 `validateSourceDiff`。

---

## 5. 批次 lint 与发布

全部单来源事务完成后：

- 清掉「页还在、资料已删」的孤儿引用
- 全库死链、index 漏页/重复
- frontmatter 来源必须仍在当前 `state.sources`
- 确定性错误挡住发布；语义警告不挡

```mermaid
flowchart TB
  P0([用户确认发布]) --> P1[再跑一遍批次 lint]
  P1 -->|不过| PSTOP([拒绝发布])
  P1 -->|过| P2{首次发布?<br/>state 无 publishedCommit}
  P2 -->|是| P3[接管已有 knowledge/wiki/<br/>按目标树写入并删多余旧页]
  P2 -->|否| P4{vault tree == 上次发布 commit?}
  P4 -->|被外部改过| PSTOP
  P4 -->|一致| P5[按 Git diff 原子写入]
  P3 --> P6[校验 tree hash]
  P5 --> P6
  P6 --> P7[写 publishedCommit]
  P7 --> P8[团队同步 force_sync<br/>不允许无人值守 bulk 增删]
  P8 --> P9([synced 或 sync_pending])
```

发布脚本是 `knowledge/wiki/` 的唯一写者。同步失败不会撤回本机已经发布的页面，但状态标为 `published_local_sync_pending`。

---

## 6. 对账队列

```mermaid
flowchart TB
  DISK[磁盘 documents/ 实文件] --> UNION
  STATE[state.json 上次成功导入] --> UNION
  KNOWN[云端 known 清单] --> UNION
  UNION[并集] --> Q

  subgraph Q["四类队列"]
    ADD[add 新资料]
    UPD[update 哈希变了]
    DEL[delete 磁盘没了]
    UNC[unchanged 跳过模型]
  end
```

- **add / update**：抽取 + 调模型 + 单来源校验
- **delete**：按 `affectedPages` 撤回；页上还有其它有效来源则重编，否则删页
- **unchanged**：不调模型
- 已导入但磁盘缺失的路径，不得再被 known 清单复活成 download

---

## 7. 代码入口

| 步骤 | 入口 |
| --- | --- |
| UI 两下点击 | `packages/app/src/components/teamshare/WikiMaintainerRunSheet.tsx` |
| 前端 prepare / publish | `packages/app/src/lib/knowledge/wiki-maintainer-client.ts` |
| Tauri 编排、进度、网关 | `apps/desktop/src/commands/kb_maintainer.rs` |
| Node 编排 | `scripts/kb-maintainer/desktop-runner.js` |
| 对账 | `dry-run.js` + `reconcile.js` |
| 单来源事务 | `ingest.js` |
| Pi 编译 | `pi-runner.js` + `wiki-jail.js` |
| 单来源 / 批次校验 | `validator.js` / `lint.js` |
| 发布 | `publish.js` |
