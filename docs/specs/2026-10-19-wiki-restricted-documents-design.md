# Wiki 编译跳过受限资料

- **Date**: 2026-10-19
- **Status**: DRAFT — 待评审
- **Scope**: Wiki 维护器（`scripts/kb-maintainer`）和桌面端触发流程（`packages/app/src/lib/knowledge/wiki-maintainer-client.ts`）如何对待带 Path ACL 的 `documents/` 前缀，包括资料库角色规则和旧的按人规则。
- **Non-scope**: `knowledge/` 目录的授权方式、按角色分区的 Wiki、清除历史版本、修改资料库角色规则本身、daemon 同步协议
- **Related**: `docs/specs/2026-10-14-document-library-role-access-design.md`、`docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md`（D9）、`docs/specs/2026-09-24-wiki-maintainer-compile-flow.md`、`docs/specs/2026-08-31-knowledge-path-acl-design.md`

---

## 0. 一句话

`knowledge/wiki/` 继续对全团队可见。受限的资料（例如 `documents/财务/`）不进入编译；已经编译进 Wiki 的受限内容，在下一次编译时从当前页面里去掉。其它来源照常编译，不再因为一个受限文件夹整批停止。

---

## 1. 目标

| # | 要求 |
|---|------|
| 1 | 给 `documents/财务/` 设了角色权限后，手册、培训等其它来源仍能编译和发布 |
| 2 | 受限文件不下载、不抽取、不交给编译模型 |
| 3 | 收紧之前已经编译进 Wiki 的财务内容，下一次成功编译后，当前 Wiki 页面里不再有 |
| 4 | 去掉财务内容时，不会因为模型失败而把财务内容留在页面里 |
| 5 | 拉不到权限列表时不编译、不发布 |
| 6 | 编译和发布之间新增了权限，不发布这次的结果 |

验收场景：

| 场景 | 预期 |
|------|------|
| 选了 `documents/手册/`、`documents/财务/`；`documents/财务/` 是角色资料库 | 手册照常编译；财务不下载、不编译；摘要显示「1 个文件夹受权限限制，未编译」 |
| `documents/财务/报表.md` 收紧前已编译成 `pages/预算.md`（只引用这一个来源） | 下一次编译删除 `pages/预算.md` |
| `pages/报销.md` 同时引用 `documents/财务/报销细则.md` 和 `documents/手册/报销.md` | 下一次编译后，`pages/报销.md` 只根据手册内容重写；改写失败时整页删除，再只用手册重新编译 |
| 维护器调用 `listKnowledgeAcl` 返回 500 | 不下载、不编译，提示稍后重试 |
| 编译完、发布前，管理员把 `documents/手册/` 设成角色资料库 | 发布被拒绝，提示重新编译 |

---

## 2. 今天长什么样

| 事实 | 证据 | 影响 |
|------|------|------|
| Wiki 编译的来源只能是 `documents/` 下的一层文件夹 | `wikiSourceFolders`：`^documents\/([^/]+)\/$` | 和资料库角色规则的形状相同。一个来源文件夹要么整个受限，要么内部有旧的嵌套按人规则 |
| 预检拿到全部 ACL 前缀，任一 `documents/` 前缀和来源文件夹相交就整批抛错 | `acl-preflight.js` `assertDocumentsAclAllowsPublish`，由 `dry-run.js` 调用 | 这是要改的地方 |
| 桌面端先下载缺失的来源文件，再调用 `kb_maintainer_prepare` | `prepareWikiMaintenance`：`listKnowledgeAcl` → `listKnownDocuments` → `fetchDocuments(missing)` | 所有者运行时，会先把财务文件下载到本机，才在预检里失败 |
| 团队清单里列着的路径全部当作「保留」，不排删除 | `dry-run.js`：`retain: [...retained, ...knownPaths]` | 只把受限文件从候选里拿掉，旧页面不会被删 |
| 删除来源时，模型改写失败就恢复原页、只摘掉来源引用 | `ingest.js` `retractOne` → `detachDeletedSource` | 正文仍保留根据财务资料写出的内容 |
| 删除改写时把来源原文交给模型 | `retractOne` 的 `rawMarkdown` | 收紧后又发一次财务原文 |
| 失败的删除会挡住发布 | `desktop-runner.js` `failedRetracts` → `canPublish = false` | 可以沿用 |
| 发布阶段不再查 ACL | `publishWikiMaintenance` / `kb_maintainer_publish` | 编译和发布之间有窗口 |
| `knowledge/wiki/` 没有 Path ACL，历史版本对全员可读；维护器 git 历史随检查点（`wiki.bundle`）上传 | `/sync/versions`、`checkpoint.js` | 撤回只能改当前页面，历史收不回来 |
| 维护器以所有者或管理员身份运行。所有者看得到角色资料库，管理员看不到 | 资料库设计 D3 | 两种身份下，受限来源进到维护器的路径不同，判断不能依赖「看不看得到」 |

