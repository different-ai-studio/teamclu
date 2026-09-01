# 团队同步：两个固定根（资料库 / 知识库）

- **Date**: 2026-09-01
- **Status**: DESIGN — 待评审后实现
- **Scope**: `apps/daemon/`（`config/`、`sync/oss/`）、`apps/desktop/`（`commands/oss_sync/`、`commands/obsidian.rs`）、`services/fc/`（`sync-path.ts`）、`packages/app/`（树、i18n、Obsidian 入口）、`services/supabase/migrations/`（ACL 的 CHECK 约束）
- **Extends**: `docs/specs/2026-08-31-knowledge-path-acl-design.md`（目录级权限）、`docs/adr/0008-knowledge-sync-p0-p1-scope.md`
- **Related**: `docs/architecture/obsidian-compatible-knowledge.md`

---

## 0. 一句话

同步内容根从 `shared/` 下移到 `shared/team-sync/`，下面固定两个目录：`documents`（资料库）和 `knowledge`（知识库）。**只有 documents 能设权限**，Obsidian 只认 knowledge，RAG 只索引 knowledge。

---

## 1. 目标

| # | 要求 | 落点 |
|---|------|------|
| 1 | 根目录固定为两个，不允许再加 | 三处 `ALLOWED_PREFIXES` + 根层不给新建入口（§4） |
| 2 | documents 可设权限，knowledge 不可 | UI 不给入口；**不加数据库硬约束**（§3 D3） |
| 3 | 两个目录显示为「资料库」/「知识库」 | 只在根层做映射（§6） |
| 4 | Obsidian 跟着 knowledge 而不是根 | vault 指向 `team-sync/knowledge`（§7） |

---

## 2. 今天长什么样

```
~/.amuxd[-<brand>]/teams/<team_id>/
├── shared/                     ← 同步内容根（sync_content_root）
│   ├── knowledge/              ← 唯一的 SHARED_PREFIX / ALLOWED_PREFIX
│   └── teamclu-team/           ← 团队链接目录，不同步，靠"别放进去"的纪律
└── state/                      ← daemon 私有；注释写着"必须待在 shared/ 外面"
```

三个事实决定了后面的设计：

| 事实 | 证据 |
|------|------|
| `shared/` 就是内容根 | `global_team_store.rs:76` `sync_content_root()` 返回 `team_shared_dir()` |
| 前缀白名单在**三个地方**各有一份 | `apps/daemon/src/sync/oss/path_validator.rs:8`、`apps/desktop/src/commands/oss_sync/path_validator.rs:7`、`services/fc/src/lib/sync-path.ts:11` |
| 扫描器只往白名单目录里走 | `scanner.rs:59` `for prefix in ALLOWED_PREFIXES` —— 根层的东西**根本不会被看到** |

---

## 3. 决策记录

### D1 — 结构：`shared/team-sync/{documents,knowledge}`

```
shared/
├── team-sync/                  ← 新的同步内容根
│   ├── documents/              ← 资料库，可设权限
│   └── knowledge/              ← 知识库，不设权限
├── teamclu-team/               ← 自动落在同步树外
└── team-knowledge              ← 同上（见下）
```

评审时提过「documents 挂在 knowledge 下面」（同步前缀一个字都不用改），被否：**「资料库在知识库里面」这个层级跟它要表达的并列关系是反的**，省下的几十行换一个要活很多年、每次看到都要在脑子里翻译一次的结构，不划算。

**下移内容根白捡三个好处**，都是把靠纪律维持的东西变成结构保证的：

1. `teamclu-team/` 自动在同步树外，不再需要「别放进去」。
2. `state/cloud` 的注释说它「**必须**待在 `shared/` 外面，否则扫描器会把它当内容推送，每次改动给所有人发墓碑」（`global_team_store.rs:84`）。下移之后这条自动成立。
3. `workspace_link.rs:51` 有一段守卫，专防「把 `shared/` 当 workspace 时，`team-knowledge` 符号链接被种进同步内容根里面」——注释原话是「the exact class of thing this guard exists to keep out」。下移之后 `shared/team-knowledge` 也在根外了。

### D2 — documents 与 knowledge 的区别：内容性质

- **documents（资料库）**：有归属的文件——合同、HR、财务。谁能看是**业务问题**。
- **knowledge（知识库）**：沉淀下来的共识。团队共有，不切分。

**这是编辑方针，不是技术约束。** 评审时明确否掉了「因为 agent 要保持一致所以 knowledge 不能分权」这个理由——那会导出一套硬规则。选定的理由更简单：这两类东西性质不同。

### D3 — 权限：UI 约定，不加数据库硬约束

`amuxc_path_acl` 的 CHECK 目前是 `path_prefix LIKE 'knowledge/%'`，要**放宽**到同时接受两个前缀。

不改成「只接受 `documents/%`」，因为 D2 的理由是编辑方针——**编辑方针不该用数据库约束来执行**。UI 不给 knowledge 的入口就够了；哪天真出现「这个知识库子目录确实敏感」的需求，不需要一次迁移才能满足。

