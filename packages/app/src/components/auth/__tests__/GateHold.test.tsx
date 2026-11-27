import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GateHold } from "../GateHold";
import { useDaemonOnboardingStore } from "@/stores/daemon-onboarding";

afterEach(() => {
  document.getElementById("skeleton")?.remove();
  useDaemonOnboardingStore.setState({ step: null });
});

describe("GateHold", () => {
  it("renders nothing while the startup skeleton still covers the window", () => {
    const skeleton = document.createElement("div");
    skeleton.id = "skeleton";
    document.body.appendChild(skeleton);

    const { container } = render(<GateHold />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a loading screen once the skeleton is gone", () => {
    render(<GateHold />);
    expect(screen.getByTestId("auth-gate-hold")).toHaveTextContent("正在进入工作区…");
  });

  it("says the local service is starting while the daemon is rebound for this account", () => {
    useDaemonOnboardingStore.setState({ step: "restart-daemon" });
    render(<GateHold />);
    expect(screen.getByTestId("auth-gate-hold")).toHaveTextContent("正在为这个账号启动本机服务…");
  });
});
