"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSimplePdf } = require("./extract-pdf");
const { extractPdf } = require("./extract-pdf");
const { extractSource } = require("./extract");
const { estimateVision } = require("./estimate");
const {
  classifyVisionError,
  transcribeWithSession,
  createVisionExtract,
  findPdftoppm,
} = require("./vision");

const SHA = "ab".repeat(32);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x18, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
  Buffer.alloc(8),
]);

function write(file, textOrBuf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, textOrBuf);
}

function makeEstimateHarness(allowExtensions, limits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-est-"));
  const documentsRoot = path.join(root, "documents");
  const knowledgeRoot = path.join(root, "knowledge");
  write(path.join(knowledgeRoot, "_schema.md"), "# Wiki compile rules\n\nKeep facts sourced.\n");
  write(
    path.join(root, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      teamId: "11111111-1111-4111-8111-111111111111",
      maintainerNodeId: "node-a",
      sources: [
        {
          prefix: "documents/handbook/",
          class: "policy",
          priority: 10,
          allowExtensions,
        },
      ],
      deny: { pathPatterns: [] },
      limits: limits || {},
      models: { visionPagePrice: 0.12, currency: "CNY" },
    }),
  );
  return {
    root,
    documentsRoot,
    knowledgeRoot,
    configPath: path.join(root, "config.json"),
    statePath: path.join(root, "state.json"),
  };
}

test("findPdftoppm prefers a Homebrew binary when PATH cannot see it", () => {
  assert.equal(
    findPdftoppm((file) => file === "/opt/homebrew/bin/pdftoppm"),
    "/opt/homebrew/bin/pdftoppm",
  );
  assert.equal(
    findPdftoppm(() => false),
    "pdftoppm",
  );
});

test("classifyVisionError keeps rate limits and marks image rejection", () => {
  assert.equal(
    classifyVisionError(new Error("Compiler model failed: 429 Too Many Requests")).message,
    "Compiler model failed: 429 Too Many Requests",
  );
  assert.equal(
    classifyVisionError(new Error("model does not support image input")).message,
    "vision_unsupported",
  );
  assert.equal(
    classifyVisionError(new Error("content_policy_violation")).message,
    "vision_refused",
  );
  assert.equal(classifyVisionError(new Error("vision_empty")).message, "vision_empty");
  assert.equal(classifyVisionError(new Error("socket hang up")).message, "socket hang up");
});

test("transcribeWithSession sends the image and returns the model text", async () => {
  let options;
  const text = await transcribeWithSession(
    {
      prompt: async (_prompt, received) => {
        options = received;
      },
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "明天放假" }],
        },
      ],
    },
    { bytes: PNG, mediaType: "image/png" },
  );
  assert.equal(text, "明天放假");
  assert.equal(options.images[0].type, "image");
  assert.equal(options.images[0].mimeType, "image/png");
  assert.equal(options.images[0].data, PNG.toString("base64"));
});

test("transcribeWithSession reports a model failure instead of an empty transcription", async () => {
  await assert.rejects(
    () =>
      transcribeWithSession(
        {
          prompt: async () => {},
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" },
          ],
        },
        { bytes: PNG, mediaType: "image/png" },
      ),
    /Compiler model failed: 429 Too Many Requests/,
  );
});

test("createVisionExtract renders a PDF page before transcription and skips rendering for images", async () => {
  const calls = [];
  const extract = createVisionExtract({
    transcribe: async (payload) => {
      calls.push(payload);
      return "通知正文";
    },
    renderPdfPage: async (_bytes, pageNumber) => {
      calls.push({ rendered: pageNumber });
      return { bytes: PNG, mediaType: "image/png" };
    },
  });
  assert.equal(
    await extract({ bytes: PNG, mediaType: "image/png", pageNumber: 1 }),
    "通知正文",
  );
  assert.equal(
    await extract({ bytes: Buffer.from("%PDF"), mediaType: "application/pdf", pageNumber: 2 }),
    "通知正文",
  );
  assert.equal(calls[0].mediaType, "image/png");
  assert.equal(calls[1].rendered, 2);
  assert.equal(calls[2].bytes.equals(PNG), true);
});

test("extractSource declines an image when vision was not accepted", async () => {
  const result = await extractSource({
    sourcePath: "documents/handbook/notice.png",
    bytes: PNG,
    sourceSha256: SHA,
  });
  assert.equal(result.quality, "vision_declined");
});

test("extractSource transcribes a readable image and caches the result", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-vision-cache-"));
  let calls = 0;
  const opts = {
    sourcePath: "documents/handbook/notice.png",
    bytes: PNG,
    sourceSha256: SHA,
    visionModel: "team/glm-4.6",
    promptVersion: "v1",
    cacheDir,
    visionExtract: async () => {
      calls += 1;
      return "明天放假";
    },
  };
  const first = await extractSource(opts);
  const second = await extractSource({ ...opts, visionExtract: async () => {
    calls += 1;
    return "should not run";
  } });
  assert.equal(first.quality, "accepted");
  assert.match(first.markdown, /明天放假/);
  assert.equal(second.markdown, first.markdown);
  assert.equal(calls, 1);
});

