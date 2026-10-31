import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupabaseStorageKey,
  safeObjectName,
  safeStorageObjectPath,
  storageContentTypeForBucket,
} from "../src/lib/storage-object-key.js";

const LIVE_PDF_KEY =
  "30b7006d-4225-4160-8c12-0a057268a914/e8a6039b-602a-4102-a7c2-a0f0589ef049/78d65bb6-10dc-4646-a966-db0536c8cec0/AI升级能力地图方案.pdf";

test("storage rejects the live Chinese object key and accepts the rewrite", () => {
  assert.equal(isSupabaseStorageKey(LIVE_PDF_KEY), false);
  const safe = safeStorageObjectPath(LIVE_PDF_KEY);
  assert.equal(
    safe,
    "30b7006d-4225-4160-8c12-0a057268a914/e8a6039b-602a-4102-a7c2-a0f0589ef049/78d65bb6-10dc-4646-a966-db0536c8cec0/AI.pdf",
  );
  assert.equal(isSupabaseStorageKey(safe), true);
});

test("safeObjectName matches the daemon filename rules", () => {
  assert.equal(safeObjectName("诗一首.md"), "file.md");
  assert.equal(safeObjectName("报告 final.pdf"), "final.pdf");
  assert.equal(safeObjectName("report-v2.pdf"), "report-v2.pdf");
  assert.equal(safeObjectName("a_b.c-d.txt"), "a_b.c-d.txt");
  assert.equal(safeObjectName("中文"), "file");
  assert.equal(safeObjectName("..."), "file");
  assert.equal(safeObjectName("物流与云仓-TeamClu-AI升级方向方案-V0.1.ppt"), "-TeamClu-AI_-V0.1.ppt");
  assert.equal(safeObjectName("AI升级能力地图方案.pdf"), "AI.pdf");
});

test("safeObjectName is idempotent", () => {
  for (const name of [
    "诗一首.md",
    "报告 final.pdf",
    "AI升级能力地图方案.pdf",
    "物流与云仓-TeamClu-AI升级方向方案-V0.1.ppt",
    "photo.png",
  ]) {
    const once = safeObjectName(name);
    assert.equal(safeObjectName(once), once);
    assert.equal(isSupabaseStorageKey(once), true);
  }
});

test("path segments that would escape the prefix are not parents", () => {
  assert.equal(safeStorageObjectPath("team/session/../../other.pdf"), "team/session/file/file/other.pdf");
  assert.equal(safeStorageObjectPath("/team/session/file.png"), "team/session/file.png");
});

test("office MIME types are stored as octet-stream; pdf and avatars are not", () => {
  assert.equal(
    storageContentTypeForBucket("application/vnd.ms-powerpoint", "attachments"),
    "application/octet-stream",
  );
  assert.equal(
    storageContentTypeForBucket(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "attachments",
    ),
    "application/octet-stream",
  );
  assert.equal(storageContentTypeForBucket("application/pdf", "attachments"), "application/pdf");
  assert.equal(
    storageContentTypeForBucket("application/pdf; charset=binary", "attachments"),
    "application/pdf",
  );
  assert.equal(storageContentTypeForBucket("", "attachments"), "application/octet-stream");
  assert.equal(storageContentTypeForBucket("image/jpeg", "avatars"), "image/jpeg");
  assert.equal(storageContentTypeForBucket("image/gif", "avatars"), "image/gif");
});
