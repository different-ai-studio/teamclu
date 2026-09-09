# {{APP_NAME}}

你在维护一个叫 **{{APP_NAME}}** 的**静态网页**应用（app id `{{APP_ID}}`）。

## 内容放哪

网站的全部内容在 `public/`：

- `public/index.html` — 首页
- `public/styles.css` — 样式
- 想加页面就在 `public/` 下加 `.html`，想加图片/字体也放这里

`public/` 下的东西按原路径提供服务：`public/about.html` → `/about.html`，
目录会回落到该目录的 `index.html`，找不到的路径回落到首页。

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

- **`server.mjs` 和 `build.mjs`** —— 它们保证 `pnpm build` 产出
  `.output/server/index.mjs` 且监听 `$PORT`。这是平台部署这个 app 的唯一契约，
  改坏了就传不上去。要加功能请改 `public/`，不要改服务器。
- **`pnpm-lock.yaml`** —— 故意提交并锁死版本。构建时用的是
  `pnpm install --frozen-lockfile`；曾经有一次依赖用了 caret 范围，上游发了个新版本
  就把所有 app 的构建打挂了。

## 怎么上线

部署按 **Gitea 远端 commit** 构建，不是按本机未保存的文件。改完代码后：

1. **commit** 到本地 git
2. **push** 到 Gitea（未 push 的 commit 部署时会被拒绝）
3. 让用户在 TeamClu 应用列表里点「部署」，并选中刚 push 的 commit

你不需要、也没有权限自己触发部署 —— 把改动 commit + push 好，剩下的交给用户。

本地预览：`pnpm dev`，打开 `http://localhost:9000`。

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

**静态模板同样受保护。** 这一点和以前的说明相反：因为墙在代理层而不在应用代码里，纯静态
的页面和资源一样挡得住，不需要再建「数据操作」类型的应用才能加登录。

## 没有数据库

这是纯静态应用，没有后端、没有数据库。如果用户要的功能需要存数据，
告诉他们应该建一个「数据操作」类型的应用。
