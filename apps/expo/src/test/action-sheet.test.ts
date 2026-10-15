import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  os: "android",
  alert: vi.fn(),
  ios: vi.fn(),
  present: vi.fn(() => true),
}));

vi.mock("react-native", () => ({
  ActionSheetIOS: { showActionSheetWithOptions: native.ios },
  Alert: { alert: native.alert },
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));

vi.mock("../ui/ActionSheetHost", () => ({ presentActionSheet: native.present }));

import { showActionSheet } from "../ui/action-sheet";

const actions = ["Copy", "Reply", "Ask again", "Select"].map((label) => ({ label, run: vi.fn() }));

describe("showActionSheet", () => {
  beforeEach(() => {
    native.os = "android";
    native.alert.mockClear();
    native.ios.mockClear();
    native.present.mockClear();
    native.present.mockReturnValue(true);
  });

  it("hands every action to the Android sheet, not a three-button alert", () => {
    showActionSheet(actions, { cancelLabel: "Cancel" });
    expect(native.present).toHaveBeenCalledWith({ actions, cancelLabel: "Cancel", title: undefined });
    expect(native.alert).not.toHaveBeenCalled();
  });

  it("falls back to the alert only when no sheet host is mounted", () => {
    native.present.mockReturnValue(false);
    showActionSheet(actions, { cancelLabel: "Cancel" });
    expect(native.alert).toHaveBeenCalledTimes(1);
  });

  it("keeps the native action sheet on iOS", () => {
    native.os = "ios";
    showActionSheet(actions, { cancelLabel: "Cancel" });
    expect(native.ios).toHaveBeenCalledTimes(1);
    expect(native.present).not.toHaveBeenCalled();
  });
});
