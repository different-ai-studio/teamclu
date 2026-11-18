"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { zipStore } = require("./zip");
const { decodeText, parseCsv, xlsxSheets, markdownRow, profileTableLines } = require("./table-source");

test("parseCsv keeps quoted commas, doubled quotes, and line breaks inside a cell", () => {
  const rows = parseCsv('车牌,备注,金额\r\n粤A12345,"含税, 已核","1,200"\n粤B00001,"司机说""明天到""",88\n"粤C1","两行\n备注",9\n\n');
  assert.deepEqual(rows, [
    ["车牌", "备注", "金额"],
    ["粤A12345", "含税, 已核", "1,200"],
    ["粤B00001", '司机说"明天到"', "88"],
    ["粤C1", "两行\n备注", "9"],
  ]);
});

test("decodeText reads UTF-8 with and without BOM, and falls back to GB18030 for GBK exports", () => {
  assert.deepEqual(decodeText(Buffer.from("车辆,成本\n", "utf8")), { text: "车辆,成本\n", encoding: "utf-8" });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("车辆", "utf8")]);
  assert.deepEqual(decodeText(bom), { text: "车辆", encoding: "utf-8" });
  // "车辆,成本" saved by Excel on Chinese Windows (GBK).
  const gbk = Buffer.from([0xb3, 0xb5, 0xc1, 0xbe, 0x2c, 0xb3, 0xc9, 0xb1, 0xbe]);
  assert.deepEqual(decodeText(gbk), { text: "车辆,成本", encoding: "gb18030" });
});

test("markdownRow escapes pipes and flattens line breaks so a cell cannot break the table", () => {
  assert.equal(markdownRow(["a|b", "两行\n备注"], 3), "| a\\|b | 两行 备注 |  |");
});

test("xlsxSheets keeps empty cells in their column and reads shared, rich, and inline strings", () => {
  const bytes = zipStore([
    {
      name: "xl/workbook.xml",
      data: Buffer.from('<workbook><sheets><sheet name="成本" sheetId="1"/></sheets></workbook>'),
    },
    {
      name: "xl/sharedStrings.xml",
      data: Buffer.from("<sst><si><t>车牌</t></si><si><r><t>金</t></r><r><t>额</t></r></si><si><t>备注</t></si></sst>"),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>粤A1</t></is></c><c r="B2" s="1"/><c r="C2" t="inlineStr"><is><t>缺金额</t></is></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>粤A2</t></is></c><c r="B3"><v>120.5</v></c></row></sheetData></worksheet>',
      ),
    },
  ]);
  assert.deepEqual(xlsxSheets(bytes), [
    {
      name: "成本",
      rows: [
        ["车牌", "金额", "备注"],
        ["粤A1", "", "缺金额"],
        ["粤A2", "120.5"],
      ],
    },
  ]);
});

test("profileTableLines types each column and shows a few sample rows", () => {
  const profile = profileTableLines({
    header: ["日期", "车牌", "成本", "司机电话"],
    rows: [
      ["2026-10-01", "粤A1", "1,200", "13800000001"],
      ["2026-10-03", "粤A1", "80.5", "13800000002"],
      ["2026-10-02", "粤B2", "-3", "13800000003"],
    ],
    locatorPrefix: "",
    sampleRows: 2,
  });
  const columns = profile.columnLines.join("\n");
  assert.match(columns, /<!-- source-locator: columns -->/);
  assert.match(columns, /\| 日期 \| 日期 \| 3 \| 3 \| 2026-10-01 ~ 2026-10-03 \|/);
  assert.match(columns, /\| 车牌 \| 文本 \| 3 \| 2 \| 粤A1（2）、粤B2（1） \|/);
  assert.match(columns, /\| 成本 \| 数值 \| 3 \| 3 \| -3 ~ 1200 \|/);
  assert.match(columns, /\| 司机电话 \| 编号 \| 3 \| 3 \| 11 位数字 \|/);
  const sample = profile.sampleLines.join("\n");
  assert.match(sample, /\| 日期 \| 车牌 \| 成本 \| 司机电话 \|/);
  assert.match(sample, /前 2 行/);
  assert.match(sample, /粤A1 \| 80\.5/);
  assert.doesNotMatch(sample, /粤B2/);
});
