# 团队 Skill：工作副本、hosted 缓存、安装 / 改 / 发

> 状态：**现行模型**（实现与本文对齐）。
> 对照：[`team-skills-registry.md`](./team-skills-registry.md) 里曾把 `cloud/skills` 写成 Agent 的运行时安装根——那是错的。

## 1. 两份磁盘的角色

| 路径 | 角色 | 谁可以写 |
|---|---|---|
| `~/.agents/skills/<slug>` | **工作副本**。列表展示、人改、`update_draft`、发布打包、OpenCode 加载、dirty 的「本地」一侧 | 人、Agent 草稿、桌面对账（dirty 则停） |
| `~/.amuxd-…/teams/<id>/state/cloud/skills/<slug>` | **远端快照缓存**。把团队包拉下来，inspect 用它的 `origin.json` 当 baseline，免去每次下 zip | **只有** daemon 对账（无条件覆盖成远端） |

hosted **不是**第二份可编辑副本，**不进** Skills 列表，**不进** `skills.paths`。

dirty = 工作副本相对「同版本的 hosted `origin.json` 哈希」（没有缓存时退回工作副本自己的 origin）。只改 hosted 文件、不动工作副本 → **不脏**。

## 2. 安装

```text
人在列表选中 Agent → 点安装
  → PUT /v1/teams/:id/skills/:slug/install  { actorId }
  → 桌面把 zip 解到 ~/.agents/skills/<slug>，写 origin.json
  → daemon 对账把同一份远端包写入 cloud/skills 缓存
  → 列表：已安装，对勾；dirPath 是 ~/.agents/skills
```

无头 daemon：缓存照常刷新；工作副本仅在 **不 dirty** 时从缓存同步过去。个人 skill（无 team origin）不会被覆盖或删除。

## 3. 修改

```text
改 SKILL.md / update_draft
  → 只写 ~/.agents/skills/<slug>
  → hosted 缓存不动
  → inspect(工作副本, hosted origin) → dirty → 列表三角
  → 新会话用工作副本；别人看不到草稿
```

## 4. 发布

```text
打包 ~/.agents/skills/<slug> → POST .../versions
  → 本机 rebaseline 工作副本 origin
  → daemon 下次对账刷新 hosted 缓存到新 latest
```

## 5. 和旧实现的差别（已拆掉的）

| | 旧（错） | 现在 |
|---|---|---|
| `effective_team_skill_dir` | hosted 目录在就用 hosted | 永远 `~/.agents/skills` |
| OpenCode `skills.paths` | hosted 在前 | 只有工作副本；旧 hosted 路径会被清掉 |
| 技能列表 `dirPath` | daemon 扫描 first-wins，hosted 先到 | 跳过 `…/state/cloud/skills` |
| inspect | 对「有效目录」相对自己的 origin | 对工作副本，baseline 来自 hosted origin（同版本时） |
| daemon 对账 | 把 hosted 当运行时根；脏了就跳过缓存更新 | 缓存无条件对齐远端；工作副本 dirty 则不同步 |

## 6. 明确不做

- 把 hosted 再加回 `skills.paths` 或列表。
- 在草稿 / 发布 / restore 路径上写 hosted。
- 用「hosted 活文件的 hash」当 baseline（缓存被误改时会误报 dirty）。