硬约束在这里买到的很少，付出的是一扇焊死的门。

### D4 — agent：两个独立链接

workspace 里维持两个符号链接：

- `team-knowledge` → `shared/team-sync/knowledge`（已有，改指向）
- `team-documents` → `shared/team-sync/documents`（新增）

两个都给，但分开。**注意 agent 的权限在本地依然不可强制**——一台设备一棵树，跑在上面的 agent 看到的就是设备主人能看到的。这跟 ACL 设计里的 D2 是同一条结论，不是新问题：agent 继承设备主人，documents 的权限对 agent 天然生效，因为无权限的内容压根不在这台机器上。

### D5 — RAG 只索引 knowledge

documents **不进** RAG 索引。

技术上不会跨权限泄漏（索引建在本机，只包含这台机器上有的东西）。否掉的理由是别的：**同一个问题在不同人那里会给出不同答案，而用户看不见差异的来源**，他只会觉得「AI 有时候知道有时候不知道」。knowledge 全员一致，价值恰恰在这里。

真要让 documents 可检索，应该是**显式选范围**的形态，不是默默混进默认检索。

### D6 — 显示名：只在根层映射

磁盘上是 `documents` / `knowledge`（ASCII，稳定，跨平台安全）。界面在**树的根层**显示「资料库」/「知识库」。

不做任意层级映射：那会让 `documents/2026/knowledge/` 这种正常路径里冒出一个跟真知识库毫无关系的「知识库」——第一次见觉得聪明，第二次见开始怀疑自己。

### D7 — 非法根目录：不做 UI

**扫描器根本走不到根层**（`scanner.rs:59` 只遍历白名单目录），所以要做「标灰 + 提示」得额外加一次根目录遍历。

而改造后能造出非法根目录的途径几乎没有了：

| 途径 | 改造后 |
|------|--------|
| Obsidian | vault 指向 `knowledge/`，够不到父目录 |
| agent | 两个链接都指向目录内部，走链接出不去 |
| 我们的 UI | 根层不给「新建文件夹」入口 |
| 同步下发 | 三处白名单都拒 |
| Finder / 终端 | 能，但要手动摸进隐藏的 app-data 目录 |

剩下「刻意去戳」和「我们自己写了 bug」两种，为它们设计界面不成比例。

**折中**：`ensure_initialized` 启动时本来就要建目录，顺手对内容根做**一次 `read_dir`**（一个系统调用，不是遍历），发现预期外条目打一条日志。零 UI、零遍历，真出事诊断得出来。

### D8 — 兼容性：硬升级

不做兼容层。

**代价必须写清楚**：没升级的 daemon 在第一个 `documents/` 文件出现后**永久停止同步且不报错**。机制是 `engine.rs:228` 的 `validate(&item.path).map_err(SyncError::from)?` —— 注意是 `?` 不是 `continue`。`path_validator.rs:23` 的注释自己写着：

> ...把（本该继续同步的）那一个东西也拖下水。`SyncError::InvalidPath` 被归类为非瞬时错误，所以这个失败**永远不会自愈**。

用户侧的表现是「队友的笔记不再更新了」，没有报错、没有提示、重启不恢复。**这是它最难受的地方：不是坏得响，是坏得静。**

发布顺序上有一条天然的保护：FC 合并即自动部署，所以**服务端先放宽前缀、客户端后跟上**，方向是对的。

> **单独立项（不在本设计范围）**：让 daemon 遇到未知前缀时报一次**可见**的错，而不是静默中止。几行的事，但它改的是一条标着「防御恶意远端」的代码路径，需要把「前缀不认识」和「路径畸形（穿越、NUL）」拆开——只有前者可以降级为可见告警，后者必须照旧硬失败。

---

## 4. 三处白名单

| 位置 | 现在 | 改成 | 漏掉的表现 |
|------|------|------|-----------|
| `apps/daemon/src/sync/oss/path_validator.rs:8` | `["knowledge/"]` | `["documents/", "knowledge/"]` | daemon 拒绝拉取 documents，且**中止整个 manifest 应用** |
| `apps/desktop/src/commands/oss_sync/path_validator.rs:7` | 同上 | 同上 | 桌面端路径校验拒绝 |
| `services/fc/src/lib/sync-path.ts:11` | `['knowledge/']` | `['documents/', 'knowledge/']` | 服务端 422 拒绝上传 |

另外 `apps/daemon/src/config/global_team_store.rs:23` 的 `SHARED_PREFIXES` 从 `["knowledge"]` 改成 `["documents", "knowledge"]`（它负责 `ensure_initialized` 建目录）。

---

## 5. 搬迁 —— 本设计里唯一会删数据的地方

### 5.1 为什么危险

`sync_content_root` 从 `shared/` 变成 `shared/team-sync/`，而 **`state.json` 存在 `{meta}/sync/` —— 在内容根之外**（`state.rs:1`），所以它不会跟着变。于是：

