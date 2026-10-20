import { describe, expect, it } from "vitest";

import {
  buildFirstMessageWithIdea,
  buildIdeaPreface,
} from "../features/sessions/idea-preface";
import type { Idea } from "../features/ideas/idea-types";

function makeIdea(partial: Partial<Idea>): Idea {
  return {
    ideaId: "i1",
    teamId: "t1",
    workspaceId: null,
    workspaceName: null,
    createdByActorId: null,
    title: "",
    description: "",
    status: "open",
    archived: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachmentUrls: [],
    commentCount: 0,
    likeCount: 0,
    likedByMe: false,
    ...partial,
  };
}

describe("buildIdeaPreface", () => {
  it("returns null for nullish idea", () => {
    expect(buildIdeaPreface(null)).toBeNull();
    expect(buildIdeaPreface(undefined)).toBeNull();
  });

  it("returns null when title and description are both empty", () => {
    expect(buildIdeaPreface(makeIdea({ title: "  ", description: " " }))).toBeNull();
  });

  it("uses title only when description is empty", () => {
    expect(
      buildIdeaPreface(makeIdea({ title: "Ship onboarding", description: "" })),
    ).toBe("Idea: Ship onboarding");
  });

  it("uses description only when title is empty", () => {
    expect(
      buildIdeaPreface(makeIdea({ title: "", description: "Pin the home screen" })),
    ).toBe("Idea: Pin the home screen");
  });

  it("combines title and description with a blank line when they differ", () => {
    expect(
      buildIdeaPreface(
        makeIdea({ title: "Pin the home screen", description: "And add a tour." }),
      ),
    ).toBe("Idea: Pin the home screen\n\nAnd add a tour.");
  });

  it("falls back to a single line when title and description match (after trim)", () => {
    expect(
      buildIdeaPreface(makeIdea({ title: "Same text", description: "  Same text  " })),
    ).toBe("Idea: Same text");
  });
});

describe("buildFirstMessageWithIdea", () => {
  it("returns the user text unchanged when there is no idea", () => {
    expect(buildFirstMessageWithIdea("hello", null)).toBe("hello");
  });

  it("prepends the idea preface separated by a blank line", () => {
    const idea = makeIdea({ title: "Ship X", description: "before EOQ" });
    expect(buildFirstMessageWithIdea("any update?", idea)).toBe(
      "Idea: Ship X\n\nbefore EOQ\n\nany update?",
    );
  });

  it("returns the user text unchanged for an empty-content idea", () => {
    const idea = makeIdea({ title: " ", description: " " });
    expect(buildFirstMessageWithIdea("hi", idea)).toBe("hi");
  });
});
