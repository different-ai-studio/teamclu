# 团队 Skill 包下载契约

> 目标落位：`docs/architecture/team-skill-package-download-contract.md`
> 状态：**补契约** — 路由已实现，OpenAPI 此前漏了这条；元数据 GET 的 summary 误写成「解析包体」。
> 前置阅读：[`team-skills-registry.md`](./team-skills-registry.md) §5 / §8.2，[`skills-marketplace.md`](./skills-marketplace.md) §4.2 / §4.3 / §8.2。

## 1. 要解决什么

安装管线要的是**短时效签名 URL**，不是包体元数据，也不是 FC 代理的 zip 字节。

两条容易混的 GET 现在必须拆开：

| | 元数据 | 下载 |
|---|---|---|
| 路径 | `GET /v1/teams/{teamId}/skills/{slug}/versions/{version}` | `GET /v1/teams/{teamId}/skills/{slug}/versions/{version}/download` |
| 做什么 | 返回版本行（changelog、快照字段、`contentHash`、`size`） | 解析包体落点，签发短时效 URL |
| 不做什么 | 不碰对象存储、不签发 URL | 不代理 zip 字节经过业务 API |
| OpenAPI | `getTeamSkillVersion` | `downloadTeamSkillVersion`（本文件落地后写入） |

路由层已实现下载（`services/fc/src/lib/routes/team-skills.ts`），客户端（桌面 `resolveDownload`、daemon `team_skill_download`）已经在打它。缺的是契约：OpenAPI 没有这条路径，元数据 GET 的 summary 还写着 "Resolve a version's package blob"。

## 2. 下载解析：两条 blob 路径

版本行上的 `blob_scope` 决定字节在哪。**客户端永远见不到 `object_path` / `oss_key`**，只拿到 `{ url, contentHash, size }`。

```
GET .../versions/{v}/download
        |
        |- blob_scope = 'marketplace'
        |     object_path 已快照在 team_skill_versions 上
        |     -> 直接签这条路径
        |     -> 不查 amuxc_blobs（市场包刻意不进那张表）
        |
        |- blob_scope = 'team'（默认）
              content_hash -> amuxc_blobs(team_id, content_hash) -> oss_key
              -> 签 oss_key
              -> 没有 oss_key：409 blob_missing
```

路径形状（同一 skills 命名空间，前缀不同）：

```
teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>          团队自己发的包
marketplace/blobs/sha256/<aa>/<bb>/<hash>             市场包
```

`SKILLS_STORAGE_BUCKET` 在两个后端上不是同一种东西：`TEAM_BLOBS_BACKEND=s3` 时是共享桶里的 **key 前缀**；不设时才是 Supabase Storage 的 **桶名**。签名函数是同一个（`createSkillDownloadUrl`）。

市场包为什么不进 `amuxc_blobs`：那张表按 `team_id` 隔离，目录不属于任何团队。给它塞「无主 blob」会污染被 OSS 同步共用的账本，也会让 GC 面对一类它没设计过的行。下载解析按 `blob_scope` 分支，就是为了让市场包在没有那一行的情况下仍然可签。

`object_path` 写在团队自己的版本行上、而不是每次回目录表查：这一行一旦写下，下载就不再依赖目录项还在不在。下架 / 删除目录项只让它不再更新，不会让已经装上的包 409。

## 3. 签名 URL 的时效

`createSkillDownloadUrl(objectPath, expiresIn = 900)` — **默认 900 秒（15 分钟）**。

- 业务 API 响应里**不**带回 `expiresIn`；客户端把 `url` 当一次性凭据用，过期就重新打 download。
- 900 秒覆盖「对账拉到清单 → 下载 zip → 解压」这条同步路径，短到丢在日志里也很快失效。
- 签名 URL 自带凭据。daemon / 桌面端 **GET 这个 URL 时不得附带业务 API 的 bearer**——对象存储是第三方，把团队 token 送过去等于泄漏。

鉴权在签发这一步：调用者必须是该团队成员。URL 一旦发出，持有者在过期前都能拉字节；这是短时效的代价，不是漏洞。

## 4. 响应形状

```json
{ "url": "https://…", "contentHash": "<64 hex>", "size": 12345 }
```

`contentHash` / `size` 来自版本行（市场包同样），让安装端在解压前能对一下它以为自己在装的那一版。`url` 是唯一新增的字段；元数据 GET 没有它。

错误：

| 状态 | code | 何时 |
|---|---|---|
| 400 | `validation_failed` | `version` 不是正整数 |
| 401 / 403 | | 未登录 / 不是成员 |
| 404 | `not_found` | slug 或 version 不存在 |
| 409 | `blob_missing` | team 包还没有 `amuxc_blobs.oss_key`，或 marketplace 包缺 `object_path` |

## 5. 明确不做

- FC 代理 zip 字节（包可以到数 MB，业务 API 不是传输面）
- 把 `object_path` / `oss_key` 暴露给客户端
- 下载时校验 `amuxc_blobs.verified`（历史行可能未标；新发布的门在 publish，见 [`skill-publish-atomicity-and-blob-verification.md`](./skill-publish-atomicity-and-blob-verification.md)）
- 改 MQTT / Caddy / NanoMQ / daemon runtime

## 6. OpenAPI

落地：`docs/openapi/teamclu-api.v1.yaml`

- 新增 `GET /v1/teams/{teamId}/skills/{slug}/versions/{version}/download`
- 元数据 GET 的 summary 改为版本记录，不再声称它解析包体
