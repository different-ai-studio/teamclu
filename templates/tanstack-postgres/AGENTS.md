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

仓根 `teamclu.app.json` 声明**怎么构建、怎么启动**，平台按其中的 `build` + `start` 部署到 FC Custom Runtime：

- 改 `build.kind` / `start.command` / `start.port` 以匹配 FC Custom Runtime（本模板默认 Node：`build.kind: "node"`，`start.command: ["/opt/nodejs20/bin/node"]`，`args: ["server/index.mjs"]`，`port: 9000`）。
- **不要用**旧字段 `runtime` / `entry` —— 缺 `build` + `start` 或仍带 legacy 字段时部署会被拒。
- 改完 **commit + push**；用户明确要求上线后，再通过控制面或 `manage_app deploy` 部署。

## 怎么上线

部署按 **Gitea 远端 commit** 构建，不是本机未保存的文件。改完代码后：

1. **commit**（含 `pnpm-lock.yaml` 若有依赖变更）
2. **push** 到 Gitea —— 工作树有未提交或未 push 的变更时 daemon **拒绝构建**
3. 用户明确要求上线时，可以让用户在 TeamClu 应用列表里点「部署」，或调用
   `manage_app` 的 `deploy` action；它会按当前登录用户的应用权限执行

部署会发布到公网。除非用户明确要求上线，否则不要自行触发部署。

本地：`DATABASE_URL=postgres://… pnpm dev`（线上连接串由平台注入，本地常跑不通
DB，属正常）。

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

只有当访客**满足进入这个 app 的全部条件**时才会带上，所以在任何地方看到它们都只有一个
含义：这个人被允许进来。代理在写入前会先删掉客户端自带的同名请求头，伪造不了。

### 一个必须知道的边界

路径规则挡的是「谁能取到这个地址的响应」，不是「谁能看到这个界面」。应用内部的客户端
跳转不经过代理。**要保护的是数据**：把取数据的接口一并列进受保护路径。代理是外层，
app 自己的查询层才是真正的边界。

读身份用 `src/lib/platform-auth.ts` 的 `visitorFrom(headers)`，返回 `null` 就当作没人。
`auth_mode=platform` 时平台还会注入 `SUPABASE_URL` / `SUPABASE_ANON_KEY`（浏览器可达的
公开值，绝不是 service role），app 想自己用 supabase-js 可以取用 —— 但登录墙不依赖它们。
