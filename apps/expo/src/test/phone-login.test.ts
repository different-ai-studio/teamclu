import { describe, expect, it } from "vitest";

import {
  canSendPhoneCode,
  normalizePhoneInput,
  parsePhoneAccount,
  parsePhoneLoginResponse,
  phoneAccountInitial,
  phoneAccountLogoUrl,
  phoneAccountSubtitle,
  phoneAccountTitle,
  type PhoneAccount,
} from "../features/onboarding/phone-login";
import { parsePendingInvites } from "../features/onboarding/pending-invites";
import { parseInviteInput } from "../features/onboarding/invite-api";

function account(overrides: Partial<PhoneAccount> = {}): PhoneAccount {
  return {
    id: "user-1",
    orgId: "org-1",
    orgName: "香蕉攀岩",
    orgLogo: null,
    adminType: 2,
    nickname: "小王",
    email: "wang@example.com",
    ...overrides,
  };
}

describe("parsePhoneLoginResponse", () => {
  it("returns the session when the phone maps to one account", () => {
    const session = { access_token: "a", refresh_token: "r", expires_in: 3600, user: null };
    expect(parsePhoneLoginResponse({ session, user: {} })).toEqual({
      type: "session",
      session,
    });
  });

  it("returns the accounts, snake_case mapped, when there are several", () => {
    const result = parsePhoneLoginResponse({
      multiUser: true,
      users: [
        {
          id: "u1",
          org_id: "o1",
          org_name: "Betly",
          org_logo: "https://cdn.example/logo.png",
          admin_type: 2,
          nickname: "Ann",
          email: "ann@example.com",
        },
        { id: "u2", org_id: null, org_name: null, nickname: "", email: "" },
        { nickname: "no id — dropped" },
      ],
    });
    expect(result).toEqual({
      type: "multiUser",
      accounts: [
        {
          id: "u1",
          orgId: "o1",
          orgName: "Betly",
          orgLogo: "https://cdn.example/logo.png",
          adminType: 2,
          nickname: "Ann",
          email: "ann@example.com",
        },
        {
          id: "u2",
          orgId: null,
          orgName: null,
          orgLogo: null,
          adminType: 0,
          nickname: "",
          email: "",
        },
      ],
    });
  });

  it("throws when there is neither a session nor a picker", () => {
    expect(() => parsePhoneLoginResponse({})).toThrow();
    expect(() => parsePhoneLoginResponse({ session: { access_token: "a" } })).toThrow();
    expect(() => parsePhoneLoginResponse(null)).toThrow();
  });
});

describe("phone account picker rows", () => {
  it("titles with the nickname and puts the email underneath", () => {
    const a = account();
    expect(phoneAccountTitle(a)).toBe("小王");
    expect(phoneAccountSubtitle(a)).toBe("wang@example.com");
  });

  it("falls back to the email as the title, with no subtitle", () => {
    const a = account({ nickname: "" });
    expect(phoneAccountTitle(a)).toBe("wang@example.com");
    expect(phoneAccountSubtitle(a)).toBeNull();
  });

  it("uses the org initial for the placeholder logo, then the account's", () => {
    expect(phoneAccountInitial(account())).toBe("香");
    expect(phoneAccountInitial(account({ orgName: null, nickname: "ann" }))).toBe("A");
    expect(
      phoneAccountInitial(account({ orgName: null, nickname: "", email: "" })),
    ).toBe("?");
  });

  it("only loads http(s) logos", () => {
    expect(phoneAccountLogoUrl(account({ orgLogo: "https://cdn.example/l.png" }))).toBe(
      "https://cdn.example/l.png",
    );
    expect(phoneAccountLogoUrl(account({ orgLogo: "logos/l.png" }))).toBeNull();
    expect(phoneAccountLogoUrl(account({ orgLogo: null }))).toBeNull();
  });

  it("parsePhoneAccount rejects rows without an id", () => {
    expect(parsePhoneAccount({ id: "  " })).toBeNull();
    expect(parsePhoneAccount("x")).toBeNull();
  });
});

describe("phone input", () => {
  it("normalizes separators and keeps a leading +", () => {
    expect(normalizePhoneInput(" +86 138-0013 8000 ")).toBe("+8613800138000");
    expect(normalizePhoneInput("(138) 0013")).toBe("1380013");
  });

  it("needs more than a bare country prefix before sending", () => {
    expect(canSendPhoneCode("+86")).toBe(false);
    expect(canSendPhoneCode("+86 1")).toBe(false);
    expect(canSendPhoneCode("+86138")).toBe(true);
  });
});

describe("parsePendingInvites", () => {
  it("maps rows and drops ones missing an invite or team id", () => {
    expect(
      parsePendingInvites({
        items: [
          {
            inviteId: "i1",
            teamId: "t1",
            teamName: "Ops",
            teamRole: "member",
            invitedByDisplayName: "Lin",
          },
          { inviteId: "i2", teamId: "t2", teamName: null },
          { teamId: "t3" },
        ],
      }),
    ).toEqual([
      {
        id: "i1",
        teamId: "t1",
        teamName: "Ops",
        teamRole: "member",
        invitedByDisplayName: "Lin",
      },
      { id: "i2", teamId: "t2", teamName: null, teamRole: null, invitedByDisplayName: null },
    ]);
  });

  it("reads a malformed body as no invites", () => {
    expect(parsePendingInvites(null)).toEqual([]);
    expect(parsePendingInvites({ items: "nope" })).toEqual([]);
  });
});

describe("parseInviteInput", () => {
  it("takes the token out of an invite link", () => {
    expect(parseInviteInput("teamclu://invite?token=abc")).toBe("abc");
    expect(parseInviteInput("  teamclu://invite/xyz  ")).toBe("xyz");
  });

  it("treats input without a scheme as a bare token", () => {
    expect(parseInviteInput("  tok_123 ")).toBe("tok_123");
  });

  it("rejects other URLs and empty input", () => {
    expect(parseInviteInput("https://example.com/other")).toBeNull();
    expect(parseInviteInput("   ")).toBeNull();
    expect(parseInviteInput(null)).toBeNull();
  });
});
