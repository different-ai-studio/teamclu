# Team Skill 退役与硬删 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 团队 owner/admin 可以退役或硬删 registry skill；普通成员仍可发布、改元数据、卸载自己的包。

**Architecture:** 不新增端点。`DELETE /v1/teams/:id/skills/:slug` 与带 `status`/`supersededBy` 的 `PATCH` 在 FC 应用层走与 knowledge ACL 相同的 `requireTeamAdmin`（`team_members.role` 为 `owner` 或 `admin`）。RLS 把 DELETE 收回 admin-only；`status`/`superseded_by` 变更用 `BEFORE UPDATE` trigger 拒绝非 admin。桌面端列表 hover 垃圾桶和详情底部「退役 / 恢复发布 / 从团队移除」用 `canManageTeam` 藏按钮。对账算法不改。

**Tech Stack:** Cloud API (`services/fc` + caller JWT Supabase)、Postgres RLS/trigger、React 19 桌面端 (`packages/app`)、Vitest、Node test runner、pgTAP。

**Spec:** `docs/specs/2026-09-16-team-skill-retire-and-delete-design.md`

## Global Constraints

- 403 文案必须是 `team owner or admin access required`（错误码 `forbidden`），与 knowledge ACL 相同。
- 「团队管理员」= `team_members.role` 为 `owner` 或 `admin`。`owner_actor_id` 不是权限，不要加回旁路。
- 发布 / 发新版 / revert / 改 summary 等仍对任意成员开放。卸载仍是 per-actor。
- 退役只从 `published`；恢复只回到 `published`（不回到 `draft`）。`draft` 只给硬删。
- 允许跳过退役直接硬删。不要强制两步。
- 硬删对话框继续输入 slug。退役对话框可逆，不要输入 slug。
- Coral 不用于退役/硬删。
- 不做 blob GC、MQTT、tombstone、iOS/Expo 管理面、受影响 Agent 计数。
- **不要在 `feat/contacts-set-admin-role` 上改。** 从 `main` 开 `feat/team-skill-retire-and-delete`，把 spec 一起带上。

---

### Task 1: FC 应用层门 + OpenAPI + 架构文档鉴权勘误

**Files:**
- Create: `services/fc/test/team-skills-admin.test.ts`
- Modify: `services/fc/src/lib/supabase-repo.ts` (`requireTeamAdmin` 新方法；`updateTeamSkill` ~5969；`deleteTeamSkill` ~6018)
- Modify: `docs/openapi/teamclu-api.v1.yaml` (`updateTeamSkill` ~2271；`deleteTeamSkill` ~2305)
- Modify: `docs/architecture/team-skills-registry.md` §5 鉴权段 ~164–178
- Modify: `docs/specs/2026-09-16-team-skill-retire-and-delete-design.md` Status → APPROVED（本任务提交时 spec 已随分支进入）

**Interfaces:**
- Consumes: 现有 `resolveCallerActorForTeam(teamId): Promise<{ id: string } | null>`；`ApiError`；`updateTeamSkill` / `deleteTeamSkill` 签名不变
- Produces: `requireTeamAdmin(teamId: string): Promise<string>`（返回 caller actor id）。`deleteTeamSkill` 一律先调用。`updateTeamSkill` 仅当 `patch.status !== undefined || patch.supersededBy !== undefined` 时调用。

- [ ] **Step 1: 从 main 开分支并带上 spec**

```bash
git fetch origin main
git checkout -b feat/team-skill-retire-and-delete origin/main
# 若 spec 还在上一工作区：拷到本分支 docs/specs/2026-09-16-team-skill-retire-and-delete-design.md
```

把 spec 的 Status 改成 `APPROVED`。

- [ ] **Step 2: 写失败的仓库层测试**

新建 `services/fc/test/team-skills-admin.test.ts`。不要复用 `supabase-repo.test.ts` 里那个没有 `.delete()` 的 `fakeSupabase`；本文件自带最小 fake。

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseBusinessRepository } from "../src/lib/supabase-repo.js";
import { ApiError } from "../src/lib/http-utils.js";

