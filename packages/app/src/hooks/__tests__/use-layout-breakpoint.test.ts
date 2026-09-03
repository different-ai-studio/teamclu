import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSoloBuild: vi.fn(() => false),
}));

vi.mock("@/lib/config/solo-build", () => ({
  isSoloBuild: () => mocks.isSoloBuild(),
}));

import {
  getLayoutBreakpointForWidth,
  resolveLayoutBreakpoint,
} from "../use-layout-breakpoint";

describe("getLayoutBreakpointForWidth", () => {
  it("keeps the session list hidden until the message pane has more room", () => {
    expect(getLayoutBreakpointForWidth(899)).toBe("narrow");
    expect(getLayoutBreakpointForWidth(900)).toBe("medium");
    expect(getLayoutBreakpointForWidth(1023)).toBe("medium");
    expect(getLayoutBreakpointForWidth(1024)).toBe("wide");
  });
});

describe("resolveLayoutBreakpoint", () => {
  afterEach(() => {
    mocks.isSoloBuild.mockReturnValue(false);
  });

  it("follows width breakpoints when not solo", () => {
    mocks.isSoloBuild.mockReturnValue(false);
    expect(resolveLayoutBreakpoint(1280)).toBe("wide");
    expect(resolveLayoutBreakpoint(950)).toBe("medium");
  });

  it("locks to narrow in solo builds regardless of width", () => {
    mocks.isSoloBuild.mockReturnValue(true);
    expect(resolveLayoutBreakpoint(480)).toBe("narrow");
    expect(resolveLayoutBreakpoint(900)).toBe("narrow");
    expect(resolveLayoutBreakpoint(1600)).toBe("narrow");
  });
});
