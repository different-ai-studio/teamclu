import { describe, expect, it, vi } from "vitest";

vi.mock("react-native-gesture-handler", () => ({ Gesture: {}, GestureDetector: () => null }));
vi.mock("react-native", () => ({
  Animated: { Value: class {}, View: () => null },
  Image: () => null,
  StyleSheet: { create: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe("zoom math", () => {
  it("clamps scale to 1–5× and lets a zoomed image pan only to its edges", async () => {
    const { clampScale, panBound } = await import("../features/sessions/components/ZoomableImage");
    expect(clampScale(0.4)).toBe(1);
    expect(clampScale(9)).toBe(5);
    expect(panBound(400, 1)).toBe(0);
    expect(panBound(400, 2.5)).toBe(300);
  });
});
