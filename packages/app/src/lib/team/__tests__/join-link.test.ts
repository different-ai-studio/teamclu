import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/build-config", () => ({ appScheme: "teamclu" }));

const { authState } = vi.hoisted(() => ({
  authState: {
    setPendingInviteToken: vi.fn(),
  },
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => authState },
}));

import { parseInviteDeeplink, parseInviteInput } from "../invite-deeplink";
import { joinLinkGoneMessage, parseJoinLink } from "../join-link";
import {
  requestJoinLinkConfirmation,
  resetJoinLinkConfirmationForTests,
  useJoinLinkConfirmation,
} from "../join-link-confirmation";

describe("parseJoinLink", () => {
  it("reads a custom-scheme join link and optional cloud_api_url", () => {
    expect(parseInviteDeeplink("teamclu://join?token=tok-1")).toBeNull();
    expect(parseJoinLink("teamclu://join?token=tok-1&cloud_api_url=https%3A%2F%2Fapi.acme.test")).toEqual({
      token: "tok-1",
      cloudApiUrl: "https://api.acme.test",
    });
    expect(parseJoinLink("https://api.acme.test/join/tok-1")).toEqual({
      token: "tok-1",
      cloudApiUrl: "https://api.acme.test",
    });
    expect(parseJoinLink("teamclu://invite?token=tok-1")).toBeNull();
  });

  it("accepts amux and http pasted input, and rejects extra path segments", () => {
    expect(parseJoinLink("amux://join?token=tok-1")).toEqual({ token: "tok-1", cloudApiUrl: null });
    expect(parseJoinLink("http://api.acme.test/join/tok-1")).toEqual({
      token: "tok-1",
      cloudApiUrl: "http://api.acme.test",
    });
    expect(parseJoinLink("https://api.acme.test/join/tok-1/extra")).toBeNull();
    expect(parseInviteInput("teamclu://join?token=tok-1")).toBeNull();
  });
});

describe("join link confirmation", () => {
  beforeEach(() => {
    resetJoinLinkConfirmationForTests();
    authState.setPendingInviteToken.mockClear();
  });

  it("accepts in memory only and never stashes an invite token", () => {
    requestJoinLinkConfirmation({ token: "tok-1", cloudApiUrl: "https://api.acme.test" });
    useJoinLinkConfirmation.getState().accept();
    expect(useJoinLinkConfirmation.getState().confirmed).toEqual({
      token: "tok-1",
      cloudApiUrl: "https://api.acme.test",
    });
    expect(useJoinLinkConfirmation.getState().requested).toBeNull();
    expect(authState.setPendingInviteToken).not.toHaveBeenCalled();
  });
});

describe("joinLinkGoneMessage", () => {
  it("uses the specified status sentences", () => {
    expect(joinLinkGoneMessage("link_revoked")).toBe("这条链接已停用");
    expect(joinLinkGoneMessage("link_expired")).toBe("这条链接已过期");
    expect(joinLinkGoneMessage("link_exhausted")).toBe("这条链接已达到人数上限");
  });
});
