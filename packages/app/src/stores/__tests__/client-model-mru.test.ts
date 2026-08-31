import { describe, it, expect, beforeEach } from "vitest";
import {
  useClientModelMruStore,
  firstAvailableMruModel,
  promote,
} from "@/stores/client-model-mru";

const CATALOG = [{ id: "a/1" }, { id: "b/2" }, { id: "c/3" }];

beforeEach(() => {
  useClientModelMruStore.getState().clear();
});

describe("client model MRU", () => {
  it("moves an existing entry to the front", () => {
    const s = useClientModelMruStore.getState();
    s.record("opencode", "team-1", "a/1");
    s.record("opencode", "team-1", "b/2");
    s.record("opencode", "team-1", "a/1");
    expect(useClientModelMruStore.getState().recentFor("opencode", "team-1")).toEqual([
      "a/1",
      "b/2",
    ]);
  });

  it("keeps backends apart", () => {
    // Model ids are backend-local: a pi id handed to opencode is not a degraded
    // answer, it is a wrong one.
    const s = useClientModelMruStore.getState();
    s.record("opencode", "team-1", "opencode/big-pickle");
    s.record("pi", "team-1", "anthropic/claude-sonnet-4-6");

    const get = useClientModelMruStore.getState();
    expect(get.recentFor("opencode", "team-1")).toEqual(["opencode/big-pickle"]);
    expect(get.recentFor("pi", "team-1")).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(get.recentFor("cursor", "team-1")).toEqual([]);
  });

  it("keeps teams apart", () => {
    // Catalogs vary by team (the team's shared gateway models), which is the
    // only variable #742 could actually attribute a catalog difference to.
    const s = useClientModelMruStore.getState();
    s.record("opencode", "team-1", "gateway/team-1-only");
    s.record("opencode", "team-2", "gateway/team-2-only");

    const get = useClientModelMruStore.getState();
    expect(get.recentFor("opencode", "team-1")).toEqual(["gateway/team-1-only"]);
    expect(get.recentFor("opencode", "team-2")).toEqual(["gateway/team-2-only"]);
  });

  it("ignores blank inputs rather than storing empty keys", () => {
    const s = useClientModelMruStore.getState();
    s.record("opencode", "team-1", "   ");
    s.record("", "team-1", "a/1");
    s.record("opencode", "", "a/1");
    expect(useClientModelMruStore.getState().byBackendTeam).toEqual({});
  });

  it("caps the list at 10", () => {
    const s = useClientModelMruStore.getState();
    for (let i = 0; i < 15; i++) s.record("opencode", "team-1", `p/${i}`);
    const recent = useClientModelMruStore.getState().recentFor("opencode", "team-1");
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe("p/14");
  });
});

describe("promote", () => {
  it("returns the same array reference when nothing changed", () => {
    // Lets the store skip the write, so re-picking the current model does not
    // re-render every subscriber.
    const recent = ["a/1", "b/2"];
    expect(promote(recent, "a/1")).toBe(recent);
  });
});

describe("firstAvailableMruModel", () => {
  it("skips entries the catalog no longer offers", () => {
    // The point of keeping a list: "last used" was retired, so the next usable
    // entry wins instead of pinning something that cannot run.
    expect(firstAvailableMruModel(["gone/x", "b/2"], CATALOG)).toBe("b/2");
  });

  it("returns empty when nothing matches", () => {
    expect(firstAvailableMruModel(["gone/x"], CATALOG)).toBe("");
  });

  it("returns empty when the catalog has not arrived", () => {
    // Empty catalog means "unknown", not "nothing runnable" — pinning against
    // an unknown catalog is how the wrong model got stuck before.
    expect(firstAvailableMruModel(["a/1"], [])).toBe("");
  });

  it("returns empty for an empty history", () => {
    expect(firstAvailableMruModel([], CATALOG)).toBe("");
    expect(firstAvailableMruModel(undefined, CATALOG)).toBe("");
  });
});
