import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");

function composeGatewayEnvKeys(): Set<string> {
  const file = path.join(REPO, "deploy/self-host/docker-compose.yml");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const serviceStart = lines.findIndex((line) => line === "  ai-gateway:");
  assert.ok(serviceStart >= 0, "docker-compose.yml: ai-gateway service not found");
  const serviceEnd = lines.findIndex((line, index) => index > serviceStart && /^ {2}\S/.test(line));
  const service = lines.slice(serviceStart, serviceEnd === -1 ? undefined : serviceEnd);
  const envStart = service.findIndex((line) => line.trimEnd() === "    environment:");
  assert.ok(envStart >= 0, "docker-compose.yml: ai-gateway environment block not found");

  const keys = new Set<string>();
  for (const line of service.slice(envStart + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < 6) break;
    if (indent !== 6) continue;
    const match = /^([A-Z_0-9]+):/.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  assert.ok(keys.size > 0, "docker-compose.yml: no ai-gateway environment keys");
  return keys;
}

function belayoGatewayEnvKeys(): Set<string> {
  const file = path.join(REPO, "deploy/belayo/ai-gateway.env.keys");
  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const row of rows) {
    assert.match(row, /^[A-Z][A-Z_0-9]*$/, `${path.basename(file)}: invalid key ${row}`);
  }
  assert.equal(new Set(rows).size, rows.length, "ai-gateway.env.keys: duplicate keys");
  assert.deepEqual(rows, [...rows].sort(), "ai-gateway.env.keys: keys must stay sorted");
  return new Set(rows);
}

test("Belayo Dokploy and self-host declare the same AI Gateway environment", () => {
  const compose = composeGatewayEnvKeys();
  const belayo = belayoGatewayEnvKeys();
  assert.deepEqual(
    [...belayo].filter((key) => !compose.has(key)).sort(),
    [],
    "declared for Belayo but missing from the self-host allowlist",
  );
  assert.deepEqual(
    [...compose].filter((key) => !belayo.has(key)).sort(),
    [],
    "declared for self-host but missing from the Belayo manifest",
  );
});
