import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applySessionTitlePatch } from "../src/lib/session-title-lock.js";

test("a rename that lands before the generated title wins", () => {
  const row = { title: "Agent (09:30)", titleLocked: false };
  const locked = applySessionTitlePatch(row, { title: "Standup (09:30)", titleLocked: true });
  const after = applySessionTitlePatch(locked, { title: "深圳美食推荐" });
  assert.equal(after.title, "Standup (09:30)");
  assert.equal(after.titleLocked, true);
  assert.equal(after.titleApplied, false);
});

test("an unlocked first-message title can still be replaced", () => {
  const row = { title: "帮我查一下深圳美食", titleLocked: false };
  const next = applySessionTitlePatch(row, { title: "深圳美食推荐" });
  assert.equal(next.title, "深圳美食推荐");
  assert.equal(next.titleLocked, false);
  assert.equal(next.titleApplied, true);
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

test("apply_generated_session_title is one conditional update", async () => {
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
    end $$;
  `);
  const migration = readFileSync(
    new URL("../../supabase/migrations/20261122120000_session_title_locked.sql", import.meta.url),
    "utf8",
  );
  await db.exec(migration);

  const id = "61122100-0000-4000-8000-000000000021";
  await db.query(
    "insert into amux.sessions (id, title) values ($1, $2)",
    [id, "Agent (09:30)"],
  );

  const unlocked = await db.query(
    "select applied, title, title_locked from amux.apply_generated_session_title($1, $2)",
    [id, "深圳美食推荐"],
  );
  assert.equal(unlocked.rows[0].applied, true);
  assert.equal(unlocked.rows[0].title, "深圳美食推荐");
  assert.equal(unlocked.rows[0].title_locked, false);

  await db.query(
    "update amux.sessions set title = $2, title_locked = true where id = $1",
    [id, "Standup (09:30)"],
  );
  const locked = await db.query(
    "select applied, title, title_locked from amux.apply_generated_session_title($1, $2)",
    [id, "另一条生成标题"],
  );
  assert.equal(locked.rows[0].applied, false);
  assert.equal(locked.rows[0].title, "Standup (09:30)");
  assert.equal(locked.rows[0].title_locked, true);

  const stored = await db.query("select title, title_locked from amux.sessions where id = $1", [id]);
  assert.equal(stored.rows[0].title, "Standup (09:30)");
  assert.equal(stored.rows[0].title_locked, true);

  const missing = await db.query(
    "select applied from amux.apply_generated_session_title($1, $2)",
    ["61122100-0000-4000-8000-000000000099", "gone"],
  );
  assert.equal(missing.rows.length, 0);
});