const TEAM = "team-1";
const ACTOR = "actor-member-1";
const SKILL_ROW = {
  id: "skill-1",
  team_id: TEAM,
  slug: "deploy-check",
  owner_actor_id: ACTOR,
  summary: "preflight",
  category: "devops",
  when_to_use: "before ship",
  when_not_to_use: "not local",
  requires: null,
  status: "published",
  superseded_by: null,
  latest_version: 3,
  created_by: ACTOR,
  origin: "local",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function repoFor(role: "member" | "admin" | "owner" | null) {
  const deleted: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const updates: unknown[] = [];
  const supabase = {
    auth: {
      async getUser() {
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters[column] = value; return builder; },
        limit() { return builder; },
        async maybeSingle() {
          if (table === "actors") return { data: { id: ACTOR }, error: null };
          if (table === "team_members") {
            return { data: role ? { role } : null, error: null };
          }
          if (table === "team_skills") return { data: { ...SKILL_ROW }, error: null };
          return { data: null, error: null };
        },
        update(row: unknown) {
          updates.push(row);
          return builder;
        },
        delete() {
          deleted.push({ table, filters });
          return builder;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const repo = createSupabaseBusinessRepository({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    accessToken: "caller-token",
    createClient: () => supabase,
    createServiceRoleClient: () => supabase,
  });
  return { repo, deleted, updates };
}

test("member cannot delete a team skill", async () => {
  const { repo, deleted } = repoFor("member");
  await assert.rejects(
    () => repo.deleteTeamSkill(TEAM, "deploy-check"),
    (err: unknown) =>
      err instanceof ApiError &&
      err.statusCode === 403 &&
      err.code === "forbidden" &&
      err.message === "team owner or admin access required",
  );
  assert.equal(deleted.length, 0);
});

test("member cannot deprecate a team skill", async () => {
  const { repo, updates } = repoFor("member");
  await assert.rejects(
    () => repo.updateTeamSkill(TEAM, "deploy-check", { status: "deprecated" }),
    (err: unknown) => err instanceof ApiError && err.statusCode === 403,
  );
  assert.equal(updates.length, 0);
});

test("member can still patch summary", async () => {
  const { repo, updates } = repoFor("member");
  await repo.updateTeamSkill(TEAM, "deploy-check", { summary: "new summary" });
  assert.deepEqual(updates[0], { summary: "new summary" });
});

test("admin can delete a team skill", async () => {
  const { repo, deleted } = repoFor("admin");
  await repo.deleteTeamSkill(TEAM, "deploy-check");
  assert.equal(deleted[0]?.table, "team_skills");
});

test("owner can deprecate with supersededBy", async () => {
  const { repo, updates } = repoFor("owner");
  const row = await repo.updateTeamSkill(TEAM, "deploy-check", {
    status: "deprecated",
    supersededBy: "hotfix-deploy",
  });
  assert.equal(row.status, "deprecated");
  assert.deepEqual(updates[0], {
    status: "deprecated",
    superseded_by: "hotfix-deploy",
  });
});
```

注意：admin deprecate 测试里 fake 的 `maybeSingle` 在 update 链上仍返回 `SKILL_ROW`（status published）。实现后要把 update 后的 `maybeSingle` 返回合并了 patch 的行，或让测试只断言 `updates[0]`、不断言 `row.status`。**落地时改测试的 fake：当 `builder.update` 被调用后，`maybeSingle` 返回 `{ ...SKILL_ROW, ...row, superseded_by: row.superseded_by }`。** 上面第五个测试若因 fake 返回旧行失败，先修 fake 再修实现。

- [ ] **Step 3: 跑测试，确认失败**

```bash
cd services/fc && pnpm exec node --import tsx --test test/team-skills-admin.test.ts
```

Expected: FAIL — member delete 现在会走进 `from("team_skills").delete()` 而不是 403（`deleted.length` 不为 0，或 `assert.rejects` 失败）。

- [ ] **Step 4: 实现 `requireTeamAdmin` 并接到 update/delete**

在 `createSupabaseBusinessRepository` 返回的对象上、紧挨 `deleteTeamSkill` 之前加：

```ts
async requireTeamAdmin(teamId) {
  const actor = await this.resolveCallerActorForTeam(teamId);
  if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
  const { data, error } = await supabase
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("member_id", actor.id)
    .maybeSingle();
  if (error) throw error;
  if (data?.role !== "owner" && data?.role !== "admin") {
    throw new ApiError(403, "forbidden", "team owner or admin access required");
  }
  return actor.id;
},
```

谓词必须与 `services/fc/src/lib/supabase-repo/knowledge-acl.ts` 的 `requireTeamAdmin` 相同。本轮不要去重构 knowledge-acl。

`deleteTeamSkill`：

```ts
async deleteTeamSkill(teamId, slug) {
  await this.requireTeamAdmin(teamId);
  const { error } = await supabase
    .from("team_skills")
    .delete()
    .eq("team_id", teamId)
    .eq("slug", slug);
  if (error) {
    if (error.code === "42501") {
      throw new ApiError(403, "forbidden", "team owner or admin access required");
    }
    throw error;
  }
},
```

`updateTeamSkill` 在读 `existing` **之前**：

```ts
if (patch.status !== undefined || patch.supersededBy !== undefined) {
  await this.requireTeamAdmin(teamId);
}
```

update 的 supabase error 同样映射 `42501` → 403（`revertTeamSkillVersion` 已有此映射；当前 `updateTeamSkill` 没有）。

不要靠 DELETE 的 error 当 403：PostgREST 在 RLS 挡住 DELETE 时经常 0-row 静默成功。

- [ ] **Step 5: 再跑测试，确认通过**

```bash
cd services/fc && pnpm exec node --import tsx --test test/team-skills-admin.test.ts
```

Expected: PASS（5 tests）。顺手跑 `pnpm exec node --import tsx --test test/team-skills.test.ts`，路由层 PATCH deprecate 测试应仍绿（鉴权在 repo，不在路由）。

- [ ] **Step 6: OpenAPI + 架构文档**

`updateTeamSkill` 在 `summary: Edit metadata, transfer owner, deprecate` 下加：

```yaml
description: >
  Any team member may patch summary, category, whenToUse, whenNotToUse,
  requires, and ownerActorId. Changing `status` or `supersededBy`
  (deprecate / restore published) requires team owner or admin.
```

`deleteTeamSkill` 加：

```yaml
description: >
  Hard-delete the registry row for the whole team. Requires team owner
  or admin. Version history and install rows cascade. Absence from the
  list is the deletion signal; there is no tombstone.
```

`docs/architecture/team-skills-registry.md` §5：

- 端点表补一行：`DELETE | /v1/teams/:id/skills/:slug | 从 registry 硬删（仅 owner/admin）`
- 把「发版 / 撤回 / 改元数据 / 删除都对任何成员开放」改成：发版 / 撤回 / 改元数据仍对任何成员开放；**删除和 PATCH 的 `status` / `supersededBy` 仅 owner/admin**。注明翻案出处 `docs/specs/2026-09-16-team-skill-retire-and-delete-design.md`。保留 2026-08-13 那段关于「registry 不是发布者私产」的理由，明确它不再覆盖删除。

- [ ] **Step 7: Commit**

```bash
git add services/fc/test/team-skills-admin.test.ts \
  services/fc/src/lib/supabase-repo.ts \
  docs/openapi/teamclu-api.v1.yaml \
  docs/architecture/team-skills-registry.md \
  docs/specs/2026-09-16-team-skill-retire-and-delete-design.md
git commit -m "$(cat <<'EOF'
feat(skills): require team admin to delete or deprecate registry skills

Member writes stay open for publish and metadata. Status changes and
hard-delete are owner/admin only, matching knowledge ACL.
EOF
)"
```

---

### Task 2: RLS DELETE 收口 + status trigger + pgTAP

**Files:**
- Create: `services/supabase/migrations/20260916000000_team_skills_admin_retire.sql`
- Create: `services/supabase/tests/038_team_skills_admin_retire.sql`

**Interfaces:**
- Consumes: `amux.is_team_admin_or_owner(uuid)`（已有，SECURITY DEFINER）
- Produces: policy `team_skills_delete_if_owner_or_admin`；function + trigger `amux.team_skills_status_admin_only` / `team_skills_status_admin_only`

若 `038_` 已被别的 PR 占用，改用目录里下一个空号，**不要**覆盖 `037_set_team_member_role.sql`。

- [ ] **Step 1: 写失败的 pgTAP**

`services/supabase/tests/038_team_skills_admin_retire.sql`，风格对齐 `037_set_team_member_role.sql`（`as_member` + 插入 team/actors/members/team_members）。额外插入一行 `amux.team_skills`（必填：`summary`/`category`/`when_to_use`/`when_not_to_use`/`status='published'`/`slug` 符合 `^[a-z0-9][a-z0-9-]{1,63}$`）。

断言：

1. 以 member JWT：`DELETE FROM amux.team_skills WHERE slug = 'deploy-check'` 不抛错，但随后 `SELECT count(*)` 仍为 1。
2. 以 member JWT：`UPDATE amux.team_skills SET status = 'deprecated'` 抛 `42501`。
3. 以 member JWT：`UPDATE amux.team_skills SET summary = 'still allowed'` 成功。
4. 以 admin JWT：`DELETE` 后 count 为 0。

在迁移落地前，(1) 会失败（member 现在删得掉），(2) 会失败（没有 trigger）。

- [ ] **Step 2: 本地或 CI 方式跑测试，确认失败**

```bash
cd services/supabase/tests && ./run.sh 038_team_skills_admin_retire.sql
```

没有本地 Postgres 时，等 CI 的 pgtap job；实现迁移后再跑同一条命令。Expected 在迁移前：member DELETE 真的删行。

- [ ] **Step 3: 写迁移**

`services/supabase/migrations/20260916000000_team_skills_admin_retire.sql`：

```sql
-- Team skills: hard-delete and status/superseded_by changes are owner/admin only.
-- Spec: docs/specs/2026-09-16-team-skill-retire-and-delete-design.md
-- Do not restore the owner_actor_id bypass; that column is display, not ACL.

drop policy if exists team_skills_delete_if_member on amux.team_skills;
drop policy if exists team_skills_delete_if_owner_or_admin on amux.team_skills;
create policy team_skills_delete_if_owner_or_admin on amux.team_skills
  for delete using (amux.is_team_admin_or_owner(team_id));

create or replace function amux.team_skills_status_admin_only()
returns trigger
language plpgsql
as $$
begin
  if NEW.status is distinct from OLD.status
     or NEW.superseded_by is distinct from OLD.superseded_by then
    if not amux.is_team_admin_or_owner(NEW.team_id) then
      raise exception 'team owner or admin access required' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists team_skills_status_admin_only on amux.team_skills;
create trigger team_skills_status_admin_only
  before update on amux.team_skills
  for each row
  execute function amux.team_skills_status_admin_only();
```

`team_skills_update_if_member` **不要动**。

- [ ] **Step 4: 再跑 pgTAP**

```bash
cd services/supabase/tests && ./run.sh 038_team_skills_admin_retire.sql
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add services/supabase/migrations/20260916000000_team_skills_admin_retire.sql \
  services/supabase/tests/038_team_skills_admin_retire.sql
git commit -m "$(cat <<'EOF'
fix(skills): gate registry delete and status changes at RLS

Application checks can be skipped via PostgREST; DELETE must not
succeed for members, and status/superseded_by needs a trigger.
EOF
)"
```

---

### Task 3: Store — `deprecateTeamSkill` / `restoreTeamSkill` + 修正 delete 注释

**Files:**
- Modify: `packages/app/src/stores/team-share-browser.ts`（接口 ~287；实现紧挨 `deleteTeamSkill` ~1394）
- Create: `packages/app/src/stores/__tests__/team-share-deprecate-team-skill.test.ts`
- Modify: `packages/app/src/stores/__tests__/team-share-delete-team-skill.test.ts` 仅当注释相关测试需要（通常不用改）

**Interfaces:**
- Consumes: `getBackend().teamSkills.updateTeamSkill(teamId, slug, patch)`（已有）
- Produces:

```ts
deprecateTeamSkill: (slug: string, supersededBy?: string | null) => Promise<void>
restoreTeamSkill: (slug: string) => Promise<void>
```

不要复用 `SkillMutationAction` 的 `'restore'`——那是 `restoreDiscardedSkill`（从垃圾桶恢复本地草稿）。退役/恢复不改磁盘包，**不要** `reconcileSkills`，**不要** `refreshAfterMutation`。调用：`updateTeamSkill` → `loadSection('skills', { force: true })` → `dispatchEvent(SKILLS_CHANGED_EVENT)`。

- [ ] **Step 1: 写失败的 store 测试**

`packages/app/src/stores/__tests__/team-share-deprecate-team-skill.test.ts`，mock 对齐 `team-share-delete-team-skill.test.ts`：

```ts
const updateTeamSkill = vi.fn(async () => ({}))
vi.mock('@/lib/backend/provider', () => ({
  getBackend: () => ({ teamSkills: { updateTeamSkill } }),
}))
```

用例：

- `deprecateTeamSkill('deploy-check', 'hotfix-deploy')` 调用 `updateTeamSkill('team-1', 'deploy-check', { status: 'deprecated', supersededBy: 'hotfix-deploy' })`，并 `loadSection` 一次。
- `deprecateTeamSkill('deploy-check')` 传 `{ status: 'deprecated', supersededBy: null }`。
- `restoreTeamSkill('deploy-check')` 传 `{ status: 'published', supersededBy: null }`。
- 非 registry 行 → throw `not a team skill`，不发 PATCH。
- 无当前团队 → throw `no current team`。

- [ ] **Step 2: 跑测试，确认失败**

```bash
pnpm --filter @teamclu/app test:unit -- src/stores/__tests__/team-share-deprecate-team-skill.test.ts
```

Expected: FAIL — `deprecateTeamSkill is not a function`。

- [ ] **Step 3: 实现**

接口注释改掉 `deleteTeamSkill` 的「Deliberately ungated: any member can delete」。改成：API 拒绝非 admin；UI 用 `canManageTeam` 藏入口；store 不再读角色。

```ts
deprecateTeamSkill: async (slug, supersededBy = null) => {
  const teamId = currentTeamId()
  if (!teamId) throw new Error('no current team')
  const skill = get().skills.items.find((s) => s.origin === 'registry' && s.slug === slug)
  if (!skill) throw new Error(`${slug} is not a team skill`)
  await getBackend().teamSkills.updateTeamSkill(teamId, slug, {
    status: 'deprecated',
    supersededBy,
  })
  await get().loadSection('skills', { force: true })
  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
},

restoreTeamSkill: async (slug) => {
  const teamId = currentTeamId()
  if (!teamId) throw new Error('no current team')
  const skill = get().skills.items.find((s) => s.origin === 'registry' && s.slug === slug)
  if (!skill) throw new Error(`${slug} is not a team skill`)
  await getBackend().teamSkills.updateTeamSkill(teamId, slug, {
    status: 'published',
    supersededBy: null,
  })
  await get().loadSection('skills', { force: true })
  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT))
},
```

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter @teamclu/app test:unit -- src/stores/__tests__/team-share-deprecate-team-skill.test.ts src/stores/__tests__/team-share-delete-team-skill.test.ts src/stores/__tests__/team-share-skill-retired.test.ts
```

