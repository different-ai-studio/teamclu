import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applySessionTitlePatch } from "../src/lib/session-title-lock.js";

const MIGRATION = readFileSync(
  new URL("../../supabase/migrations/20261122120000_session_title_locked.sql", import.meta.url),
  "utf8",
);

type TitleWrite = { applied: boolean; title: string; title_locked: boolean };

async function migratedDb() {
  const db = new PGlite();
  await db.exec(`
    create schema amux;
    create table amux.sessions (
      id uuid primary key,
      title text not null
    );
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon;
      end if;
    end $$;
  `);
  const existing = "61122100-0000-4000-8000-000000000010";
  await db.query("insert into amux.sessions (id, title) values ($1, $2)", [
    existing,
    "Already there",
  ]);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  return { db, existing };
}

async function insertSession(db: PGlite, id: string, title: string) {
  await db.query("insert into amux.sessions (id, title) values ($1, $2)", [id, title]);
}

async function applyTitle(db: PGlite, id: string, title: string) {
  const out = await db.query<TitleWrite>(
    "select applied, title, title_locked from amux.apply_generated_session_title($1, $2)",
    [id, title],
  );
  return out.rows[0] ?? null;
}

async function stored(db: PGlite, id: string) {
  const out = await db.query<{ title: string; title_locked: boolean }>(
    "select title, title_locked from amux.sessions where id = $1",
    [id],
  );
  return out.rows[0];
}

test("a rename that lands before the generated title wins", () => {
  const locked = applySessionTitlePatch(
    { title: "Agent (09:30)", titleLocked: false },
    { title: "Standup (09:30)", titleLocked: true },
  );
  const after = applySessionTitlePatch(locked, { title: "深圳美食推荐" });
  assert.equal(after.title, "Standup (09:30)");
  assert.equal(after.titleLocked, true);
  assert.equal(after.titleApplied, false);
});

test("unlocked placeholders and a first-message summary can be replaced", () => {
  for (const current of ["", "New chat", "Agent (09:30)", "帮我查一下深圳美食"]) {
    const next = applySessionTitlePatch(
      { title: current, titleLocked: false },
      { title: "深圳美食推荐" },
    );
    assert.equal(next.title, "深圳美食推荐", current);
    assert.equal(next.titleLocked, false);
    assert.equal(next.titleApplied, true);
  }
});

test("a later manual rename replaces a generated title and stays locked", () => {
  const generated = applySessionTitlePatch(
    { title: "New chat", titleLocked: false },
    { title: "深圳美食推荐" },
  );
  const locked = applySessionTitlePatch(generated, { title: "项目讨论", titleLocked: true });
  const again = applySessionTitlePatch(locked, { title: "另一条生成标题" });
  assert.equal(again.title, "项目讨论");
  assert.equal(again.titleApplied, false);
  assert.equal(again.titleLocked, true);
});

test("migration leaves existing sessions unlocked and can run twice", async () => {
  const { db, existing } = await migratedDb();
  const row = await stored(db, existing);
  assert.equal(row.title, "Already there");
  assert.equal(row.title_locked, false);

  const fresh = "61122100-0000-4000-8000-000000000011";
  await insertSession(db, fresh, "New chat");
  assert.equal((await stored(db, fresh)).title_locked, false);

  const privileges = await db.query<{ who: string; allowed: boolean }>(`
    select who, has_function_privilege(who, 'amux.apply_generated_session_title(uuid, text)', 'EXECUTE') as allowed
    from (values ('authenticated'), ('service_role'), ('anon'), ('public')) as roles(who)
  `);
  const byRole = Object.fromEntries(privileges.rows.map((row) => [row.who, row.allowed]));
  assert.equal(byRole.authenticated, true);
  assert.equal(byRole.service_role, true);
  assert.equal(byRole.anon, false);
  assert.equal(byRole.public, false);
});

test("generated titles replace unlocked placeholders and summaries", async () => {
  const { db } = await migratedDb();
  const cases = [
    ["61122100-0000-4000-8000-0000000000e1", "", "From empty"],
    ["61122100-0000-4000-8000-0000000000e2", "New chat", "Standup"],
    ["61122100-0000-4000-8000-0000000000e3", "Agent (09:30)", "Launch Plan"],
    ["61122100-0000-4000-8000-0000000000e4", "帮我查一下深圳美食", "深圳美食推荐"],
  ] as const;
  for (const [id, current, next] of cases) {
    await insertSession(db, id, current);
    const written = await applyTitle(db, id, next);
    assert.ok(written);
    assert.equal(written.applied, true, current);
    assert.equal(written.title, next);
    assert.equal(written.title_locked, false);
    assert.equal((await stored(db, id)).title, next);
  }
});

test("a generated title after a manual rename does not overwrite or unlock", async () => {
  const { db } = await migratedDb();
  const id = "61122100-0000-4000-8000-0000000000e6";
  await insertSession(db, id, "Agent (10:01)");
  await db.query(
    "update amux.sessions set title = $2, title_locked = true where id = $1",
    [id, "Standup (09:30)"],
  );

  const first = await applyTitle(db, id, "深圳美食推荐");
  const second = await applyTitle(db, id, "另一条生成标题");
  const row = await stored(db, id);
  assert.equal(first?.applied, false);
  assert.equal(first?.title, "Standup (09:30)");
  assert.equal(second?.applied, false);
  assert.equal(second?.title_locked, true);
  assert.equal(row.title, "Standup (09:30)");
  assert.equal(row.title_locked, true);
});

test("a generated title that commits first can still be renamed and then locked", async () => {
  const { db } = await migratedDb();
  const id = "61122100-0000-4000-8000-0000000000e7";
  await insertSession(db, id, "New chat");
  const generated = await applyTitle(db, id, "深圳美食推荐");
  assert.equal(generated?.applied, true);
  await db.query(
    "update amux.sessions set title = $2, title_locked = true where id = $1",
    [id, "项目讨论"],
  );
  const after = await applyTitle(db, id, "另一条");
  const row = await stored(db, id);
  assert.equal(after?.applied, false);
  assert.equal(row.title, "项目讨论");
  assert.equal(row.title_locked, true);
});

test("a missing session and an already-locked row are left alone", async () => {
  const { db } = await migratedDb();
  const missing = await applyTitle(db, "61122100-0000-4000-8000-000000000099", "gone");
  assert.equal(missing, null);

  const id = "61122100-0000-4000-8000-0000000000e5";
  await insertSession(db, id, "Standup (09:30)");
  await db.query("update amux.sessions set title_locked = true where id = $1", [id]);
  const refused = await applyTitle(db, id, "Launch Plan");
  assert.equal(refused?.applied, false);
  assert.equal((await stored(db, id)).title, "Standup (09:30)");
  assert.equal((await stored(db, id)).title_locked, true);
});
