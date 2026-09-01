import { describe, expect, it } from "vitest";
import {
  clearThreadForkMetadataForTests,
  rememberThreadForkMetadata,
  resolveThreadForkFrom,
} from "@/lib/thread-fork-metadata";
import { runtimeForkFromForSession } from "@/lib/thread-fork";

describe("thread-fork-metadata", () => {
  it("remembers and resolves fork anchor by thread session id", () => {
    clearThreadForkMetadataForTests();
    rememberThreadForkMetadata("thread-1", "parent-1", "msg-anchor");
    expect(resolveThreadForkFrom("thread-1")).toEqual({
      parentSessionId: "parent-1",
      rootMessageId: "msg-anchor",
    });
    expect(runtimeForkFromForSession("thread-1")).toEqual({
      parentSessionId: "parent-1",
      rootMessageId: "msg-anchor",
    });
  });

  it("returns undefined when thread session is unknown", () => {
    clearThreadForkMetadataForTests();
    expect(runtimeForkFromForSession("missing")).toBeUndefined();
  });
});
