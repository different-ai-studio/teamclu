const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const read = p => readFileSync(resolve(root, p), 'utf8');
test('app-auth is bundled and classified read-only by both inventories', () => {
  for (const p of ['apps/daemon/src/runtime/supervisor.rs', 'apps/daemon/src/config/roles_skills.rs', 'packages/app/src/lib/skills/types.ts']) {
    assert.match(read(p), /["']app-auth["']/);
  }
});
test('auth skill separates identity from role admission and records login test limits', () => {
  const s = read('packages/app/src/lib/skills/app-auth/SKILL.md');
  for (const term of ['manage_app auth_info', 'created_by_actor_id', 'X-Teamclu-User-Id', '/api/staff', '/_serverFn', 'roles: []', '真实账号', '待验收']) assert.ok(s.includes(term), term);
  assert.match(s, /createFileRoute/);
  assert.match(s, /401/);
  assert.match(s, /mock/);
});
test('templates route auth work to app-auth without claiming identity grants all access', () => {
  for (const name of ['static-web', 'slides', 'tanstack-postgres']) assert.match(read(`templates/${name}/AGENTS.md`), /app-auth/);
  const identity = read('templates/tanstack-postgres/src/lib/platform-auth.ts');
  assert.doesNotMatch(identity, /EVERY condition for entering|wherever they appear/);
  assert.match(identity, /created_by_actor_id/);
  assert.match(read('apps/daemon/src/runtime/session_prompt.rs'), /app-auth/);
  const deploy = read('packages/app/src/lib/skills/deploy-app/SKILL.md');
  assert.match(deploy, /app-auth/);
  assert.doesNotMatch(deploy, /## App access checks/);
});

test('documented endpoint refuses missing identity before reading staff data', async () => {
  const { runInNewContext } = require('node:vm');
  const skill = read('packages/app/src/lib/skills/app-auth/SKILL.md');
  const sample = skill.match(/```ts\n([\s\S]+?)\n```/)[1]
    .replace(/^import .*\n/gm, '').replace('export const Route', 'const Route');
  const helper = read('templates/tanstack-postgres/src/lib/platform-auth.ts');
  const body = helper.match(/export function visitorFrom\(headers: Headers\): Visitor \| null \{([\s\S]*?)\n\}/)[1];
  let reads = 0;
  const handler = runInNewContext(`${sample}\nRoute.server.handlers.GET`, {
    createFileRoute: () => options => options,
    visitorFrom: new Function('headers', body),
    sql: async () => { reads++; return [{ id: 'record-1', phone: 'test', status: 'pending' }]; },
    Response,
  });
  const denied = await handler({ request: new Request('https://app.example/api/staff/applications') });
  assert.equal(denied.status, 401);
  assert.equal(reads, 0);
  // Simulates an already admitted gateway request, not a spoofing/RBAC test.
  const allowed = await handler({ request: new Request('https://app.example/api/staff/applications', {
    headers: { 'x-teamclu-user-id': 'platform-user', 'x-teamclu-user-email': 'test@example.com' },
  }) });
  assert.equal(allowed.status, 200);
  assert.equal(reads, 1);
  assert.equal((await allowed.json()).records[0].id, 'record-1');
});
