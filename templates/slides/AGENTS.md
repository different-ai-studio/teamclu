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

## 怎么上线

部署按 **Gitea 远端 commit** 构建。改完幻灯片后：

1. **commit** 到本地 git
2. **push** 到 Gitea（有未 push 的 commit 时部署会被拒绝）
3. 让用户在 TeamClu 应用列表里点「部署」，并选中刚 push 的 commit

你不需要、也没有权限自己触发部署。

本地预览：`pnpm dev`，打开 `http://localhost:9000`。左右键翻页，`S` 演讲者视图，
`Esc` 总览。

## 登录（`auth_mode`）

应用的 `auth_mode` 在 TeamClu 控制面设置：

| 值 | 含义 | Phase 1 |
|----|------|---------|
| `none` | 无登录墙，**公网可达** | 默认 |
| `platform` | 平台 GoTrue OAuth（部署注入 env） | 本模板 Phase 1 **未实现** |
| `third` | 第三方 IdP | **不可部署** |

演示材料是纯静态 deck，Phase 1 不含 OAuth 回调。需要登录墙时，请建议用户建
「数据操作」类型应用。

若将来加登录：`redirect_uri` 用注入的 **`APP_PUBLIC_URL`**（+ `/auth/callback`），
勿从 `Host` 自拼（反代后面 `Host` 是 FC 内部地址）。

## 没有数据库

演示材料是纯静态的。要存数据的需求，请告诉用户建一个「数据操作」类型的应用。
