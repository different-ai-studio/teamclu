# kb-maintainer 专用机 Runbook

本机是试点团队唯一的 LLM Wiki 维护器。不要在第二台电脑打开同一份 `config.json`。

## 安装

1. 用 owner/admin 账号登录 Desktop，确认 daemon 在线、团队已同步。
2. 把仓库检出到本机；不要把真实白名单提交进 git。
3. 创建工作根：

```bash
mkdir -p ~/kb-maintainer/<team-id>/{state,raw,wiki,runs}
cp scripts/kb-maintainer/config.example.json ~/kb-maintainer/<team-id>/config.json
cp scripts/kb-maintainer/templates/_schema.md \
  ~/.amuxd/teams/<team-id>/shared/team-sync/knowledge/_schema.md
```

4. 编辑 `config.json`：填 `teamId`、`maintainerNodeId`、白名单 `sources[]`、`deny.pathPatterns`、`models.visionPagePrice`。
5. 白名单只能覆盖全团队可见的 `documents/` 前缀。人事、处分、保单、薪资目录必须写进 `deny`。

## 每次运行

1. 以 owner/admin 拉取 live ACL，写入 `/tmp/acl-prefixes.json`（JSON 数组）。调用失败则停止。
2. 从 daemon 导出 `GET /v1/team/documents/known` 到 `/tmp/known.json`。
3. `dry-run`。计划必须可复核；连续两次 `plan` 字段应一致。
4. 若计划含 PDF：先 `estimate`。`requiresAccept=true` 时先确认费用，再考虑视觉。没有预算预览不准跑视觉。
5. `ingest --runner fake` 做文本验收。P0 验收最终只认 Pi runner（尚未接线）。
6. `lint`。`ok=false` 不得发布。警告写入本地 `runs/`，不改页面。
7. `eval`。试点门槛：命中率 ≥ 80%，且 `criticalMisses` 为空。
8. `publish`。只写 `knowledge/wiki/`。同步固定 `force_sync=true`，`allow_bulk_add=false`，`allow_bulk_delete=false`。被闸门挡住则状态为 `published_local_sync_pending`，不要改这两个开关。

## 回滚

- 单来源失败：维护器已 `git reset --hard` 到该来源之前的 commit，state 不保留 pending。
- 发布中断：不要手改 vault。再跑一次 `publish`，incomplete marker 会重放。
- 发布后要撤：在维护器 `wiki/` git 回到上一 commit，再 `publish`。不要直接改团队 vault 里的 `wiki/`。
- `_schema.md` 改动默认只影响未来导入。全量重编必须显式执行，并先跑 `estimate`。

## 停用

1. 停掉本机 cron / 手动调度。
2. 删除或改名 `~/kb-maintainer/<team-id>/config.json`，避免误跑。
3. 保留 `wiki/` git 和 `runs/` 以便审计；不要把 `raw/` 同步进团队知识库。
4. 团队 vault 中的 `knowledge/wiki/` 可整树删除后再同步。人审目录 `30-decisions/`、`40-runbooks/` 不要动。

详细命令见 `README.md`。规格见 `docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md`。
