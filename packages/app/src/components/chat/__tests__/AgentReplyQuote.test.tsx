import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  AgentReplyQuote,
  parseReplyQuoteContent,
} from "../AgentReplyQuote";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const template = fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
        String(options?.[token] ?? `{{${token}}}`),
      );
    },
  }),
}));

describe("AgentReplyQuote", () => {
  it("renders soft-strip with inline agent pill and jumps on click", () => {
    const onJump = vi.fn();
    render(
      <AgentReplyQuote
        authorName="你"
        content="[Mentioned agents: JJJJ]\nsleep10"
        onJump={onJump}
      />,
    );
    const quote = screen.getByTestId("agent-reply-quote");
    expect(quote.textContent).toContain("你");
    expect(quote.textContent).toContain("sleep10");
    expect(quote.textContent).not.toContain("[Mentioned agents:");
    const pill = screen.getByTestId("agent-reply-quote-pill");
    expect(pill.textContent).toContain("AGENT");
    expect(pill.textContent).toContain("@JJJJ");
    fireEvent.click(quote);
    expect(onJump).toHaveBeenCalledOnce();
  });

  it("parses mentioned agents into pills and strips body noise", () => {
    expect(
      parseReplyQuoteContent("[Mentioned agents: JJJJ, Research]\nsleep10"),
    ).toEqual({
      agentNames: ["JJJJ", "Research"],
      body: "sleep10",
    });
    expect(parseReplyQuoteContent("@JJJJ sleep10")).toEqual({
      agentNames: [],
      body: "sleep10",
    });
  });
});
