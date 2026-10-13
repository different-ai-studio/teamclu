import { describe, expect, it } from "vitest";
import {
  latestAgentReply,
  supportAnalysisPrompt,
  truncateConclusion,
  SUPPORT_CONCLUSION_MAX,
} from "../handoff";

describe("support handoff", () => {
  it("truncates a conclusion to 4000 characters", () => {
    const text = "字".repeat(4001);
    expect(Array.from(truncateConclusion(text)).length).toBe(SUPPORT_CONCLUSION_MAX);
  });

  it("asks the agent for the three support answers and includes the bundle", () => {
    const prompt = supportAnalysisPrompt({ snapshot: { phase: "install" } });
    expect(prompt).toContain("卡在哪一步");
    expect(prompt).toContain("证据在哪");
    expect(prompt).toContain("用户下一步做什么");
    expect(prompt).toContain('"phase": "install"');
  });

  it("keeps the newest reply from the local agent", () => {
    const text = latestAgentReply(
      [
        { sender_actor_id: "user", content: "诊断包", created_at: "2026-10-13T00:00:00Z" },
        { sender_actor_id: "agent", content: "先看安装目录", created_at: "2026-10-13T00:00:02Z" },
        { sender_actor_id: "agent", content: "旧结论", created_at: "2026-10-13T00:00:01Z" },
      ],
      "agent",
    );
    expect(text).toBe("先看安装目录");
  });
});
