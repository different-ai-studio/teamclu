import { describe, expect, it } from "vitest";
import { getCommandText, getToolCallOutputText } from "@/lib/ui/terminal-interaction";

describe("terminal-interaction", () => {
  it("extracts command text from common argument names", () => {
    expect(getCommandText({ command: "ps aux" })).toBe("ps aux");
    expect(getCommandText({ cmd: "git status" })).toBe("git status");
    expect(getCommandText({ input: "pwd" })).toBe("pwd");
  });

  it("does not treat a command description as terminal output", () => {
    expect(
      getToolCallOutputText("List top processes", {
        command: "ps aux | head -30",
        description: "List top processes",
      }),
    ).toBe("");
  });

  it("keeps real terminal output even when command metadata has a description", () => {
    expect(
      getToolCallOutputText("TC_STDOUT_MARKER_20260525\n", {
        command: "printf 'TC_STDOUT_MARKER_20260525\\n'",
        description: "Print the specified marker string",
      }),
    ).toBe("TC_STDOUT_MARKER_20260525\n");
  });

  it("extracts output from ACP-style metadata objects", () => {
    expect(
      getToolCallOutputText({
        metadata: {
          output: "TC_STDOUT_MARKER_20260525\n",
          description: "Print the specified marker string",
          exit: 0,
        },
      }),
    ).toBe("TC_STDOUT_MARKER_20260525\n");
  });

  it("extracts nested ACP content blocks without hiding other output fields", () => {
    expect(
      getToolCallOutputText({
        content: [
          {
            type: "content",
            content: { type: "text", text: "nested stdout\n" },
          },
        ],
      }),
    ).toBe("nested stdout\n");

    expect(
      getToolCallOutputText({
        output: "fallback stdout\n",
        content: [],
      }),
    ).toBe("fallback stdout\n");
  });
});