---

## 3. 决策

### D1 — 受限前缀从权限列表算，不从可见性推

受限前缀 = `listKnowledgeAcl` 返回的规则里，所有以 `documents/` 开头的 `pathPrefix`。角色资料库和旧的按人规则一样算。`knowledge/` 前缀不参与。

不靠「维护器账号能不能下载」来判断：所有者能看到财务，不代表全员能看到。

### D2 — 拉不到权限列表，整批停止

`listKnowledgeAcl` 失败，或者 `aclPrefixes` 不是数组，沿用现在的行为：不下载、不编译、不发布。

### D3 — 受限路径不进入候选、不下载

一个路径「受限」，当且仅当它以某个受限前缀开头（前缀以 `/` 结尾，按段比较）。

- 桌面端计算 `missing` 时去掉受限路径，不调用 `fetchDocuments` 下载它们。
- `dry-run` 把受限路径归入新的分类 `restricted`，不进入 `allowed`，不进入 `retain`。
- 本机已经存在的受限文件（所有者的电脑上有）同样归入 `restricted`，不读取、不计算哈希。
- 来源文件夹整个受限时，这个文件夹贡献零个候选，其它文件夹照常。

如果所有来源文件夹都受限、也没有要撤回的内容，沿用「没有可编译的来源」的空选择提示。

### D4 — 已导入的受限来源显式撤回

`state.sources` 里每个路径落在受限前缀下的来源，进入新的撤回队列 `restrict`，不论本机有没有、清单里列不列。

这条队列在本次运行里最先执行，早于 add / update / 普通 delete。

### D5 — 受限撤回不留内容

对 `restrict` 队列里的每个来源：

1. 只引用这一个来源的页面直接删除（沿用 `dropPagesOnlyCiting`）。
2. 还引用其它来源的页面，交给模型改写，`rawMarkdown` 传空字符串，不再发送受限原文。
3. 改写失败、页面仍引用这个来源、或页面被改坏时，**不走 `detachDeletedSource`**。改为整页删除，并把这些页面引用的其它来源加入本次运行的 update 队列，只用它们重新编译。
4. 之后照常重建索引、清理失效链接、跑校验。校验不过则这一个来源回滚，记为失败的撤回。

失败的受限撤回沿用现有规则：本次运行不能发布，提示「受限资料仍在 Wiki 中，请重新编译后再发布」。

这样做的代价：多来源页面在模型失败时会先整页消失，再由其它来源重新生成，措辞可能和原页面不同。

### D6 — 受限撤回成功后清理本地缓存

撤回成功后删除这个来源在维护器工作目录里的 raw 缓存（现有 `retractOne` 已经这样做），并从 `state.sources` 去掉它。检查点里的 `state.json` 随之不再记录它。

### D7 — 发布前再查一次权限

`prepare` 把本次使用的受限前缀写进 `prepared-run.json`（`restrictedPrefixes`）。

`publishWikiMaintenance` 在 `beginPublish` 之前重新调用 `listKnowledgeAcl`：

- 调用失败：不发布。
- 新增的 `documents/` 受限前缀和任一来源文件夹相交：不发布，提示「编译后有资料被设为受限，请重新编译」。
- 前缀减少（有规则被删）：可以发布。没被编译进去的资料下次再编译。

### D8 — 撤回的含义写清楚

撤回只保证**当前** `knowledge/wiki/` 页面里不再有受限内容。以下收不回来，本设计不处理：

- 同步的历史版本（`/sync/versions`）里改写前的页面
- 成员设备上已经同步下来的旧页面副本，以及从中复制走的内容
- 维护器 git 历史和已上传的检查点 bundle
- 收紧之后、下一次编译之前，这段时间里的 Wiki 内容

---

## 4. 一次编译的流程

1. 拉取最新检查点（不变）。
2. 调用 `listKnowledgeAcl`。失败则停止（D2）。算出受限前缀（D1）。
3. 列出团队清单，筛出所选来源文件夹下的路径，去掉受限路径，只下载剩下缺失的文件（D3）。
4. `kb_maintainer_prepare` 收到 `aclPrefixes`：
   - `dry-run` 分类：`allowed` / `denied` / `blocked` / `ignored` / `restricted`。
   - `reconcile` 只看 `allowed`；`retain` 里去掉受限路径。
   - 另算 `restrict` 队列（D4）。
5. 执行顺序：`restrict` → add → update（含 D5 第 3 步追加的来源）→ delete。
6. 摘要：受限只显示数量和文件夹数，不列文件名；失败的受限撤回挡住发布。
7. 写 `prepared-run.json`，含 `restrictedPrefixes`（D7）。
8. 用户确认发布时，重新拉权限列表比对（D7），通过后照常发布。

