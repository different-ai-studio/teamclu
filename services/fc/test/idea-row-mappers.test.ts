/**
 * The row mappers for ideas, tested directly.
 *
 * The repository contract already asserts the shape of a list item, but it
 * runs against the hand-written fake in repository-contract.test.ts — so a
 * field that never reaches the real Supabase mapper passes it. That is exactly
 * what happened: `attachmentUrls` was added to the wrong function, the contract
 * stayed green, and every idea came back over the wire without its pictures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapIdeaRow, mapIdeaFeedRow, mapSessionFull } from "../src/lib/supabase-repo/shared.js";

const ideaRow = {
  id: "idea-1",
  team_id: "team-1",
  title: "A post",
  description: "with words",
  archived: false,
  workspace_id: null,
  status: "open",
  sort_order: 0,
  created_by_actor_id: "actor-1",
  created_at: "2026-09-22T00:00:00Z",
  updated_at: "2026-09-22T00:00:00Z",
  attachment_urls: ["https://cdn.example/a.png", "https://cdn.example/b.png"],
};

test("mapIdeaRow carries the post's pictures", () => {
  assert.deepEqual(mapIdeaRow(ideaRow).attachmentUrls, [
    "https://cdn.example/a.png",
    "https://cdn.example/b.png",
  ]);
});

test("mapIdeaRow reports no pictures as an empty list, not a missing key", () => {
  // A client reading `attachmentUrls.length` should not have to defend
  // against undefined, and an absent key is indistinguishable from a backend
  // that does not know the field at all.
  const mapped = mapIdeaRow({ ...ideaRow, attachment_urls: null });
  assert.ok("attachmentUrls" in mapped);
  assert.deepEqual(mapped.attachmentUrls, []);
});

test("mapIdeaFeedRow adds the counts on top of the idea", () => {
  const mapped = mapIdeaFeedRow({
    ...ideaRow,
    comment_count: "4",   // postgres bigint arrives as a string
    like_count: "12",
    liked_by_me: true,
  });
  assert.equal(mapped.commentCount, 4);
  assert.equal(mapped.likeCount, 12);
  assert.equal(mapped.likedByMe, true);
  assert.deepEqual(mapped.attachmentUrls, ideaRow.attachment_urls);
  assert.equal(mapped.title, "A post");
});

test("mapIdeaFeedRow defaults the counts a plain idea read cannot supply", () => {
  const mapped = mapIdeaFeedRow(ideaRow);
  assert.equal(mapped.commentCount, 0);
  assert.equal(mapped.likeCount, 0);
  assert.equal(mapped.likedByMe, false);
});

test("a session does not carry an idea's attachments", () => {
  // Where the field first landed by mistake. Sessions have their own
  // attachment story; borrowing this key would have invented a second one.
  const mapped = mapSessionFull({
    id: "session-1",
    team_id: "team-1",
    title: "A session",
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
  });
  assert.equal("attachmentUrls" in mapped, false);
});