Expected: PASS。retired / dirty-kept 路径未改，必须继续绿。

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/stores/team-share-browser.ts \
  packages/app/src/stores/__tests__/team-share-deprecate-team-skill.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): add store actions to deprecate and restore team skills

Status-only patches; packs stay on disk until a hard delete.
EOF
)"
```

---

### Task 4: 列表 — 按 `canManageTeam` 打开硬删入口 + 补对话框文案

**Files:**
- Create: `packages/app/src/lib/skills/registry-deletable.ts`
- Create: `packages/app/src/lib/skills/__tests__/registry-deletable.test.ts`
- Modify: `packages/app/src/components/sidebar/TeamShareListColumn.tsx`（`deletableSlug: undefined` ~641；`DeleteTeamSkillDialog` 描述 ~168）
- Modify: `packages/app/src/locales/en.json`、`zh-CN.json`（`teamShare.skillDeleteTeamConfirm`）
- Modify: `packages/app/src/components/sidebar/__tests__/DeleteTeamSkillDialog.test.tsx`（若文案断言写死了旧句子）

**Interfaces:**
- Consumes: `useTeamPermissions().canManageTeam`；skill `origin` / `slug`
- Produces:

```ts
export function teamSkillDeletableSlug(
  canManageTeam: boolean,
  origin: string | undefined,
  slug: string,
): string | undefined
```

规则：`canManageTeam && origin === 'registry' ? slug : undefined`。市场 adopt 的行 `origin === 'registry'`，可删。个人 pack 不可。

- [ ] **Step 1: 写失败的 helper 测试**

```ts
import { describe, expect, test } from 'vitest'
import { teamSkillDeletableSlug } from '../registry-deletable'

