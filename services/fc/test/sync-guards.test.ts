import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRejectedSyncPath,
  isOverFileQuota,
  isOverByteQuota,
  liveFileCount,
  liveByteSum,
  maxFilesPerTeam,
  maxBytesPerTeam,
  resetQuotaCache,
} from '../src/lib/sync-guards.js';

test('sync-guards: refuses the directories that cannot be documents', () => {
  assert.equal(isRejectedSyncPath('knowledge/node_modules/left-pad/index.js'), true);
  assert.equal(isRejectedSyncPath('knowledge/app/node_modules/x.js'), true);
  assert.equal(isRejectedSyncPath('knowledge/.git/objects/ab/cdef'), true);
  assert.equal(isRejectedSyncPath('knowledge/proj/__pycache__/mod.pyc'), true);
});

test('sync-guards: refuses OS litter by exact name', () => {
  assert.equal(isRejectedSyncPath('knowledge/.DS_Store'), true);
  assert.equal(isRejectedSyncPath('knowledge/notes/.DS_Store'), true);
  assert.equal(isRejectedSyncPath('knowledge/Thumbs.db'), true);
});

test('sync-guards: leaves documents alone', () => {
  assert.equal(isRejectedSyncPath('knowledge/onboarding.md'), false);
  assert.equal(isRejectedSyncPath('knowledge/项目/会议纪要.md'), false);
  assert.equal(isRejectedSyncPath('knowledge/attachments/diagram.png'), false);
});

// The reason this list is far shorter than the client's. A false positive here
// is permanent and unexplainable: the document never uploads and all the user
// sees is a 422. These four are on the client's list, where a person can edit
// `.amuxignore` and get the file back; nobody can edit the server's.
test('sync-guards: does NOT refuse names a team might legitimately use', () => {
  assert.equal(isRejectedSyncPath('knowledge/target/2026-okr.md'), false);
  assert.equal(isRejectedSyncPath('knowledge/build/发布流程.md'), false);
  assert.equal(isRejectedSyncPath('knowledge/dist/notes.md'), false);
  assert.equal(isRejectedSyncPath('knowledge/coverage/保险范围.md'), false);
});

// Matching a bare string prefix would get this wrong.
test('sync-guards: does not refuse a sibling with a shared name prefix', () => {
  assert.equal(isRejectedSyncPath('knowledge/node_modules_notes/a.md'), false);
  assert.equal(isRejectedSyncPath('knowledge/.gitignore'), false);
});

test('sync-guards: quota triggers at the ceiling, not past it', () => {
  const max = maxFilesPerTeam();
  assert.equal(isOverFileQuota(max - 1), false);
  assert.equal(isOverFileQuota(max), true);
  assert.equal(isOverFileQuota(max + 1), true);
});

// A COUNT that hiccupped must not break sync: the guard is for a pathological
// case, and the user can do nothing about a database blip.
test('sync-guards: an unknown count is not over quota', () => {
  assert.equal(isOverFileQuota(null), false);
});

test('sync-guards: the count is cached so a 200-item batch pays for it once', async () => {
  resetQuotaCache();
  let calls = 0;
  const counter = async () => {
    calls += 1;
    return 7;
  };
  for (let i = 0; i < 200; i++) {
    assert.equal(await liveFileCount('team-a', counter), 7);
  }
  assert.equal(calls, 1);
});

test('sync-guards: a failing count returns null and is not cached', async () => {
  resetQuotaCache();
  let calls = 0;
  const counter = async () => {
    calls += 1;
    throw new Error('db down');
  };
  assert.equal(await liveFileCount('team-b', counter), null);
  assert.equal(await liveFileCount('team-b', counter), null);
  assert.equal(calls, 2, 'a failure must not be remembered as an answer');
});

// Byte quota — resource ceiling on live file sizes (not disk protection: historical
// version blobs stay until GC). Default 2 GiB; projected total is sum + size.
test('sync-guards: byte quota default is 2 GiB', () => {
  const prev = process.env.SYNC_MAX_BYTES_PER_TEAM;
  delete process.env.SYNC_MAX_BYTES_PER_TEAM;
  try {
    assert.equal(maxBytesPerTeam(), 2 * 1024 ** 3);
  } finally {
    if (prev === undefined) delete process.env.SYNC_MAX_BYTES_PER_TEAM;
    else process.env.SYNC_MAX_BYTES_PER_TEAM = prev;
  }
});

test('sync-guards: projected byte total crosses only past the ceiling', () => {
  const max = maxBytesPerTeam();
  assert.equal(isOverByteQuota(max - 1), false);
  assert.equal(isOverByteQuota(max), false);
  assert.equal(isOverByteQuota(max + 1), true);
});

test('sync-guards: an unknown byte sum is not over quota', () => {
  assert.equal(isOverByteQuota(null), false);
});

// Unlike file count, byte sums must not TTL-cache across prepare-batch calls:
// complete updates live sizes, and the next chunk must see the fresh total.
test('sync-guards: each liveByteSum call re-fetches (no cross-batch TTL cache)', async () => {
  resetQuotaCache();
  const sums = [10, 90];
  let calls = 0;
  const summer = async () => sums[calls++];
  assert.equal(await liveByteSum('team-bytes', summer), 10);
  assert.equal(await liveByteSum('team-bytes', summer), 90);
  assert.equal(calls, 2);
});

test('sync-guards: a failing byte sum returns null (null→allow on failure only)', async () => {
  resetQuotaCache();
  let calls = 0;
  const summer = async () => {
    calls += 1;
    throw new Error('db down');
  };
  assert.equal(await liveByteSum('team-bytes-fail', summer), null);
  assert.equal(await liveByteSum('team-bytes-fail', summer), null);
  assert.equal(calls, 2, 'a failure must not be remembered as an answer');
});
