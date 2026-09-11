# {{APP_NAME}}

你在维护一个叫 **{{APP_NAME}}** 的**演示材料**（app id `{{APP_ID}}`）。
它是一套用 reveal.js 渲染的 HTML 幻灯片。

## 内容放哪

全部内容在 `public/index.html`，规则只有一条：

> **一个 `<section>` 就是一页。**

```html
<div class="slides">
  <section><h2>标题</h2><p>正文</p></section>   <!-- 第一页 -->
  <section>…</section>                          <!-- 第二页 -->
</div>
```

`<section>` 里套 `<section>` 会变成向下翻的子页，用来把一个主题的细节收在一列里。

样式改 `public/styles.css`。换主题改 `index.html` 里那行
`<link ... href="/vendor/theme/white.css" id="theme">` —— `/vendor/theme/` 下有
reveal 自带的全部主题（black、white、league、solarized 等）。

## 不要动的东西

- **`server.mjs` 和 `build.mjs`** —— 它们保证 `pnpm build` 产出
  `.output/server/index.mjs` 且监听 `$PORT`，这是平台部署这个 app 的唯一契约。
  `build.mjs` 还负责把 reveal.js 从 `node_modules` 拷进 `/vendor/`。
- **不要改成从 CDN 加载 reveal.js** —— 运行环境的出网不保证，deck 会白屏。
- **`pnpm-lock.yaml`** —— 故意提交并锁死版本。构建用
  `pnpm install --frozen-lockfile`；曾经有依赖用 caret 范围，上游一次发布就把所有
  app 的构建打挂了。

## 部署声明（`teamclu.app.json`）

仓根 `teamclu.app.json` 声明**怎么构建、怎么启动**，平台按其中的 `build` + `start` 部署到 FC Custom Runtime：

- 改 `build.kind` / `start.command` / `start.port` 以匹配 FC Custom Runtime（本模板默认 Node：`build.kind: "node"`，`start.command: ["/opt/nodejs20/bin/node"]`，`args: ["server/index.mjs"]`，`port: 9000`）。
- **不要用**旧字段 `runtime` / `entry` —— 缺 `build` + `start` 或仍带 legacy 字段时部署会被拒。
- 改完 **commit + push**；用户明确要求上线后，再通过控制面或 `manage_app deploy` 部署。

## 怎么上线

部署按 **Gitea 远端 commit** 构建。改完幻灯片后：

1. **commit** 到本地 git
2. **push** 到 Gitea（有未 push 的 commit 时部署会被拒绝）
3. 用户明确要求上线时，可以让用户在 TeamClu 应用列表里点「部署」，或调用
   `manage_app` 的 `deploy` action；它会按当前登录用户的应用权限执行

部署会发布到公网。除非用户明确要求上线，否则不要自行触发部署。

本地预览：`pnpm dev`，打开 `http://localhost:9000`。左右键翻页，`S` 演讲者视图，
`Esc` 总览。

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

演示材料是纯静态的。要存数据的需求，请告诉用户建一个「数据操作」类型的应用。
