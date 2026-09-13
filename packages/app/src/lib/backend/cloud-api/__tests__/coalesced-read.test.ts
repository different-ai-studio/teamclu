import { describe, expect, it, vi } from "vitest";
import { createCoalescedRead } from "@/lib/backend/cloud-api/coalesced-read";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createCoalescedRead", () => {
  it("shares one request between callers that ask while it is in flight", async () => {
    const read = createCoalescedRead<string>({});
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);

    const a = read.get("k", load);
    const b = read.get("k", load);
    pending.resolve("v");

    await expect(Promise.all([a, b])).resolves.toEqual(["v", "v"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reuses a settled answer inside the window and reloads after it", async () => {
    let clock = 1_000;
    const read = createCoalescedRead<number>({ ttlMs: 2_000, now: () => clock });
    let n = 0;
    const load = vi.fn(async () => ++n);

    expect(await read.get("k", load)).toBe(1);
    clock += 1_999;
    expect(await read.get("k", load)).toBe(1);
    clock += 1;
    expect(await read.get("k", load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets a settled answer once its window has passed, even with no read in between", async () => {
    vi.useFakeTimers();
    try {
      const read = createCoalescedRead<number>({ ttlMs: 2_000, now: () => 0 });
      let n = 0;
      const load = vi.fn(async () => ++n);
      await read.get("k", load);
      vi.advanceTimersByTime(2_000);
      expect(await read.get("k", load)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps keys apart", async () => {
    const read = createCoalescedRead<string>({});
    const load = vi.fn(async () => "x");
    await read.get("a", load);
    await read.get("b", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("goes to the network when asked for a fresh answer", async () => {
    const read = createCoalescedRead<number>({});
    let n = 0;
    const load = vi.fn(async () => ++n);
    await read.get("k", load);
    expect(await read.get("k", load, { fresh: true })).toBe(2);
    expect(await read.get("k", load)).toBe(2);
  });

  it("does not keep a failure", async () => {
    const read = createCoalescedRead<string>({});
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("ok");

    await expect(read.get("k", load)).rejects.toThrow("offline");
    await expect(read.get("k", load)).resolves.toBe("ok");
  });

  it("drops what invalidate names, or everything", async () => {
    const read = createCoalescedRead<number>({});
    let n = 0;
    const load = vi.fn(async () => ++n);
    await read.get("a", load);
    await read.get("b", load);

    read.invalidate("a");
    expect(await read.get("a", load)).toBe(3);
    expect(await read.get("b", load)).toBe(2);

    read.invalidate();
    expect(await read.get("b", load)).toBe(4);
  });

  it("an invalidation during a request is not undone when it settles", async () => {
    const read = createCoalescedRead<number>({});
    const pending = deferred<number>();
    const first = read.get("k", () => pending.promise);
    read.invalidate("k");
    pending.resolve(1);
    await first;

    const load = vi.fn(async () => 2);
    expect(await read.get("k", load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares an uncacheable answer with concurrent callers but does not keep it", async () => {
    const read = createCoalescedRead<string[]>({ cacheable: (rows) => rows.length > 0 });
    const pending = deferred<string[]>();
    const load = vi.fn(() => pending.promise);

    const a = read.get("k", load);
    const b = read.get("k", load);
    pending.resolve([]);
    await Promise.all([a, b]);
    expect(load).toHaveBeenCalledTimes(1);

    await read.get("k", async () => ["x"]);
    const later = vi.fn(async () => ["y"]);
    expect(await read.get("k", later)).toEqual(["x"]);
    expect(later).not.toHaveBeenCalled();
  });
});
