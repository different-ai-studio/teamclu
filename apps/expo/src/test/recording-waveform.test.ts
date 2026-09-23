import { describe, expect, it } from "vitest";

import {
  daemonStatusLabel,
  normalizeMeteringLevel,
  waveformBarHeight,
  dictationLanguage,
  normalizeSpeechVolume,
} from "../features/sessions/voice-level";

describe("normalizeMeteringLevel", () => {
  it("converts dBFS to the linear 0…1 level iOS derives", () => {
    // 0 dBFS is full scale; ×5 then clamps to 1.
    expect(normalizeMeteringLevel(0)).toBe(1);
    // -20 dBFS → amplitude 0.1 → ×5 → 0.5.
    expect(normalizeMeteringLevel(-20)).toBeCloseTo(0.5, 5);
    // -40 dBFS → amplitude 0.01 → ×5 → 0.05.
    expect(normalizeMeteringLevel(-40)).toBeCloseTo(0.05, 5);
  });

  it("floors silence and tolerates a missing reading", () => {
    expect(normalizeMeteringLevel(-160)).toBe(0);
    expect(normalizeMeteringLevel(-200)).toBe(0);
    expect(normalizeMeteringLevel(undefined)).toBe(0);
    expect(normalizeMeteringLevel(Number.NaN)).toBe(0);
  });
});

describe("waveformBarHeight", () => {
  const args = { index: 0, barCount: 7, time: 0 };

  it("stays inside the iOS 4…26pt range at any level", () => {
    for (const level of [0, 0.25, 0.5, 1]) {
      for (const time of [0, 0.4, 1.1, 2.7]) {
        for (let index = 0; index < 7; index += 1) {
          const h = waveformBarHeight({ index, barCount: 7, level, time });
          expect(h).toBeGreaterThanOrEqual(4 + 0.15 * 22);
          expect(h).toBeLessThanOrEqual(4 + 22);
        }
      }
    }
  });

  it("swings wider as the level rises", () => {
    const spread = (level: number) => {
      const heights = Array.from({ length: 40 }, (_, step) =>
        waveformBarHeight({ ...args, level, time: step * 0.05 }),
      );
      return Math.max(...heights) - Math.min(...heights);
    };
    expect(spread(0.9)).toBeGreaterThan(spread(0.1));
  });

  it("clamps an out-of-range level rather than distorting", () => {
    expect(waveformBarHeight({ ...args, level: 5 })).toBe(
      waveformBarHeight({ ...args, level: 1 }),
    );
    expect(waveformBarHeight({ ...args, level: -3 })).toBe(
      waveformBarHeight({ ...args, level: 0 }),
    );
  });
});

describe("daemonStatusLabel", () => {
  it("matches the iOS DaemonStatusBanner copy", () => {
    expect(daemonStatusLabel("connected")).toBe("daemon online");
    expect(daemonStatusLabel("connecting")).toBe("daemon connecting");
    expect(daemonStatusLabel("reconnecting")).toBe("daemon connecting");
    expect(daemonStatusLabel("disconnected")).toBe("daemon offline");
  });
});

describe("normalizeSpeechVolume", () => {
  it("maps the recognizer's -2…10 volume onto 0…1, silence at or below 0", () => {
    expect(normalizeSpeechVolume(-2)).toBe(0);
    expect(normalizeSpeechVolume(0)).toBe(0);
    expect(normalizeSpeechVolume(5)).toBe(0.5);
    expect(normalizeSpeechVolume(10)).toBe(1);
    expect(normalizeSpeechVolume(14)).toBe(1);
    expect(normalizeSpeechVolume(undefined)).toBe(0);
    expect(normalizeSpeechVolume(Number.NaN)).toBe(0);
  });
});

describe("dictationLanguage", () => {
  it("recognises Chinese for any Chinese locale and English otherwise", () => {
    expect(dictationLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(dictationLanguage("zh-TW")).toBe("zh-CN");
    expect(dictationLanguage("en-GB")).toBe("en-US");
    expect(dictationLanguage("ja-JP")).toBe("en-US");
    expect(dictationLanguage(null)).toBe("en-US");
  });
});
