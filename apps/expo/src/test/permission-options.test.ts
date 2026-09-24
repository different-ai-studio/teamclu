import { describe, expect, it } from "vitest";

import { allowOnceOption, permissionOptionsOf } from "../features/sessions/permission-options";

describe("permission options", () => {
  it("reads the options off a permission row", () => {
    expect(
      permissionOptionsOf({
        metadata: { options: [{ id: "a", kind: "allow_once", name: "Allow" }, { kind: "x" }, null] },
      }),
    ).toEqual([{ id: "a", kind: "allow_once", name: "Allow" }]);
    expect(permissionOptionsOf({ metadata: null })).toEqual([]);
  });

  it("picks allow_once, else a non-reject non-always option, else nothing", () => {
    expect(
      allowOnceOption([
        { id: "always", kind: "allow_always", name: "" },
        { id: "once", kind: "allow_once", name: "" },
      ])?.id,
    ).toBe("once");
    expect(
      allowOnceOption([
        { id: "r", kind: "reject_once", name: "" },
        { id: "ok", kind: "custom_allow", name: "" },
      ])?.id,
    ).toBe("ok");
    expect(
      allowOnceOption([
        { id: "always", kind: "allow_always", name: "" },
        { id: "r", kind: "reject_always", name: "" },
      ]),
    ).toBeNull();
  });
});
