# 一步一例：一份请假制度如何变成 Wiki

用**一份真实会经过的文件**走完整条链路。旁边的目录是对应快照，可以直接打开对照：

`scripts/kb-maintainer/fixtures/walkthrough/`

故事只有一件事：团队资料库里有一份 `leave.md`。你勾选 `documents/handbook/`，点「检查并编译」，通过后再点「确认发布」。

---

## 先记住三栋房子

假设团队 id 是 `team-demo`：

```text
① 资料库（原文，人改）
   ~/.amuxd/teams/team-demo/shared/team-sync/documents/handbook/leave.md

② 本机沙箱（编译车间，用户平时看不到）
   ~/Library/Application Support/teamclu/kb-maintainer/team-demo/
     raw/          抽取后的带定位原文
     wiki/         正在编的 Wiki（有 .git）
     state/        记「哪份资料已经导入过」

③ 知识库（发布后大家才能搜到）
   ~/.amuxd/teams/team-demo/shared/team-sync/knowledge/wiki/
```

编译只发生在 ②。③ 要等你点「确认发布」才会变。

---

## 第 0 步：磁盘上只有原文

快照：[`00-documents/handbook/leave.md`](fixtures/walkthrough/00-documents/handbook/leave.md)

```markdown
# 请假

员工请假需提前三天申请。病假需要医院证明。
```

此时：

- 沙箱 `wiki/pages/` 是空的（或只有上次留下的页）
- `knowledge/wiki/` 可能是空的，也可能有以前发布过的旧页
- `state.json` 里还没有这条来源

界面上你勾选的是文件夹 `documents/handbook/`，不是单文件。维护器会扫描这个文件夹里所有允许的扩展名。

---

## 第 1 步：对账（不调模型）

维护器问三件事，合成一张计划表：

| 问题 | 答案 |
| --- | --- |
| 磁盘上有这份文件吗？ | 有，`documents/handbook/leave.md` |
| `state.json` 记过它吗？ | 没有 |
| 云端 known 清单里有吗？ | 有（懒下载名单） |

结论：**add**（新资料，需要编译）。

如果是「磁盘没了、state 里还有」→ **delete**（撤回），不会重新下载。  
如果哈希和上次一样 → **unchanged**（跳过模型）。

这一步的产物不是文件，是内存里的计划，例如：

```json
{
  "add": [{ "path": "documents/handbook/leave.md", "sourceSha256": "270a1a47…" }],
  "update": [],
  "delete": [],
  "unchanged": []
}
```

---

## 第 2 步：抽取 → `raw/`（仍不调模型）

快照：[`01-after-extract/raw/documents/handbook/leave.md.md`](fixtures/walkthrough/01-after-extract/raw/documents/handbook/leave.md.md)

原文字节哈希（`sourceSha256`）先算出来：

`270a1a47bbf1b54eb7b25ab0666638ffe33df16f6c164f8fbb8d5e5e0f031a85`

然后写成带定位注释的 Markdown。注意文件名是 `leave.md.md`：路径规则是「资料相对路径 + `.md`」。

```markdown
---
source_path: documents/handbook/leave.md
source_sha256: 270a1a47bbf1b54eb7b25ab0666638ffe33df16f6c164f8fbb8d5e5e0f031a85
extractor: text-md-v1
quality: accepted
---
<!-- source-locator: heading=请假 -->
# 请假

员工请假需提前三天申请。病假需要医院证明。
```

`<!-- source-locator: heading=请假 -->` 是给后面校验用的锚点：Wiki 页 frontmatter 里写的 locator 必须能在这份 raw 里找到，否则算胡编。

这一步**还没有 Wiki 页**。

---

## 第 3 步：模型在沙箱 `wiki/` 里写页

Pi 会话的工作目录是沙箱里的 `wiki/`。它只能 read/write/edit/find，看不见 `documents/`，也写不进 `knowledge/`。

一份原文可以变成**多页**。这个例子里模型拆成了「请假」制度页和「销假」流程页，并互相链接。

快照：[`02-after-compile/wiki/`](fixtures/walkthrough/02-after-compile/wiki)

```text
wiki/
  index.md
  pages/请假.md
  pages/销假.md
```

`pages/请假.md`（注意 `sources` 和 `[[pages/销假]]` 这种带 `pages/` 前缀的链接）：

