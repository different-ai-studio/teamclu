import { describe, expect, it } from "vitest";
import {
  matchesManageSkillsTool,
  matchesSkillTool,
  matchesWriteTool,
  parseManageSkillsToolResult,
  resolveWireToolName,
  routeToolPresentation,
} from "../tool-call-utils";

describe("routeToolPresentation", () => {
  it("routes execute kind to bash without mutating stored name", () => {
    expect(
      routeToolPresentation({
        name: "Execute ps command",
        toolKind: "execute",
        arguments: { command: "ps aux" },
      }),
    ).toBe("bash");
  });

  it("routes glob ACP title to glob not grep", () => {
    expect(
      routeToolPresentation({
        name: "glob",
        toolKind: "search",
        arguments: { pattern: "**/*.ts", path: "." },
      }),
    ).toBe("glob");
  });

  it("routes write ACP title to write even when kind is edit", () => {
    expect(
      routeToolPresentation({
        name: "write",
        toolKind: "edit",
        arguments: { filePath: "a.ts", content: "hello" },
      }),
    ).toBe("write");
  });

  it("routes content-only edit params to write", () => {
    expect(
      routeToolPresentation({
        name: "Edit src/foo.ts",
        toolKind: "edit",
        arguments: { filePath: "src/foo.ts", content: "hello" },
      }),
    ).toBe("write");
  });

  it("maps legacy other + skill description to skill route", () => {
    expect(
      routeToolPresentation({
        name: "other",
        toolKind: "other",
        arguments: { name: "brainstorming", description: "skill" },
      }),
    ).toBe("skill");
  });

  it("routes manage_skills MCP tool to dedicated presentation", () => {
    expect(
      routeToolPresentation({
        name: "manage_skills",
        toolKind: "other",
        arguments: { action: "create", slug: "demo" },
      }),
    ).toBe("manage_skills");
    expect(
      matchesManageSkillsTool({
        name: "manage_skills",
        toolKind: "other",
        arguments: { action: "create", slug: "demo" },
      }),
    ).toBe(true);
  });
});

describe("parseManageSkillsToolResult", () => {
  it("parses JSON tool results with activation and warnings", () => {
    expect(
      parseManageSkillsToolResult({
        slug: "demo",
        path: "/Users/me/.agents/skills/demo",
        runtimeActivation: "next_start",
        warnings: ["claude_local_override"],
      }),
    ).toEqual({
      slug: "demo",
      path: "/Users/me/.agents/skills/demo",
      runtimeActivation: "next_start",
      warnings: ["claude_local_override"],
    });
  });
});

describe("resolveWireToolName (legacy)", () => {
  it("maps execute kind to bash for old metadata", () => {
    expect(resolveWireToolName("execute", "other", { command: "ls" })).toBe("bash");
  });

  it("maps ACP other + skill title to skill route", () => {
    expect(
      resolveWireToolName("other", "other", {
        name: "brainstorming",
        description: "skill",
      }),
    ).toBe("skill");
  });

  it("keeps explicit skill wire name", () => {
    expect(resolveWireToolName(undefined, "skill", { name: "demo" })).toBe("skill");
  });
});

describe("matchesSkillTool", () => {
  it("recognizes daemon other wire rows for skill invocations", () => {
    expect(
      matchesSkillTool({
        name: "other",
        toolKind: "other",
        arguments: { name: "session-distiller", description: "skill" },
      }),
    ).toBe(true);
  });
});

describe("matchesWriteTool", () => {
  it("matches write title with edit kind", () => {
    expect(
      matchesWriteTool({
        name: "write",
        toolKind: "edit",
        arguments: { filePath: "a.ts", content: "x" },
      }),
    ).toBe(true);
  });
});