describe('teamSkillDeletableSlug', () => {
  test('admin can delete a registry row', () => {
    expect(teamSkillDeletableSlug(true, 'registry', 'deploy-check')).toBe('deploy-check')
  })
  test('member never sees the control', () => {
    expect(teamSkillDeletableSlug(false, 'registry', 'deploy-check')).toBeUndefined()
  })
  test('personal packs are not this path', () => {
    expect(teamSkillDeletableSlug(true, 'personal', 'notes')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
pnpm --filter @teamclu/app test:unit -- src/lib/skills/__tests__/registry-deletable.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 helper 并接到列表**

```ts
export function teamSkillDeletableSlug(
  canManageTeam: boolean,
  origin: string | undefined,
  slug: string,
): string | undefined {
  if (!canManageTeam || origin !== 'registry') return undefined
  return slug
}
```

`TeamShareListColumn`：

```ts
const { canManageTeam } = useTeamPermissions()
```

把 `deletableSlug: undefined` 换成：

```ts
deletableSlug: teamSkillDeletableSlug(canManageTeam, s.origin, s.slug),
```

`DeleteTeamSkillDialog` 的 `skillDeleteTeamConfirm` 默认文案补一句（en + zh-CN 都要改 key 正文）：

en: `Remove "{{name}}" from the team registry? Every member loses it, and it uninstalls on their machines within about 10 minutes. Local unpublished edits stay as a personal copy. Version history is deleted and cannot be undone.`

zh: `将「{{name}}」从团队 registry 移除？所有成员都会看不到它，通常 10 分钟内从各自机器卸载。本机未发布的改动会留下个人副本。版本历史一并删除，无法撤销。`

列表不要放退役入口。

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter @teamclu/app test:unit -- src/lib/skills/__tests__/registry-deletable.test.ts src/components/sidebar/__tests__/DeleteTeamSkillDialog.test.tsx
```

Expected: PASS。若 dialog 测试按旧中文断言，改断言匹配新 fallback。

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/skills/registry-deletable.ts \
  packages/app/src/lib/skills/__tests__/registry-deletable.test.ts \
  packages/app/src/components/sidebar/TeamShareListColumn.tsx \
  packages/app/src/components/sidebar/__tests__/DeleteTeamSkillDialog.test.tsx \
  packages/app/src/locales/en.json \
  packages/app/src/locales/zh-CN.json
git commit -m "$(cat <<'EOF'
feat(skills): show team-skill delete only to owner/admin

The confirm dialog already existed; the list had hardcoded it off.
EOF
)"
```

---

### Task 5: 详情 — 管理员退役 / 恢复 / 从团队移除

**Files:**
- Create: `packages/app/src/components/teamshare/DeprecateTeamSkillDialog.tsx`
- Create: `packages/app/src/components/teamshare/TeamSkillAdminActions.tsx`
- Create: `packages/app/src/components/teamshare/__tests__/TeamSkillAdminActions.test.tsx`
- Create: `packages/app/src/components/teamshare/__tests__/DeprecateTeamSkillDialog.test.tsx`
- Modify: `packages/app/src/components/teamshare/SkillDetail.tsx`（registry 详情底部接入；顶栏 Uninstall 不动）
- Modify: `packages/app/src/locales/en.json`、`zh-CN.json`

**Interfaces:**
- Consumes: Task 3 的 `deprecateTeamSkill` / `restoreTeamSkill` / `deleteTeamSkill`；`useTeamPermissions().canManageTeam`；已导出的 `DeleteTeamSkillDialog`
- Produces:

```ts
export function TeamSkillAdminActions(props: {
  canManageTeam: boolean
  origin: string
  status: 'draft' | 'published' | 'deprecated' | string
  slug: string
  publishedSlugs: string[]
  busy?: boolean
  onDeprecate: (supersededBy: string | null) => void
  onRestore: () => void
  onDelete: () => void
}): React.ReactElement | null
```

`canManageTeam === false` 或 `origin !== 'registry'` → 返回 `null`。

按钮规则：

- `status === 'published'` → 次要按钮「退役」（variant ghost / outline，**不要** `bg-coral`）
- `status === 'deprecated'` → 次要按钮「恢复发布」
- 任意 registry status → 文字链「从团队移除…」

`DeprecateTeamSkillDialog`：确认即可，不要输入 slug。可选 native `<select>`（不要 radix Select，测试更简单），选项 = `publishedSlugs`（不含自己），第一项「无替代」。提交 `onConfirm(selected || null)`。

- [ ] **Step 1: 写失败的 UI 测试**

`TeamSkillAdminActions.test.tsx`（i18n mock 对齐 `DeleteTeamSkillDialog.test.tsx`）：

- member：`canManageTeam=false` → 没有「退役」「从团队移除」
- admin + published：有「退役」和「从团队移除…」；点退役调用测试注入的 `onDeprecate` 打开对话框（组件内自己 hold deprecate open state 也可以：点退役后出现 dialog title）
- admin + deprecated：有「恢复发布」，没有「退役」
- admin + draft：没有「退役」，有「从团队移除…」

`DeprecateTeamSkillDialog.test.tsx`：

- 不输入 slug 即可点确认
- 选替代 slug 后 confirm 带着该 slug
- 不选替代 → confirm `null`

- [ ] **Step 2: 跑测试，确认失败**

```bash
pnpm --filter @teamclu/app test:unit -- src/components/teamshare/__tests__/TeamSkillAdminActions.test.tsx src/components/teamshare/__tests__/DeprecateTeamSkillDialog.test.tsx
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现组件并接到 SkillDetail**

i18n keys（en / zh-CN 都加）：

| key | en | zh-CN |
|---|---|---|
| `teamShare.skillDeprecate` | Deprecate | 退役 |
| `teamShare.skillDeprecateTitle` | Deprecate team skill | 退役团队 Skill |
| `teamShare.skillDeprecateConfirm` | Mark "{{name}}" deprecated? Installed copies stay until someone uninstalls or the skill is removed from the team. | 将「{{name}}」标为退役？已安装的副本会留着，直到有人卸载或从团队移除。 |
| `teamShare.skillDeprecateReplacement` | Replacement (optional) | 替代 skill（可选） |
| `teamShare.skillDeprecateNoReplacement` | None | 无替代 |
| `teamShare.skillDeprecateDone` | Deprecated | 已退役 |
| `teamShare.skillDeprecateFailed` | Deprecate failed: {{msg}} | 退役失败：{{msg}} |
| `teamShare.skillRestorePublished` | Restore published | 恢复发布 |
| `teamShare.skillRestorePublishedDone` | Restored to published | 已恢复发布 |
| `teamShare.skillRestorePublishedFailed` | Restore failed: {{msg}} | 恢复失败：{{msg}} |
| `teamShare.skillDeleteTeamFromDetail` | Remove from team… | 从团队移除… |

`SkillDetail` 在 VersionHistory 与编辑器之间插入：

```tsx
{isRegistry && (
  <TeamSkillAdminActions
    canManageTeam={canManageTeam}
    origin={item.origin}
    status={item.status}
    slug={item.slug}
    publishedSlugs={skills.items
      .filter((s) => s.origin === 'registry' && s.status === 'published' && s.slug !== item.slug)
      .map((s) => s.slug)}
    busy={busy}
    onDeprecate={(supersededBy) => {
      void deprecateTeamSkill(item.slug, supersededBy)
        .then(() => toast.success(t('teamShare.skillDeprecateDone', '已退役')))
        .catch((e) => toast.error(/* skillDeprecateFailed */))
    }}
    onRestore={() => {
      void restoreTeamSkill(item.slug)
        .then(() => toast.success(t('teamShare.skillRestorePublishedDone', '已恢复发布')))
        .catch((e) => toast.error(/* skillRestorePublishedFailed */))
    }}
    onDelete={() => setDeleteTarget(item.slug)}
  />
)}
```

`setDeleteTarget` 打开已有 `DeleteTeamSkillDialog`（可从列表文件 import；详情自己 hold `deleteTarget` state）。**顶栏 Uninstall 保持给 `team-installed` 的全员入口，不要和「从团队移除」放在同一组。**

403 toast 用 API 返回的 `team owner or admin access required`，不要装成网络错误。

恢复不需要确认框。

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter @teamclu/app test:unit -- \
  src/components/teamshare/__tests__/TeamSkillAdminActions.test.tsx \
  src/components/teamshare/__tests__/DeprecateTeamSkillDialog.test.tsx \
  src/lib/skills/__tests__/registry-deletable.test.ts \
  src/stores/__tests__/team-share-deprecate-team-skill.test.ts \
  src/stores/__tests__/team-share-delete-team-skill.test.ts \
  src/stores/__tests__/team-share-skill-retired.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/teamshare/DeprecateTeamSkillDialog.tsx \
  packages/app/src/components/teamshare/TeamSkillAdminActions.tsx \
  packages/app/src/components/teamshare/__tests__/TeamSkillAdminActions.test.tsx \
  packages/app/src/components/teamshare/__tests__/DeprecateTeamSkillDialog.test.tsx \
  packages/app/src/components/teamshare/SkillDetail.tsx \
  packages/app/src/locales/en.json \
  packages/app/src/locales/zh-CN.json
git commit -m "$(cat <<'EOF'
feat(skills): add deprecate and restore actions on skill detail

Uninstall stays per-actor in the header. Team retirement lives at the
bottom and only renders for owner/admin.
EOF
)"
```

---

## Self-review (plan vs spec)

| Spec | Task |
|---|---|
| D1 两级生命周期 | 3 + 5 |
| D2 可跳过退役直接硬删 | 4 列表垃圾桶 + 5 文字链，无强制顺序 |
| D3/D4 owner/admin，无 owner_actor_id 旁路 | 1 + 2 |
| D5 发布仍对成员开放 | 1 的 summary PATCH 测试 |
| D6 卸载 per-actor | 5 明确不改顶栏 Uninstall |
| D7 应用层 + RLS/trigger | 1 + 2 |
| D8 无 blob GC / MQTT | 未列入任何 task |
| 退役不卸包 | 3 不调用 reconcileSkills |
| draft 只硬删 | 5 按钮规则 |
| 列表不放退役 | 4 |
| 硬删 10 分钟 / kept 文案 | 4 |
| OpenAPI / 架构勘误 | 1 |
| pgTAP | 2 |
| 前端 member 藏入口 | 4 + 5 |
| 受影响 Agent 数 | 明确不做 |

无 TBD。`restoreTeamSkill` 与已有 `restoreDiscardedSkill` / `'restore'` mutation 名称不碰撞。
