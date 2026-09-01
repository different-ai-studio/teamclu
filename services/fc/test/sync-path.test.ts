// services/fc/test/sync-path.test.mjs
// Pure unit tests for the sync path validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSyncPath, ALLOWED_PREFIXES } from '../src/lib/sync-path.js';

// ---------------------------------------------------------------------------
// Allowed paths (should all return { ok: true })
// ---------------------------------------------------------------------------
test('valid knowledge path', () => {
  assert.deepEqual(validateSyncPath('knowledge/data.json'), { ok: true });
});
test('valid knowledge nested path', () => {
  assert.deepEqual(validateSyncPath('knowledge/sub/dir/file.md'), { ok: true });
});
test('rejects the prefixes that moved off file sync', () => {
  // skills/ went to the skills registry, .mcp/ and _secrets/ to the team
  // MCP / env endpoints; _meta/ and _feedback/ never had a writer here.
  for (const p of [
    'skills/foo.md',
    '.mcp/server.json',
    '_secrets/key.pem',
    '_meta/team.json',
    '_feedback/2026-01-01.md',
  ]) {
    assert.equal(validateSyncPath(p).ok, false, `${p} must no longer be accepted`);
  }
});

// ---------------------------------------------------------------------------
// Non-string / empty
// ---------------------------------------------------------------------------
test('rejects null', () => {
  const r = validateSyncPath(null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'InvalidPath');
});
test('rejects undefined', () => {
  const r = validateSyncPath(undefined);
  assert.equal(r.ok, false);
});
test('rejects number', () => {
  assert.equal(validateSyncPath(42).ok, false);
});
test('rejects empty string', () => {
  assert.equal(validateSyncPath('').ok, false);
});

// ---------------------------------------------------------------------------
// Directory traversal (.. segments)
// ---------------------------------------------------------------------------
test('rejects .. segment', () => {
  const r = validateSyncPath('knowledge/../etc/passwd');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'InvalidPath');
  assert.match(r.message, /\.\./);
});
test('rejects leading ../knowledge/', () => {
  assert.equal(validateSyncPath('../skills/foo.md').ok, false);
});

// ---------------------------------------------------------------------------
// Absolute paths
// ---------------------------------------------------------------------------
test('rejects absolute /etc/passwd', () => {
  const r = validateSyncPath('/etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.message, /absolute/i);
});
test('rejects Windows drive letter', () => {
  const r = validateSyncPath('C:\\Windows\\system32');
  assert.equal(r.ok, false);
});
test('rejects drive letter lowercase', () => {
  assert.equal(validateSyncPath('c:/foo').ok, false);
});

// ---------------------------------------------------------------------------
// Backslash
// ---------------------------------------------------------------------------
test('rejects backslash', () => {
  const r = validateSyncPath('skills\\foo.md');
  assert.equal(r.ok, false);
  assert.match(r.message, /backslash/i);
});

// ---------------------------------------------------------------------------
// NUL byte
// ---------------------------------------------------------------------------
test('rejects NUL byte', () => {
  const r = validateSyncPath('knowledge/foo\0bar');
  assert.equal(r.ok, false);
  assert.match(r.message, /NUL/i);
});

// ---------------------------------------------------------------------------
// Control characters
// ---------------------------------------------------------------------------
test('rejects tab control char (0x09)', () => {
  const r = validateSyncPath('knowledge/foo\tbar');
  assert.equal(r.ok, false);
  assert.match(r.message, /control/i);
});
test('rejects newline control char', () => {
  assert.equal(validateSyncPath('knowledge/foo\nbar').ok, false);
});

// ---------------------------------------------------------------------------
// Empty segment (double slash or trailing slash)
// ---------------------------------------------------------------------------
test('rejects double slash', () => {
  const r = validateSyncPath('knowledge//foo.md');
  assert.equal(r.ok, false);
  assert.match(r.message, /empty segment/i);
});

// ---------------------------------------------------------------------------
// Dot segment
// ---------------------------------------------------------------------------
test('rejects "." segment', () => {
  const r = validateSyncPath('knowledge/./foo.md');
  assert.equal(r.ok, false);
  assert.match(r.message, /\./);
});

// ---------------------------------------------------------------------------
// Long segment (> 255 bytes)
// ---------------------------------------------------------------------------
test('rejects segment > 255 bytes', () => {
  const longSeg = 'a'.repeat(256);
  const r = validateSyncPath(`knowledge/${longSeg}`);
  assert.equal(r.ok, false);
  assert.match(r.message, /255/);
});
test('accepts segment of exactly 255 bytes', () => {
  const seg = 'a'.repeat(255);
  assert.equal(validateSyncPath(`knowledge/${seg}`).ok, true);
});

// ---------------------------------------------------------------------------
// Total length > 1024
// ---------------------------------------------------------------------------
test('rejects path > 1024 bytes total', () => {
  const longPath = 'knowledge/' + 'a'.repeat(1015);
  assert.equal(longPath.length, 1025);
  const r = validateSyncPath(longPath);
  assert.equal(r.ok, false);
  assert.match(r.message, /1024/);
});
test('accepts path of exactly 1024 bytes (with valid segments)', () => {
  // Build a path with multiple segments, each ≤255, that totals exactly 1024 chars.
  // knowledge/ = 10 chars; we add 3 segments of 255 + '/' separators + final segment.
  // 10 + 255 + 1 + 255 + 1 + 255 + 1 + 246 = 1024
  const seg = 'a'.repeat(255);
  const last = 'b'.repeat(246);
  const p = `knowledge/${seg}/${seg}/${seg}/${last}`;
  assert.equal(p.length, 1024);
  assert.equal(validateSyncPath(p).ok, true);
});

// ---------------------------------------------------------------------------
// Unallowed prefix
// ---------------------------------------------------------------------------
test('rejects unallowed prefix "uploads/"', () => {
  const r = validateSyncPath('uploads/foo.md');
  assert.equal(r.ok, false);
  assert.match(r.message, /must start with/i);
});
test('rejects unallowed prefix "tmp/foo"', () => {
  assert.equal(validateSyncPath('tmp/foo').ok, false);
});
test('rejects bare filename with no prefix', () => {
  assert.equal(validateSyncPath('foo.md').ok, false);
});

// ---------------------------------------------------------------------------
// ALLOWED_PREFIXES export
// ---------------------------------------------------------------------------
test('ALLOWED_PREFIXES is the two fixed roots and nothing else', () => {
  // An exact match on purpose: this list is mirrored in three Rust constants
  // (daemon + desktop path_validator, global_team_store), and a prefix quietly
  // added back on one side is the failure mode this pins down.
  // `documents/` joined in "feat(sync): two fixed roots" (f59bcd8d); this
  // assertion had been left on the old single-root value.
  assert.deepEqual([...ALLOWED_PREFIXES], ['documents/', 'knowledge/']);
});
