import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAppStorageOps } from "../src/lib/provisioning/app-storage.js";
import { normalizeAppFolderPrefix } from "../src/lib/provisioning/apps-oss.js";

/**
 * The object store, faked at the command boundary.
 *
 * `s3.send` is handed whatever command object the ops built, so the assertions
 * here are about what was ASKED for — which is the whole point of the delimiter:
 * a browser that forgot to send it gets every key in the app instead of one
 * level, and the symptom is a flat list of 4000 rows rather than an error.
 */
function makeS3(response: Record<string, unknown>) {
  const sent: any[] = [];
  const s3: any = {
    async send(cmd: any) {
      sent.push(cmd.input);
      return response;
    },
  };
  return { s3, sent };
}

const commands = {
  GetObjectCommand: class { constructor(public input: any) {} },
  PutObjectCommand: class { constructor(public input: any) {} },
  HeadObjectCommand: class { constructor(public input: any) {} },
  DeleteObjectCommand: class { constructor(public input: any) {} },
  DeleteObjectsCommand: class { constructor(public input: any) {} },
  ListObjectsV2Command: class { constructor(public input: any) {} },
} as any;

const profile: any = { region: "cn-shenzhen", endpoint: "https://oss.example.com", bucket: "apps" };

function opsWith(response: Record<string, unknown>) {
  const { s3, sent } = makeS3(response);
  const ops = makeAppStorageOps(profile, s3, {
    getSignedUrl: async () => "https://signed.example.com",
    commands,
    env: {} as any,
  });
  return { ops, sent };
}

// --- folder prefixes ---------------------------------------------------------

test("a folder prefix always ends in a separator, so a sibling cannot match it", () => {
  // Without the trailing "/", listing `logs` would also return `logs-archive/`
  // — a browser showing another folder's files under this folder's name.
  assert.equal(normalizeAppFolderPrefix("logs"), "logs/");
  assert.equal(normalizeAppFolderPrefix("logs/"), "logs/");
  assert.equal(normalizeAppFolderPrefix("a/b/c"), "a/b/c/");
});

test("the root is the empty prefix, however it is spelled", () => {
  for (const raw of ["", "/", "//", ".", "./", undefined, null, 42]) {
    assert.equal(normalizeAppFolderPrefix(raw), "", `for ${JSON.stringify(raw)}`);
  }
});

test("traversal segments are dropped rather than resolved", () => {
  // An object store has no parent directory, so ".." is not a traversal — it is
  // a literal key segment nobody meant to address.
  assert.equal(normalizeAppFolderPrefix("../../etc"), "etc/");
  assert.equal(normalizeAppFolderPrefix("a/../b"), "a/b/");
  assert.equal(normalizeAppFolderPrefix("/a//b/"), "a/b/");
});

// --- listing one level -------------------------------------------------------

test("browsing sends a delimiter and reports folders relative to the prefix", async () => {
  const { ops, sent } = opsWith({
    Contents: [
      { Key: "app-files/app-1/resume.pdf", Size: 9, LastModified: new Date("2026-04-11T00:00:00Z"), ETag: '"abc"' },
    ],
    CommonPrefixes: [
      { Prefix: "app-files/app-1/resumes/" },
      { Prefix: "app-files/app-1/generated/" },
    ],
    IsTruncated: false,
  });

  const out = await ops.list("apps", "app-files/app-1/", { delimiter: "/" });

  assert.equal(sent[0].Delimiter, "/");
  // Relative to what was asked for — the caller thinks in app-relative paths and
  // has no business seeing the bucket layout.
  assert.deepEqual(out.folders, ["resumes/", "generated/"]);
  assert.deepEqual(out.items.map((i) => i.path), ["resume.pdf"]);
  assert.equal(out.items[0].size, 9);
  assert.equal(out.items[0].lastModified, "2026-04-11T00:00:00.000Z");
});

test("without a delimiter the listing stays fully recursive and has no folders", async () => {
  // This is the mode the control panel's count and the usage sweep depend on;
  // making the delimiter a default would silently turn "12 files" into "files in
  // the root folder".
  const { ops, sent } = opsWith({
    Contents: [
      { Key: "app-files/app-1/a/b/deep.txt", Size: 1, LastModified: null, ETag: null },
    ],
    IsTruncated: false,
  });

  const out = await ops.list("apps", "app-files/app-1/", {});

  assert.equal(sent[0].Delimiter, undefined);
  assert.deepEqual(out.folders, []);
  assert.deepEqual(out.items.map((i) => i.path), ["a/b/deep.txt"]);
});

test("a directory marker is not offered as a file", async () => {
  // A key equal to the prefix itself would render as a nameless row.
  const { ops } = opsWith({
    Contents: [
      { Key: "app-files/app-1/", Size: 0, LastModified: null, ETag: null },
      { Key: "app-files/app-1/real.txt", Size: 3, LastModified: null, ETag: null },
    ],
    IsTruncated: false,
  });
  const out = await ops.list("apps", "app-files/app-1/", { delimiter: "/" });
  assert.deepEqual(out.items.map((i) => i.path), ["real.txt"]);
});

test("truncation is reported as a cursor, and only when truncated", async () => {
  const more = opsWith({ Contents: [], IsTruncated: true, NextContinuationToken: "tok" });
  assert.equal((await more.ops.list("apps", "p/", {})).nextCursor, "tok");

  const done = opsWith({ Contents: [], IsTruncated: false, NextContinuationToken: "ignored" });
  assert.equal((await done.ops.list("apps", "p/", {})).nextCursor, null);
});
