import { describe, expect, it } from "vitest";

import { feedBodyText, feedCountLabel, feedMediaTiles } from "../features/ideas/idea-feed";

describe("feedCountLabel", () => {
  it("hides zeros", () => {
    expect(feedCountLabel(0)).toBeNull();
    expect(feedCountLabel(-1)).toBeNull();
    expect(feedCountLabel(12)).toBe("12");
  });
});

describe("feedMediaTiles", () => {
  it("lets a single picture fill the column", () => {
    expect(feedMediaTiles(["a"])).toEqual([{ url: "a", index: 0, fullWidth: true, height: 200 }]);
  });

  it("puts several two-up, with an odd last picture taking the whole row", () => {
    const tiles = feedMediaTiles(["a", "b", "c"]);
    expect(tiles.map((t) => t.fullWidth)).toEqual([false, false, true]);
    expect(tiles.every((t) => t.height === 112)).toBe(true);
  });

  it("shows at most four", () => {
    expect(feedMediaTiles(["a", "b", "c", "d", "e"]).map((t) => t.url)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(feedMediaTiles([])).toEqual([]);
  });
});

describe("feedBodyText", () => {
  it("does not repeat a description that equals the title", () => {
    expect(feedBodyText({ title: "Hi", description: " Hi " })).toEqual({
      title: "Hi",
      description: "",
    });
  });

  it("falls back to the description when there is no title", () => {
    expect(feedBodyText({ title: "  ", description: "Body" })).toEqual({
      title: "Body",
      description: "",
    });
  });
});
