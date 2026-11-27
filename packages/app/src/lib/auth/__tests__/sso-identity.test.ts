import { describe, expect, it } from "vitest";

import { isSsoPlaceholderEmail, isSsoPlaceholderName } from "../sso-identity";

describe("sso-identity", () => {
  it("recognises the internal email of an enterprise sign-in account", () => {
    expect(isSsoPlaceholderEmail("e739be68-8d7d-47cc-af42-dd7d6bc77abc@teamclu.wecom")).toBe(true);
    expect(isSsoPlaceholderEmail("x@teamclu.feishu")).toBe(true);
    expect(isSsoPlaceholderEmail("someone@example.com")).toBe(false);
    expect(isSsoPlaceholderEmail("someone@teamclu.wecom.example.com")).toBe(false);
    expect(isSsoPlaceholderEmail(null)).toBe(false);
  });

  it("recognises only the server's fallback name", () => {
    expect(isSsoPlaceholderName("企业微信用户 aa40")).toBe(true);
    expect(isSsoPlaceholderName("钉钉用户 0f9e")).toBe(true);
    expect(isSsoPlaceholderName("企业微信用户 张三")).toBe(false);
    expect(isSsoPlaceholderName("张三")).toBe(false);
    expect(isSsoPlaceholderName(undefined)).toBe(false);
  });
});
