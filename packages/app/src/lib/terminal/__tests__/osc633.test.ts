import { describe, expect, it, vi } from "vitest";
import { handleOsc633 } from "@/lib/terminal/osc633";

describe("handleOsc633", () => {
  it("parses prompt and exit markers without payload", () => {
    const onFinish = vi.fn();
    handleOsc633("A", { onCommandFinish: onFinish });
    handleOsc633("B", { onCommandFinish: onFinish });
    handleOsc633("C", { onCommandFinish: onFinish });
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("parses D with exit code", () => {
    const onFinish = vi.fn();
    handleOsc633("D;0", { onCommandFinish: onFinish });
    handleOsc633("D;130", { onCommandFinish: onFinish });
    expect(onFinish.mock.calls).toEqual([[0], [130]]);
  });

  it("parses D without exit code as null", () => {
    const onFinish = vi.fn();
    handleOsc633("D", { onCommandFinish: onFinish });
    handleOsc633("D;", { onCommandFinish: onFinish });
    expect(onFinish.mock.calls).toEqual([[null], [null]]);
  });

  it("parses E command line, decoding hex escapes", () => {
    const onStart = vi.fn();
    handleOsc633("E;ls -la", { onCommandStart: onStart });
    handleOsc633("E;echo 'a\\x3bb'", { onCommandStart: onStart });
    handleOsc633("E;path\\\\here", { onCommandStart: onStart });
    expect(onStart.mock.calls).toEqual([["ls -la"], ["echo 'a;b'"], ["path\\here"]]);
  });

  it("ignores E nonce when present after second semicolon", () => {
    const onStart = vi.fn();
    handleOsc633("E;ls;abc123", { onCommandStart: onStart });
    expect(onStart).toHaveBeenCalledWith("ls");
  });

  it("parses P;Cwd=...", () => {
    const onCwd = vi.fn();
    handleOsc633("P;Cwd=/Users/foo", { onCwd });
    handleOsc633("P;Cwd=/tmp/with\\x3bsemi", { onCwd });
    expect(onCwd.mock.calls).toEqual([["/Users/foo"], ["/tmp/with;semi"]]);
  });

  it("ignores P keys other than Cwd", () => {
    const onCwd = vi.fn();
    handleOsc633("P;ContinuationPrompt=>", { onCwd });
    expect(onCwd).not.toHaveBeenCalled();
  });

  it("ignores unknown subcommands silently", () => {
    const handlers = {
      onCwd: vi.fn(),
      onCommandStart: vi.fn(),
      onCommandFinish: vi.fn(),
    };
    handleOsc633("Z;whatever", handlers);
    expect(handlers.onCwd).not.toHaveBeenCalled();
    expect(handlers.onCommandStart).not.toHaveBeenCalled();
    expect(handlers.onCommandFinish).not.toHaveBeenCalled();
  });
});
