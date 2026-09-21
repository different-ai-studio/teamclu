"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCompilePrompt } = require("./compile-prompt");

const CTX = {
  action: "add",
  sourcePath: "documents/handbook/leave.md",
  sourceSha256: "ab".repeat(32),
  rawMarkdown: "# 请假\n\n员工请假需提前申请。",
  locators: ["heading=请假"],
  pageType: "policy",
  schemaMarkdown: "# Wiki compile rules\nOnly from sources.",
  indexMarkdown: "# LLM Wiki\n",
  affectedPages: [],
};

test("buildCompilePrompt treats the model as a compiler and wraps the source as data", () => {
  const prompt = buildCompilePrompt(CTX);
  assert.match(prompt, /compiler, not a creative writer/i);
  assert.match(prompt, /<source>/);
  assert.match(prompt, /员工请假需提前申请/);
  assert.match(prompt, /<\/source>/);
  assert.match(prompt, /documents\/handbook\/leave.md/);
  assert.match(prompt, /heading=请假/);
  assert.match(prompt, /wiki\/pages/);
  assert.match(prompt, /Wiki Link/);
});

test("buildCompilePrompt for delete names the affected pages to recompile", () => {
  const prompt = buildCompilePrompt({
    ...CTX,
    action: "delete",
    affectedPages: ["pages/leave.md"],
  });
  assert.match(prompt, /delete|retract|recompile/i);
  assert.match(prompt, /pages\/leave.md/);
});