test("extractSource does not call vision for a corrupt image", async () => {
  let calls = 0;
  const result = await extractSource({
    sourcePath: "documents/handbook/notice.png",
    bytes: Buffer.from("not a png"),
    sourceSha256: SHA,
    visionExtract: async () => {
      calls += 1;
      return "nope";
    },
  });
  assert.equal(result.quality, "vision_unreadable");
  assert.equal(calls, 0);
});

test("extractSource marks an empty transcription and an image-incapable model", async () => {
  const empty = await extractSource({
    sourcePath: "documents/handbook/notice.jpg",
    bytes: JPEG,
    sourceSha256: SHA,
    visionExtract: async () => "  ",
  });
  assert.equal(empty.quality, "vision_empty");
  await assert.rejects(
    () =>
      extractSource({
        sourcePath: "documents/handbook/notice.webp",
        bytes: WEBP,
        sourceSha256: SHA,
        visionExtract: async () => {
          throw new Error("model does not support image input");
        },
      }),
    /vision_unsupported/,
  );
});

test("extractPdf asks before vision and fails the whole file when one page fails", async () => {
  const bytes = buildSimplePdf([
    { text: "", imageOnly: true },
    { text: "", imageOnly: true },
  ]);
  const declined = await extractPdf({
    sourcePath: "documents/handbook/scan.pdf",
    bytes,
    sourceSha256: SHA,
  });
  assert.equal(declined.quality, "vision_declined");

  let calls = 0;
  await assert.rejects(
    () =>
      extractPdf({
        sourcePath: "documents/handbook/scan.pdf",
        bytes,
        sourceSha256: SHA,
        visionExtract: async () => {
          calls += 1;
          if (calls === 2) throw new Error("content filter");
          return "第一页";
        },
      }),
    /vision_refused/,
  );
  assert.equal(calls, 2);
});

test("extractPdf does not call vision when a scan exceeds the page cap", async () => {
  const bytes = buildSimplePdf([
    { text: "", imageOnly: true },
    { text: "", imageOnly: true },
  ]);
  let calls = 0;
  await assert.rejects(
    () =>
      extractPdf({
        sourcePath: "documents/handbook/scan.pdf",
        bytes,
        sourceSha256: SHA,
        maxVisionPages: 1,
        visionExtract: async () => {
          calls += 1;
          return "页";
        },
      }),
    /vision_too_many_pages/,
  );
  assert.equal(calls, 0);
});

test("estimateVision charges images and unreadable-text PDF pages, not text pages", async () => {
  const fx = makeEstimateHarness(["pdf", "png", "jpg", "webp"]);
  write(path.join(fx.documentsRoot, "handbook", "notice.png"), PNG);
  write(path.join(fx.documentsRoot, "handbook", "photo.jpg"), JPEG);
  write(
    path.join(fx.documentsRoot, "handbook", "scan.pdf"),
    buildSimplePdf([{ text: "", imageOnly: true }]),
  );
  write(
    path.join(fx.documentsRoot, "handbook", "text.pdf"),
    buildSimplePdf([{ text: "员工手册正文足够长，用来通过质量门禁。" }]),
  );
  const report = await estimateVision({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [],
    aclPrefixes: [],
  });
  assert.equal(report.visionPages, 3);
  assert.equal(report.estimatedCost, 0.36);
  assert.deepEqual(
    report.sources.map((item) => item.path).sort(),
    [
      "documents/handbook/notice.png",
      "documents/handbook/photo.jpg",
      "documents/handbook/scan.pdf",
    ],
  );
});

test("estimateVision does not charge corrupt files, sensitive names, or scans over the page cap", async () => {
  const fx = makeEstimateHarness(["pdf", "png"], { maxVisionPages: 1 });
  write(path.join(fx.documentsRoot, "handbook", "broken.png"), Buffer.from("nope"));
  write(path.join(fx.documentsRoot, "handbook", "03-入职清单.png"), PNG);
  write(
    path.join(fx.documentsRoot, "handbook", "long.pdf"),
    buildSimplePdf([
      { text: "", imageOnly: true },
      { text: "", imageOnly: true },
    ]),
  );
  write(path.join(fx.documentsRoot, "handbook", "empty.pdf"), Buffer.from("not a pdf"));
  const report = await estimateVision({
    configPath: fx.configPath,
    statePath: fx.statePath,
    documentsRoot: fx.documentsRoot,
    knowledgeRoot: fx.knowledgeRoot,
    nodeId: "node-a",
    known: [{ path: "documents/handbook/missing.png", version: "1", size: 10 }],
    aclPrefixes: [],
  });
  assert.equal(report.visionPages, 0);
  assert.equal(report.estimatedCost, 0);
  assert.equal(report.requiresAccept, true);
  assert.deepEqual(
    report.unreadable.map((item) => item.path).sort(),
    ["documents/handbook/broken.png", "documents/handbook/empty.pdf"],
  );
  assert.deepEqual(
    report.overLimit.map((item) => item.path),
    ["documents/handbook/long.pdf"],
  );
  assert.equal(
    report.sources.some((item) => item.path.includes("入职")),
    false,
  );
});
