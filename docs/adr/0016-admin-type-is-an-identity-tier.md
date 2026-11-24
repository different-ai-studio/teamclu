---
status: accepted
---

# `public.users.admin_type` 是身份等级，不是权限

`admin_type` 在 TeamClu 里只回答两个问题：

1. 这个身份**是不是组织的正式成员**（`>= 2`）——能不能登录 TeamClu 客户端、
   能不能出现在身份选择里；
2. 这个身份**是不是平台运营**（`= 4` 且 `org_id = amux.platform_org_id()`）。

其他一切权限都由 org 角色（`amux.org_roles_users`，见
`docs/specs/2026-09-15-org-roles-permissions-design.md`）决定。

## 取值

| 值 | 名称 | 含义 | 谁写入 |
|---|---|---|---|
| 0 | 未知 | 不写入；只是代码读到 NULL 时的兜底 | — |
| 1 | 访客 `GUEST` | 在这个 org 有身份，但不是正式成员（例：只登录过一个团队应用的人） | 列默认值；手机号登录应用时新建（`phone-auth.ts`）；非成员邀请来的 agent |
| 2 | 成员 `MEMBER` | org 的正式成员，人或 agent | 接受成员邀请（`amux.ensure_member_identity`）；成员邀请来的 agent；支持账号（`amux.ensure_support_identity`） |
| 3 | 创建者 `CREATOR` | 创建这个 org 的人 | `amux.ensure_personal_org` |
| 4 | 平台运营 `PLATFORM_OPERATOR` | 运营这个部署的人；只在 platform org 里有效 | TeamClu 不写；由部署方 / service_role 设置 |

常量：`services/fc/src/lib/admin-type.ts`、`packages/app/src/lib/auth/admin-type.ts`、
`AMUXCore/Onboarding/AdminType.swift`。SQL 里的同一条线是
`amux.is_teamclu_identity()` / `amux.caller_employee_orgs()`（`>= 2`）和
`amux.is_platform_operator()`（`= 4`）。

## 规则

- **代码里只允许两种判断**：`isMember(t)`（`>= 2`）和平台运营判定（`= 4` 且在
  platform org，只在 SQL `amux.is_platform_operator` 里做）。不要用 `= 3`、`>= 3`
  授予任何能力——创建者要做的事走 org 角色。
- **只在 INSERT 时写**，之后不改。共用库上 `prevent_admin_type_change` 只放
  service_role 更新这一列；agent 账号轮换时也必须保留运营授予的值。
- **agent 封顶 2**，即使主人是 3 或 4。
- **platform org 之外的 4 当 3 看**：没有运营权限。
- **展示只是提示**：标签按上表给。客户端的身份选择（桌面、iOS）列的都是不同
  org 的身份，2 是常态，不标；应用登录页列的是同一个 org 里的几个身份，等级正
  是区别所在，四个值都标。客户端不知道 platform org，所以 4 的标签不代表权限。
- 不加 `CHECK` 约束：在共用库上这张表不归我们，两边结构要一致。约束在代码层。

## 为什么

这一列来自 saas-mono（`public.users` 是它的租户表，见
`docs/specs/2026-06-08-teamclu-saas-mono-integration.md`），值的含义也是它的：
1 是「会员卡」，2+ 是员工，4 是 SYSTEM_ADMIN。TeamClu 沿用这张表，但把 Betly 的
含义写进了自己的逻辑和界面——登录页把 1 叫「会员」，桌面端和 iOS 把每个被邀请
的普通成员（2）显示成「管理员」，注释里到处是「健身房会员卡」。数字散落在 FC、
桌面、iOS、Expo 和十几条迁移里，没有一处说明 TeamClu 自己怎么理解它们。

表本身我们需要（多身份、一人一 org 一身份），所以保留表，重新定义值。选这五个
值是因为它们恰好和 saas-mono 的两条边界重合（`>= 2` 员工、`4` 平台管理员），共用
库上已有的行不需要迁移。

## 已知的不一致

共用库上由 saas-mono 写入的 3 不一定是「创建者」——在那边它是更高一级的管理员。
TeamClu 不依赖 3 的含义（规则一），只有展示标签会不准确；可以接受。