---

## 5. 失败与恢复

| 情况 | 行为 |
|------|------|
| 权限列表拉取失败 | 不下载、不编译、不发布 |
| 受限撤回模型失败 | 整页删除，其它来源重编（D5） |
| 受限撤回校验不过 | 该来源回滚，本次不能发布 |
| 某个受限撤回后，补编的其它来源失败 | 沿用 add/update 失败规则：这个来源回滚，页面暂时缺失，其它结果可以发布。受限内容已经去掉，不会因此回来 |
| 编译中途被取消 | 沿用现有取消；`state.sources` 的 `pending` 机制保证下次继续撤回 |
| 发布前权限变化 | 不发布，要求重编（D7） |

---

## 6. 界面

维护摘要里新增一行（只在有受限来源时出现）：

- 「N 个文件夹受权限限制，未编译。」
- 有受限撤回时：「已从 Wiki 中移除 M 个受限来源的内容。」
- 受限撤回失败（挡住发布）：「受限资料仍在 Wiki 中，请重新编译后再发布。」

资料库「谁可以看」弹窗：不改。保存成功后不提示 Wiki。

> 待评审：是否在资料库弹窗的「停止同步」确认里加一句「已经编译进团队 Wiki 的内容，要等下一次 Wiki 编译后才会移除」。见 §9 问题 2。

---

## 7. 改动清单

| 文件 | 改动 |
|------|------|
| `scripts/kb-maintainer/acl-preflight.js` | `assertDocumentsAclAllowsPublish` 只检查「状态未知」；新增 `restrictedDocumentPrefixes(aclPrefixes)`、`isRestrictedPath(path, prefixes)` |
| `scripts/kb-maintainer/dry-run.js` | 新分类 `restricted`；`retain` 去掉受限路径；输出 `restrict` 队列 |
| `scripts/kb-maintainer/ingest.js` | `restrict` 队列先执行；`retractOne` 增加受限模式：`rawMarkdown` 为空、失败时整页删除并追加 update，不调用 `detachDeletedSource` |
| `scripts/kb-maintainer/desktop-runner.js` | 摘要计数 `restrictedFolders` / `restrictedRetracted`；失败的受限撤回挡住发布；`prepared-run.json` 写 `restrictedPrefixes` |
| `packages/app/src/lib/knowledge/wiki-maintainer-client.ts` | `missing` 去掉受限路径；发布前重新拉 ACL 比对 |
| Wiki 维护界面组件 | 显示 §6 的文案 |
| `packages/app/src/locales/zh-CN.json`、`en.json` | 新文案 |

不改：FC、daemon、资料库角色规则、`knowledge/` ACL、同步协议。

---

## 8. 测试

`scripts/kb-maintainer`：

- 来源文件夹 = 受限前缀：零候选，其它文件夹照常。
- 嵌套旧规则 `documents/手册/机密/` 在来源文件夹内：只跳过这棵子树。
- `documents/财务/` 受限，`documents/财务公开/` 不受影响。
- 已导入的受限来源，不论本机有无、清单列否，都进 `restrict` 队列；不进 `retain`。
- 只引用受限来源的页面被删除。
- 多来源页面：模型成功时只剩其它来源；模型失败时整页删除、其它来源被追加 update；任何情况下页面正文不再包含受限原文里的标志性字符串。
- 受限撤回时传给模型的 `rawMarkdown` 为空。
- 受限撤回失败时 `canPublish = false`。
- `aclPrefixes = null` 仍然整批停止。
- 现有 `dry-run.test.js`「ACL 覆盖白名单则抛错」改为「归入 restricted」。

桌面端：

- `fetchDocuments` 不会收到受限路径。
- 发布前权限列表失败、或新增相交前缀时，不调用 `beginPublish`。

---

## 9. 待评审的问题

1. **多来源页面改写失败时的策略。** 本稿选「整页删除 + 其它来源重编」。另一种是「本次停下、不发布，直到模型改写成功」：页面不会短暂消失，但模型一直失败时整个 Wiki 无法再发布。
2. **资料库弹窗要不要提示 Wiki。** 加一句提示能让管理员知道 Wiki 里的内容要等下次编译才去掉；代价是资料库弹窗出现和它无关的维护器概念。
3. **收紧后要不要自动触发编译。** 本稿不触发，等下一次定时或手动编译。若要缩短 §D8 的时间窗，可以在资料库从全员收紧时，把维护器状态标为「需要重新编译」。
4. **管理员运行维护器时的摘要。** 管理员看不到角色资料库，团队清单里没有这些路径；受限文件夹数量仍从权限列表算，摘要会显示「1 个文件夹受权限限制」，但他看不到里面有什么。是否接受。
