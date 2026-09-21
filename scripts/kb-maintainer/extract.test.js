"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSource } = require("./extract");
const { zipStore } = require("./zip");

const SHA = "ef".repeat(32);

test("extractSource dispatches docx and marks audio unsupported", async () => {
  const docx = zipStore([
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>制度</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ]);
  const office = await extractSource({
    sourcePath: "documents/handbook/a.docx",
    bytes: docx,
    sourceSha256: SHA,
  });
  assert.equal(office.extractorName, "office-docx-v1");

  const av = await extractSource({
    sourcePath: "documents/training/talk.mp4",
    bytes: Buffer.from("not-a-video"),
    sourceSha256: SHA,
  });
  assert.equal(av.quality, "unsupported");
});
