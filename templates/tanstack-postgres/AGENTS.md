# {{APP_NAME}}

你在维护一个叫 **{{APP_NAME}}** 的**数据操作**应用（app id `{{APP_ID}}`）。
它是一个 TanStack Start 全栈应用，带一个属于自己的 Postgres schema。

## 内容放哪

- `src/routes/` — 页面与路由（TanStack Router 的文件式路由）
- `src/lib/platform-auth.ts` — `auth_mode=platform` 时的 OAuth / membership 契约 stub
- `src/db.ts` — 数据库连接
- `db/schema.sql` — 建表语句；首次部署冷启动时对本 app 自己的 schema 执行

## 数据库

连接串由平台通过环境变量 **`DATABASE_URL`** 注入，**不要写死、不要提交任何连接串或
密码**。这个角色只能访问本 app 自己的 schema，`search_path` 已经固定好了 ——
正常写 `select * from your_table` 即可，不需要也不应该加 schema 前缀。

每次部署平台都会轮换这个角色的密码并同步更新环境变量，所以本地跑不通、线上跑得通
是正常的。

## 文件存储

平台给每个 app 一块自己的对象存储空间，通过环境变量注入：

| 变量 | 含义 |
|---|---|
| `TEAMCLU_STORAGE_STS_URL` | 换取临时凭证的地址 |
| `TEAMCLU_STORAGE_TOKEN` | 换凭证用的身份令牌，**每次部署都会轮换** |
| `TEAMCLU_STORAGE_BUCKET` / `TEAMCLU_STORAGE_PREFIX` | 你能写的桶和前缀 |
| `TEAMCLU_STORAGE_REGION` / `TEAMCLU_STORAGE_ENDPOINT` | 区域与 endpoint |

这几个变量不存在时，说明这个部署没开文件存储 —— 代码要能在没有它们时正常跑，
不要在启动时断言。

**换凭证**（拿到的凭证只能读写 `TEAMCLU_STORAGE_PREFIX` 下的对象，越界一律
`AccessDenied`）：

```js
async function storageCredentials() {
  const res = await fetch(process.env.TEAMCLU_STORAGE_STS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TEAMCLU_STORAGE_TOKEN}` },
  })
  if (!res.ok) throw new Error(`storage credentials: ${res.status}`)
  return res.json() // { accessKeyId, accessKeySecret, securityToken, expiration, bucket, prefix, ... }
}
```

三条要点：

1. **按 `expiration` 提前刷新，不要等 403。** 凭证有有效期，过期后所有请求都会失败，
   而 403 也可能是别的原因，靠它来判断会把两种问题混在一起。
2. **每个 key 都要带上 `prefix`**：`` `${creds.prefix}avatars/${id}.png` ``。少了前缀
   不是"存到别处去了"，是直接被拒。
3. **删 app 不会删这些文件**（和数据库一样），所以不要把它当临时目录用。

用量是**周期统计**的，不是实时计数：超配额时平台会停发新的写凭证，但那之前你可能
已经写超了一点。不要在应用里依赖它做精确计费。

## 不要动的东西

- **构建产物契约** —— `pnpm build` 必须产出 `.output/server/index.mjs` 且监听
  `$PORT`。这是平台部署这个 app 的唯一契约，改坏了就传不上去。
- **`pnpm-lock.yaml`** —— 故意提交并锁死精确版本。构建用
  `pnpm install --frozen-lockfile`。曾经 `@tanstack/react-start` 用的是 caret 范围，
  上游发了一版删掉了模板引用的入口，所有 app 的构建当场全挂。加依赖时也请写精确版本
  并更新锁文件。

## 怎么上线

部署按 **Gitea 远端 commit** 构建，不是本机未保存的文件。改完代码后：

1. **commit**（含 `pnpm-lock.yaml` 若有依赖变更）
2. **push** 到 Gitea —— 工作树有未提交或未 push 的变更时 daemon **拒绝构建**
3. 让用户在 TeamClu 应用列表里点「部署」，选中刚 push 的 commit

你不需要、也没有权限自己触发部署。

本地：`DATABASE_URL=postgres://… pnpm dev`（线上连接串由平台注入，本地常跑不通
DB，属正常）。

## 登录（`auth_mode`）

`auth_mode` 在 TeamClu 控制面设置。与 TeamClu 桌面/Web 自己的登录无关 —— 这里说的是
**部署后的 app 页面**要不要登录墙。

| 值 | 含义 | Phase 1 |
|----|------|---------|
| `none` | 无登录墙；**任何拿到链接的人都能访问**（部署前用户需确认） | 默认 |
| `platform` | 本 app 独立 GoTrue OAuth 客户端；部署 finalize 注入 env | 见下 |
| `third` | 第三方 IdP | UI 可保存，**部署被拒绝** |

### `auth_mode=platform` 时平台注入的 env

部署 finalize 写入 FC 环境（**不要**写进代码或 Gitea）：

| 变量 | 用途 |
|------|------|
| `OAUTH_CLIENT_ID` | 本 app 的 OAuth client id（可给前端授权跳转） |
| `OAUTH_CLIENT_SECRET` | **仅服务端** token 交换 |
| `APP_PUBLIC_URL` | 对外 vanity URL（`https://<slug>-<id8>.<domain>`） |
| `API_BASE` | TeamClu 控制面 API / GoTrue 根（无尾斜杠） |

`auth_mode=none` 时不注入 OAuth env。`third` 不可部署。

### redirect_uri 与反代

App 跑在 FC 反代后面，请求的 `Host` 是内部地址。**禁止**用 `Host` 自拼
`redirect_uri`。IdP 登记与运行时一致的做法：

- **优先**用 `APP_PUBLIC_URL`：`${APP_PUBLIC_URL}/auth/callback`
- 或读 `X-Forwarded-Host` / `X-Forwarded-Proto` 等 forwarded header 还原
  对外 URL —— 仍应与 `APP_PUBLIC_URL` 一致

本地对照可设 `APP_PUBLIC_URL=http://localhost:9000`。

### 平台登录实现契约（Phase 1 stub）

`src/lib/platform-auth.ts` 是 Phase 1 的**契约 stub**，不是完整 UI：

1. **PKCE 授权码流** — 用 `OAUTH_CLIENT_ID` 跳 GoTrue `/authorize`（带
   `code_challenge`）；`/auth/callback` 用 `OAUTH_CLIENT_SECRET` 服务端换 token。
2. **成员校验** — 拿到用户 access token 后调 Cloud API（**不要用 service role**）：

   `GET ${API_BASE}/v1/apps/{{APP_ID}}/membership`  
   `Authorization: Bearer <user access token>`  
   → `{ "member": true | false }` — 仅该 app 所属 **team 成员**应通过。

3. 受保护路由：无会话 → 跳转登录；有会话但 `member: false` → 403。

Phase 1 **不要**搭完整 IdP UI 框架；按 stub 注释接路由即可。无
`OAUTH_CLIENT_ID`（`auth_mode=none`）时 stub 函数应 no-op / 跳过门禁。
