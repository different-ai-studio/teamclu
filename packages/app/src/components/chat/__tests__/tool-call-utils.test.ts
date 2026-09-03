import { describe, expect, it } from "vitest";
import {
  getCommandText,
  getToolCallOutputText,
} from "@/lib/ui/terminal-interaction";

describe("tool-call-utils", () => {
  it("extracts command text from common argument keys", () => {
    expect(getCommandText({ command: "pnpm install" })).toBe("pnpm install");
    expect(getCommandText({ cmd: "npm test" })).toBe("npm test");
    expect(getCommandText({ input: "git status" })).toBe("git status");
  });

  it("extracts output text from structured tool results", () => {
    expect(getToolCallOutputText({ output: "hello" })).toBe("hello");
    expect(getToolCallOutputText({ raw: "world" })).toBe("world");
    expect(getToolCallOutputText("plain")).toBe("plain");
  });

});
