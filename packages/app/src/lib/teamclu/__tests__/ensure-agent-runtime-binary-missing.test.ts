import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  reportRuntimeStartFailure: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
}));

vi.mock("@/lib/telemetry/runtime-error-report", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/telemetry/runtime-error-report")
  >();
  return {
    ...actual,
    reportRuntimeStartFailure: (...args: unknown[]) =>
      mocks.reportRuntimeStartFailure(...args),
  };
});

async function flush(): Promise<void> {
  await import("sonner");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function lastDescription(): string {
  const [, options] = mocks.toastError.mock.calls.at(-1) as [
    string,
    { description: string },
  ];
  return options.description;
}

/**
 * The daemon tags a missing-runtime spawn failure with
 * `agent_binary_missing(<agent>)` (opencode_http/supervisor.rs, pi_rpc/process.rs).
 * These assert the desktop side turns that into the actionable message rather
 * than surfacing a raw ENOENT — and that the marker survives the wrapping the
 * daemon's runtime_lifecycle applies on the way out.
 */
describe("binary-missing runtime failures", () => {
  beforeEach(() => {
    mocks.toastError.mockClear();
    mocks.reportRuntimeStartFailure.mockClear();
  });

  it("names the missing runtime from a wrapped opencode failure", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures([
      {
        agentActorId: "agent-1",
        code: "runtime_rejected",
        reason:
          "start_runtime failed: agent error: agent_binary_missing(opencode): " +
          "spawn opencode serve (opencode): No such file or directory (os error 2); " +
          "this team's agents.local_agent is opencode but the binary is not installed on this device",
      },
    ]);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    const description = lastDescription();
    expect(description).toContain("opencode");
    // The raw errno text must not reach the user.
    expect(description).not.toContain("os error 2");
  });

  it("names pi when pi is the missing runtime", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures([
      {
        agentActorId: "agent-2",
        code: "runtime_rejected",
        reason:
          "start_runtime failed: agent error: agent_binary_missing(pi): " +
          "pi binary (pi) not found; install pi or switch this team's agents.local_agent",
      },
    ]);
    await flush();

    expect(lastDescription()).toContain("pi");
  });

  it("leaves an unrelated spawn failure on the generic path", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures([
      {
        agentActorId: "agent-3",
        code: "runtime_rejected",
        reason: "spawn opencode serve (opencode): Permission denied (os error 13)",
      },
    ]);
    await flush();

    // Not a missing binary — the reason passes through verbatim.
    expect(lastDescription()).toContain("Permission denied");
  });
});
