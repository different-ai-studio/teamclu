import { describe, expect, it } from "vitest";
import {
  normalizeUnixTimestampSeconds,
  unixTimestampSecondsToIso,
} from "@/lib/messages/message-timestamp";

describe("message timestamps", () => {
  it("keeps canonical Unix seconds unchanged", () => {
    expect(normalizeUnixTimestampSeconds(1_754_058_252n)).toBe(1_754_058_252n);
  });

  it("normalizes legacy milliseconds before they reach local cache or sorting", () => {
    expect(normalizeUnixTimestampSeconds(1_754_058_252_000n)).toBe(1_754_058_252n);
    expect(unixTimestampSecondsToIso(1_754_058_252_000n)).toBe(
      "2025-08-01T14:24:12.000Z",
    );
  });

  it("accepts finer legacy timestamp units and rejects invalid values", () => {
    expect(normalizeUnixTimestampSeconds(1_754_058_252_000_000n)).toBe(1_754_058_252n);
    expect(normalizeUnixTimestampSeconds(0n)).toBe(0n);
  });
});
