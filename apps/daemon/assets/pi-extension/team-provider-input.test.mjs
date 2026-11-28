import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The three team tiers share one registerProvider entry. pi drops images
// unless "image" is listed, so a text-only input here makes every tier blind.
test("team provider models accept images", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./teamclu.ts", import.meta.url)), "utf8");
  const start = src.indexOf("function registerTeamProvider");
  const end = src.indexOf("function ", start + 1);
  const body = src.slice(start, end);
  assert.match(body, /input:\s*\["text",\s*"image"\]/);
  assert.doesNotMatch(body, /input:\s*\["text"\]/);
});