1. state.json 里仍记着 `knowledge/foo.md`、`synced_version > 0`
2. 新根是空的，扫描什么都找不到
3. `locally_deleted_paths` 判定「在 state 里、不在扫描里」→ 全部成为墓碑候选
4. 推送阶段广播删除 → **全团队的知识库被清空**

**已确认没有任何批量删除闸门**：`MAX_NEW_FILES_PER_TICK` 只挡批量新增（还要用户确认），删除侧一个都没有。

叠加 D8 的硬升级——所有人同时翻，没有金丝雀。

### 5.2 怎么搬

**daemon 启动时、第一次 tick 之前，把 `shared/knowledge` 整个 rename 到 `shared/team-sync/knowledge`。**

- 文件到了新根期望的位置 → 扫描找得到 → 零墓碑
- manifest key 是根相对的 `knowledge/…`，**一个字都不用变** → 零重新下载
- state.json 依然有效 → 本地未推送的改动不丢

必须在第一次 tick **之前**完成。顺序错了就是 §5.1 那个后果。

### 5.3 无论如何都要加的闸门

**「一次 tick 广播删除超过 N 个文件就停下来问」。**

这条单独成立，不只为这次搬迁。今天它不存在，而它保护的是团队里**所有人**的数据，不只是操作者自己的。会触发它的场景不止一个：用户手滑把目录挪走、外置盘没挂上、Obsidian 的同步插件打架、以及这次的内容根移动。

形状对齐已有的 `MAX_NEW_FILES_PER_TICK`：达到阈值就整体不推、报给 UI、等用户确认。

---

## 6. 显示名

树的**根层**把 `documents` / `knowledge` 映射成「资料库」/「知识库」（i18n key，不是硬编码中文）。其余层级原样显示。

映射只发生在渲染层——磁盘、manifest、ACL 前缀、日志里**永远是 ASCII 名**。

---

## 7. Obsidian

vault 从「树根」改成明确指向 `shared/team-sync/knowledge`。

搬迁后：**重新注册新路径，并从 `obsidian.json` 里删掉我们自己写进去的旧条目**（`obsidian.rs:118` 已经在管这个文件）。留一个点了打不开的「知识库」在别人的 Obsidian 里，是那种小但每天膈应一次的东西。

---

## 8. 明确不做

- documents 进 RAG（D5）
- 任意层级的显示名映射（D6）
- 非法根目录的 UI 提示（D7）
- knowledge 权限的数据库硬约束（D3）
- 未知前缀的兼容层（D8，单独立项）
- 第三个根目录 —— 本设计的前提就是「固定两个」

---

## 9. 实施顺序

1. **批量删除闸门**（§5.3）。先做，它是后面所有步骤的安全网。
2. 三处 `ALLOWED_PREFIXES` + `SHARED_PREFIXES`（§4）。FC 先合并即部署，服务端先放宽。
3. daemon 的内容根下移 + 启动搬迁（§5.2）+ 启动时的 `read_dir` 日志（D7）。
4. workspace 链接：`team-knowledge` 改指向 + 新增 `team-documents`（D4）。
5. ACL 的 CHECK 约束放宽（D3）；UI 只对 documents 给权限入口。
6. 前端：树根上移、根层显示名映射（D6）、根层不给新建入口。
7. Obsidian 指向 + 旧条目清理（§7）。
8. RAG 索引范围限定在 knowledge（D5）。

### 验收

- [ ] 一台有内容的机器升级后：文件在新位置、**没有任何墓碑广播**、其他成员的知识库完好
- [ ] 批量删除闸门：人为制造大量删除时被拦下并报到 UI
- [ ] 三处白名单：`documents/x.md` 能上传、能下发、桌面端不拒
- [ ] 未升级的 daemon 在 documents 出现后的表现，与 D8 描述一致（确认我们知道它会怎么坏）
- [ ] Obsidian 打开的是 knowledge；旧 vault 条目已清除
- [ ] ACL：documents 能设、UI 不给 knowledge 入口、API 层面 knowledge 仍可设（D3）
- [ ] RAG 检索不返回 documents 里的内容
- [ ] 根层显示「资料库」/「知识库」，深层同名目录显示原名

---

## 10. 风险

1. **§5 的搬迁顺序错了 = 全团队数据丢失。** 本设计里唯一一个「写错了会删别人文件」的地方，实现时必须有测试覆盖「搬迁后没有墓碑候选」。
2. **D8 的静默停摆。** 已接受，但要确保支持侧知道这个症状长什么样：队友笔记不更新、无报错、重启无用 → 先问版本。
3. **三处白名单漏一处**，三种不同的坏法（§4 表）。
4. **ACL 与新前缀的交互**：CHECK 放宽后，`documents/` 的规则要走通与 `knowledge/` 完全相同的路径（manifest 过滤、按 hash 的下载可达性、审计）。这部分逻辑本身不变，但验收要覆盖新前缀。
