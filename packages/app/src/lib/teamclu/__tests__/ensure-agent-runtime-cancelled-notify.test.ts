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
    // Only the reporter is stubbed — `isCancelledRuntimeFailure` stays real, so
    // this exercises the actual classification rather than a copy of it.
    reportRuntimeStartFailure: (...args: unknown[]) =>
      mocks.reportRuntimeStartFailure(...args),
  };
});

/** The toast path is behind a dynamic `import("sonner")`. */
async function flush(): Promise<void> {
  await import("sonner");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("notifyRuntimeStartFailures", () => {
  beforeEach(() => {
    mocks.toastError.mockClear();
    mocks.reportRuntimeStartFailure.mockClear();
  });

  it("does not toast a request we cancelled ourselves", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures(
      [{ agentActorId: "agent-1", code: "runtime_rpc_failed", reason: "rpc disposed" }],
      { trigger: "session_runtime_retry" },
    );
    await flush();

    // Still reported — the startup race stays measurable, just as a warning.
    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not toast when an agent device is offline", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures(
      [{ agentActorId: "remote-agent-1", code: "device_offline", reason: "device offline" }],
      { trigger: "session_runtime_retry" },
    );
    await flush();

    // The persistent agent status already shows offline. Keep the failure in
    // telemetry for diagnosis without duplicating it as a transient toast.
    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not toast a transient Cloud API network failure", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures(
      [
        {
          agentActorId: "agent-1",
          code: "runtime_rpc_failed",
          reason:
            "fetch_session_with_participants failed: cloud_api provider error: None: error sending request for url (https://api.teamclu-dev.ucar.cc/v1/auth/refresh)",
        },
      ],
      { trigger: "session_runtime_retry" },
    );
    await flush();

    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("still toasts a terminal Cloud API auth failure", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures([
      {
        agentActorId: "agent-1",
        code: "runtime_rpc_failed",
        reason: "fetch_session_with_participants failed: auth error: invalid_grant",
      },
    ]);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it("still toasts a genuine runtime failure", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures([
      { agentActorId: "agent-1", code: "runtime_rpc_failed", reason: "rpc timeout after 20000ms" },
    ]);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it("toasts only the real failures in a mixed batch", async () => {
    const { notifyRuntimeStartFailures } = await import("@/lib/teamclu/ensure-agent-runtime");

    notifyRuntimeStartFailures([
      { agentActorId: "agent-1", code: "runtime_rpc_failed", reason: "rpc disposed" },
      { agentActorId: "agent-2", code: "runtime_rpc_failed", reason: "runtimeStart rejected" },
      { agentActorId: "agent-3", code: "device_offline", reason: "device offline" },
    ]);
    await flush();

    expect(mocks.reportRuntimeStartFailure).toHaveBeenCalledTimes(3);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    const [, options] = mocks.toastError.mock.calls[0] as [string, { id: string }];
    expect(options.id).toBe("runtime-start-failed-agent-2");
  });

  it("shows host capacity full instead of agent-not-started", async () => {
    const i18n = (await import("@/lib/i18n")).default;
    const { classifyRuntimeRpcError } = await import("@/lib/session/session-create");
    const { notifyRuntimeStartFailures } = await import("../ensure-agent-runtime");

    const reason =
      "start_runtime failed: agent error: host_capacity_timeout: 2 active, 0 draining, 0 queued";
    expect(classifyRuntimeRpcError(new Error(reason))).toBe("host_capacity_timeout");

    notifyRuntimeStartFailures([
      {
        agentActorId: "agent-1",
        code: "host_capacity_timeout",
        reason,
      },
    ]);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    const [title, options] = mocks.toastError.mock.calls[0] as [
      string,
      { description: string },
    ];
    expect(title).toBe(i18n.t("daemon.agentRuntime.hostCapacityTitle"));
    expect(title).not.toBe(i18n.t("daemon.agentRuntime.notStartedTitle"));
    expect(options.description).toBe(i18n.t("daemon.agentRuntime.hostCapacityDesc"));
  });
});
