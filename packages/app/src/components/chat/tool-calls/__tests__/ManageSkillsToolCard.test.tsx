import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ManageSkillsToolCard } from "../TaskToolCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

describe("ManageSkillsToolCard", () => {
  it("shows refresh failure footnote without encouraging a second create", () => {
    render(
      <ManageSkillsToolCard
        toolCall={{
          id: "manage-1",
          name: "manage_skills",
          toolKind: "other",
          status: "completed",
          arguments: { action: "create", slug: "demo" },
          result: {
            slug: "demo",
            path: "/Users/me/.agents/skills/demo",
            runtimeActivation: "next_start",
            warnings: ["skill_refresh_failed"],
          },
          startTime: new Date(),
        }}
      />,
    );

    expect(
      screen.getByText(/inventory refresh did not complete/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code will also load/i)).not.toBeInTheDocument();
  });

  it("shows refresh and Claude bridge failures together", () => {
    render(
      <ManageSkillsToolCard
        toolCall={{
          id: "manage-2",
          name: "manage_skills",
          toolKind: "other",
          status: "completed",
          arguments: { action: "update", slug: "demo" },
          result: {
            slug: "demo",
            path: "/Users/me/.agents/skills/demo",
            runtimeActivation: "next_start",
            warnings: ["skill_refresh_failed", "claude_bridge_reconcile_failed"],
          },
          startTime: new Date(),
        }}
      />,
    );

    expect(
      screen.getByText(/inventory refresh did not complete/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Claude Code bridge setup did not complete/i),
    ).toBeInTheDocument();
  });
});
