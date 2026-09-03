import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CLAUDE.md: "Never use longest content strategy on completion." The one
// sanctioned exception is reconcileEquivalentAgentReplyText in
// lib/agent/agent-reply-transcript.ts, which picks the longer of two texts that are
// equivalent after normalization (QoS0 can drop post-tool deltas; the daemon
// final carries the tail). Everything else must go through that helper, so
// pickCanonicalAgentReplyText may be imported from exactly one production
// module.

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = path.resolve(path.dirname(__filename), "..", "..");
const ALLOWED_IMPORTER = path.join(SRC_DIR, "lib", "agent", "agent-reply-transcript.ts");

const IMPORT_RE = /\bimport\b[^;]*\bpickCanonicalAgentReplyText\b[^;]*\bfrom\s+['"][^'"]*agent-reply-text['"]/s;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("guardrail: agent reply text has one reconciliation point", () => {
  it("detects the import shape it guards against", () => {
    expect(
      IMPORT_RE.test(
        'import { agentReplyTextsEquivalent, pickCanonicalAgentReplyText } from "@/lib/agent/agent-reply-text";',
      ),
    ).toBe(true);
    expect(
      IMPORT_RE.test('import {\n  pickCanonicalAgentReplyText,\n} from "@/lib/agent/agent-reply-text";'),
    ).toBe(true);
    expect(
      IMPORT_RE.test('import { agentReplyTextsEquivalent } from "@/lib/agent/agent-reply-text";'),
    ).toBe(false);
  });

  it("only lib/agent/agent-reply-transcript.ts imports pickCanonicalAgentReplyText", () => {
    const offenders = walk(SRC_DIR)
      .filter((file) => path.resolve(file) !== ALLOWED_IMPORTER)
      .filter((file) => IMPORT_RE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });

  it("the sanctioned importer exists and exposes the reconciliation helper", () => {
    const source = fs.readFileSync(ALLOWED_IMPORTER, "utf8");
    expect(IMPORT_RE.test(source)).toBe(true);
    expect(source).toMatch(/export function reconcileEquivalentAgentReplyText\(/);
  });
});
