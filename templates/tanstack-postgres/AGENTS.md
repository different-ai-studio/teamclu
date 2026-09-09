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