```yaml
---
type: policy
summary: 员工请假需提前三天申请。
managed_by: llm-wiki
schema_version: 1
sources:
  - path: documents/handbook/leave.md
    sha256: 270a1a47bbf1b54eb7b25ab0666638ffe33df16f6c164f8fbb8d5e5e0f031a85
    locators: ["heading=请假"]
updated: 2026-09-21
---
```

`index.md` 必须用同一套摘要（程序会按各页 `summary` 重写一遍 index）：

```markdown
# LLM Wiki

## 制度
- [[pages/请假|请假]] — 员工请假需提前三天申请。

## 流程
- [[pages/销假|销假]] — 病假结束按销假流程办理。
```

如果模型写成 `[[销假]]` 而不是 `[[pages/销假]]`，校验会报 **dead wiki link**，整份资料回滚，这两页都不会留下。失败样例见 [`02b-validate-fail-example/`](fixtures/walkthrough/02b-validate-fail-example)。

---

## 第 4 步：校验通过 → Git commit + 更新 state

快照：[`03-after-commit/state.json`](fixtures/walkthrough/03-after-commit/state.json)

沙箱 `wiki/.git` 多一个 commit：

```text
ingest(add): documents/handbook/leave.md@270a1a47bbf1
```

`state.json` 这时才把这份资料标成已导入：

```json
{
  "schemaVersion": 1,
  "sources": {
    "documents/handbook/leave.md": {
      "sourceSha256": "270a1a47bbf1b54eb7b25ab0666638ffe33df16f6c164f8fbb8d5e5e0f031a85",
      "status": "imported",
      "affectedPages": ["pages/请假.md", "pages/销假.md"],
      "lastImportedCommit": "a1b2c3d"
    }
  },
  "publishedCommit": null
}
```

`publishedCommit: null` 表示：**编译成功了，但知识库还没更新**。这就是界面上「检查并编译」结束后、你还没点「确认发布」的状态。

摘要卡片大约是：

- 已检查 1 个资料文件
- 新增 2 个页面
- 可以点「确认发布」

---

## 第 5 步：你点「确认发布」→ 拷到知识库

快照：[`04-after-publish/knowledge/wiki/`](fixtures/walkthrough/04-after-publish/knowledge/wiki)

脚本把沙箱 `wiki/` 里通过校验的树，写进团队知识库：

```text
knowledge/wiki/index.md
knowledge/wiki/pages/请假.md
knowledge/wiki/pages/销假.md
```

内容与第 3 步沙箱里的文件相同。然后：

- `state.publishedCommit` 写成刚才那个 Git commit
- 触发团队同步（别人电脑才会拉到这些页）

到这里，会话里的 Agent 才能 `knowledge_read("wiki/index.md")` 问到请假规则。

---

## 如果之后你把 leave.md 删了

磁盘：`documents/handbook/leave.md` 没了。  
state 里还记着它 → 对账结果是 **delete**。

撤回时按 `affectedPages` 处理：

1. `请假.md` / `销假.md` 若只引用这一份来源 → 删页
2. 若页上还有别的资料的 sources → 用剩下的 raw 重编该页
3. 成功后才从 `state.sources` 里删掉这条

再次发布后，`knowledge/wiki/` 里对应页才会消失。只删资料、不重新编译并发布，知识库里的旧 Wiki 还在。

---

## 对照：你上次真实失败时，卡在第 3→4 步

`amuxd-home-directory.md` 已经走完抽取和模型写页（拆成了 5 页），但单来源校验没过：

| 校验 | 例子里的正确形态 | 当时实际形态 |
| --- | --- | --- |
| Wiki 链接 | `[[pages/销假]]` | `[[amuxd-device-id]]`（缺 `pages/`） |
| index 摘要 | 与页内 `summary:` 逐字相同 | 对不上 |

于是 Git **reset 回编译前**，沙箱里那 5 页被丢掉，界面才是「新增 0 页面 / 1 个资料失败」。知识库始终没被写。

---

## 一张时间表

```text
t0  人把 leave.md 放进资料库
t1  点「检查并编译」
t2  raw/ 出现 leave.md.md          ← 抽取产物
t3  wiki/pages 出现两页 + index    ← 模型产物（还在沙箱）
t4  校验通过，git commit + state   ← 本机认定「这份导入成功」
t5  UI 给你看摘要，知识库仍是旧的
t6  点「确认发布」
t7  knowledge/wiki/ 变成和沙箱一样 ← 团队可检索的产物
```
