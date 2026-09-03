import { describe, expect, it } from "vitest";
import {
  formatAcpDebugFileBlock,
  formatAcpDebugLine,
} from "@/lib/diagnostics/acp-debug-file-log";
import type { AcpDebugLine } from "@/stores/acp-debug-store";

const sampleLine: AcpDebugLine = {
  id: "1",
  ts: 1_700_000_000_000,
  sessionId: "sess-a",
  topic: "amux/team/session/s1/live",
  actorId: "actor-1",
  eventCase: "live:toolResult",
  payload: { ok: true },
};

describe("acp-debug-file-log", () => {
  it("formats a line for clipboard and file blocks", () => {
    const line = formatAcpDebugLine(sampleLine);
    expect(line).toContain("live:toolResult");
    expect(line).toContain('"ok": true');
    expect(formatAcpDebugFileBlock(sampleLine)).toContain("\n\n---\n\n");
  });
});
