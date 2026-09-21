"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { zipStore } = require("./zip");
const { extractOffice } = require("./extract-office");

const SHA = "ab".repeat(32);

test("extractOffice keeps docx paragraphs with locators", () => {
  const bytes = zipStore([
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>请假制度</w:t></w:r></w:p><w:p><w:r><w:t>员工请假需提前申请。</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ]);
  const result = extractOffice({
    sourcePath: "documents/handbook/leave.docx",
    bytes,
    sourceSha256: SHA,
  });
  assert.equal(result.quality, "accepted");
  assert.equal(result.extractorName, "office-docx-v1");
  assert.match(result.markdown, /source-locator: para=1/);
  assert.match(result.markdown, /请假制度/);
  assert.match(result.markdown, /员工请假需提前申请/);
});

test("extractOffice keeps pptx slide boundaries", () => {
  const bytes = zipStore([
    {
      name: "ppt/slides/slide2.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>第二页</a:t></p:sld>`,
      ),
    },
    {
      name: "ppt/slides/slide1.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>封面</a:t></p:sld>`,
      ),
    },
  ]);
  const result = extractOffice({
    sourcePath: "documents/training/deck.pptx",
    bytes,
    sourceSha256: SHA,
  });
  assert.equal(result.extractorName, "office-pptx-v1");
  assert.deepEqual(result.locators, ["slide=1", "slide=2"]);
  assert.match(result.markdown, /封面[\s\S]*第二页/);
});

test("extractOffice keeps xlsx sheet and row locators", () => {
  const bytes = zipStore([
    {
      name: "xl/sharedStrings.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>岗位</t></si><si><t>职责</t></si></sst>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="职责" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(
        `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>`,
      ),
    },
  ]);
  const result = extractOffice({
    sourcePath: "documents/handbook/roles.xlsx",
    bytes,
    sourceSha256: SHA,
  });
  assert.equal(result.extractorName, "office-xlsx-v1");
  assert.match(result.markdown, /source-locator: sheet=职责&row=1/);
  assert.match(result.markdown, /岗位/);
  assert.match(result.markdown, /职责/);
});
