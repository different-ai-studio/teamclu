# {{APP_NAME}}

你在维护一个叫 **{{APP_NAME}}** 的**数据操作**应用（app id `{{APP_ID}}`）。
它是一个 TanStack Start 全栈应用，带一个属于自己的 Postgres schema。

## 内容放哪

- `src/routes/` — 页面与路由（TanStack Router 的文件式路由）
- `src/lib/platform-auth.ts` — 读平台转发过来的访客身份（登录本身由代理完成）
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

## 部署声明（`teamclu.app.json`）

仓根 `teamclu.app.json` 声明本模板的 `build` 和 `start`。构建必须产出 `.output/server/index.mjs`，服务器监听平台提供的 `$PORT`。修改启动声明或上线时，读取内置 `deploy-app` skill；运行环境、版本、迁移与发布步骤以该 skill 和实时控制面信息为准。

本地预览：`pnpm dev`，打开 `http://localhost:9000`。

## 平台鉴权契约

实现平台登录、角色权限、员工页面或数据接口前，读取内置 `app-auth` skill；它是身份、角色和路径保护的统一契约。申请人自建的 mock 短信登录可以保留，与平台员工登录分开。

平台 user ID 与 `created_by_actor_id` 不同，不能直接比较。创建者或协作者的管理权限不等于员工访问权限；不能硬编码创建者或成员名单。保护员工页面时也要保护实际员工数据接口，通常使用独立 `/api/staff` 前缀；共享 `/_serverFn` 不能一并锁住或留下员工操作未保护。接口实现示例见 skill。无法完成真实账号登录时明确列为待验收。

## 登录（`auth_mode`）

**模板不实现登录。** app 没有登录页、没有回调路由、没有自己的会话 cookie，也没有任何
可写错的地方。平台的代理挡在每个请求前面：它在自己的域名上跑完整个邮箱验证码流程，判断
谁可以进来，然后才把请求转发过来，并把访客身份放在请求头里。

这么放是有意的 —— 这些代码会被 agent 反复重写，写在 app 里的登录墙活不过下一次重写，而
控制面还会一直显示「已启用登录」。放在代理层，它改不掉。

三档设置都在 TeamClu 控制面，与 TeamClu 桌面端自己的登录无关：

| 设置 | 含义 |
|---|---|
| 登录方式 | 有没有墙（`none` / `platform`；`third` 暂不可部署） |
| 谁可以进入 | 任何登录用户 / 只有同组织的员工 |
| 拦哪些页面 | 整站 / 只拦列出的路径（按前缀，最长匹配优先） |

**改动立即生效，不需要重新部署** —— 墙在代理层，不在函数里。

### 平台转发过来的身份

```
X-Teamclu-User-Id     访客在平台 Supabase 里的 id
X-Teamclu-User-Email  邮箱
X-Teamclu-Org-Id      所属组织（有的话）
```

身份头表示网关验证过的访客身份，不表示拥有全部员工权限。只有当前请求路径配置了相应员工角色规则，才能依赖网关的员工准入检查。代理删除客户端自带的同名头再注入身份；未经网关的源站请求必须被拒绝。

### 一个必须知道的边界

路径规则挡的是「谁能取到这个地址的响应」，不是「谁能看到这个界面」。应用内部的客户端
跳转不经过代理。**要保护的是数据**：把取数据的接口一并列进受保护路径。代理是外层，
app 自己的查询层才是真正的边界。

读身份用 `src/lib/platform-auth.ts` 的 `visitorFrom(headers)`，返回 `null` 就当作没人。
`auth_mode=platform` 时平台还会注入 `SUPABASE_URL` / `SUPABASE_ANON_KEY`（浏览器可达的
公开值，绝不是 service role），app 想自己用 supabase-js 可以取用 —— 但登录墙不依赖它们。
