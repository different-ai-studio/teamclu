# 团队知识库 blob 迁移 runbook（阿里云 OSS → Supabase Storage）

同步的文件字节从阿里云 OSS 搬到 Supabase Storage 私有 bucket `team-blobs`。
元数据表 `amux.amuxc_blobs` 不动 —— `oss_key` 列名保留，值也保留，只是这个
object path 现在指向 Supabase Storage。

**这是硬切：没有双写、没有回退开关。** 因此顺序是 "先搬完并校验，再发代码"。

## 前置：Task 0 必须已经在跑的版本里

`fix(sync): stop advancing the high-water mark past a failed pull`。

没有它，迁移窗口期内任何一次 pull 失败都是**永久静默丢文件**：
`last_server_seq` 会无条件推进到 manifest 快照，下一 tick 只问
`changeSeq > seq`，服务端再也不会列出那个文件，`needs_download` 没有机会重新
判断，而且 tick 仍然返回 `Ok`，只留一行 `warn!`。有了 Task 0，失败会把游标卡住
并在 `SyncStatus.failed` 上报数，下一 tick 自动重试。

## 步骤

### 1. 建 bucket

由迁移 `services/supabase/migrations/20260807010000_team_blobs_storage_bucket.sql`
创建。**逐个部署确认它真的存在**，别假设：

```sql
select id, name, public from storage.buckets where id = 'team-blobs';
```

- **self-host**（`api.teamclu-dev.ucar.cc`）：push 到 main 自动跑 migration。
- **belayo**：迁移是手工 + `_selfhost.schema_migrations` 账本，且只在
  `RUN_MIGRATIONS=1` 时执行 —— 必须手动确认。
- **copilot361**：同样手动确认。

`public = false`。所有访问都走 FC service-role 客户端签的 signed URL
（`services/fc/src/lib/team-blob-storage.ts`），不加 authenticated/anon policy，
默认 deny 就是想要的。

### 2. 搬字节

对象路径两边一致（`teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>`），所以是直拷：

```bash
rclone copy aliyun:<oss-bucket>/teams supabase:team-blobs/teams \
  --checkers 16 --transfers 8 --progress
```

Supabase Storage 的 S3 兼容端点在 `https://<supabase-host>/storage/v1/s3`，
region 任意，凭证用 storage 的 S3 access key。

### 3. 完整性校验（**发代码前必须通过**）

遍历 `amuxc_blobs` 每一行，确认对象在新 bucket 里存在且大小一致：

```sql
-- 拿出待校验清单
select team_id, content_hash, oss_key, size
from amux.amuxc_blobs
where verified = true
order by team_id, content_hash;
```

对每行 `stat` 一次新 bucket 的 `oss_key`，输出缺失/大小不符清单。
缺失清单为空，或者被明确接受（例如确认那些 team 已废弃），才能进下一步。

> 校验用的是 `verified = true` 的行：未 verified 的 blob 本来就没有完成过上传，
> 客户端会重新 push。

### 4. 发代码

按顺序合并：

1. `fix(sync): stop advancing the high-water mark past a failed pull`（Task 0）
2. `feat(fc): serve team sync blobs from Supabase Storage`（Task 1）
3. `refactor(sync): narrow file sync to knowledge/ only`（Task 2）
4. `feat(team-share): reduce share_mode to a single knowledge-sync switch`（Task 3）

self-host 先切，**确认在没有阿里云 OSS 凭证的情况下 sync 仍可用**：

```bash
# 在 FC 容器里临时清掉阿里云 key，跑一遍 prepare → PUT → complete → download
docker compose exec fc env -u ACCESS_KEY_ID -u ACCESS_KEY_SECRET node -e '...'
```

### 5. managed_git / custom_git 存量团队

这些团队的 `knowledge/` 在 git repo 里，不在 `amuxc_blobs`。最后一次
`git checkout` 后把 `knowledge/` 放进本地 team dir
（`~/.amuxd/teams/<team_id>/teamclu-team/knowledge/`），让 sync 的 push
阶段把它们送进 Storage。`share_mode` 不用改：新语义下非空即"已启用"。

### 6. 磁盘阈值 —— 不是"以后再说"

self-host 的 Supabase Storage 是 `STORAGE_BACKEND: file` +
`FILE_STORAGE_BACKEND_PATH: /var/lib/storage`
（`deploy/self-host/supabase/docker-compose.yml`），落在 ECS 本地盘，**和 Postgres
同一块盘**。CAS 只增不减：`cron.ts` 的 GC 只清 7 天前的**孤儿** blob，被引用的
历史版本永久保留。

→ **加磁盘告警。storage volume 到 20GB 或盘容量到 50%，必须迁
`STORAGE_BACKEND: s3`。** 没有阈值的"后面会迁"，实际结局是盘满了才迁，而那时
Postgres 会先写不进去。

## 范围之外

本次只保证 **`/sync/*` 路径零依赖阿里云**。attachments、apps provisioning
仍在用 `services/fc/src/lib/oss.ts`；`/reset-secret` 仍读写阿里云上的
`teams/<id>/_registry/auth.json`。那个 bucket 还没空。
