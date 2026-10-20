import type { Idea } from "./idea-types";

/**
 * Pure layout for the ideas feed card, ported from iOS `IdeaFeedCard` /
 * `IdeaFeedMedia`. Kept free of React Native so vitest can cover it.
 */

/** The most pictures a card shows; the rest are reachable from the viewer. */
export const FEED_MEDIA_MAX_TILES = 4;

export type FeedMediaTile = {
  url: string;
  /** Position in the idea's full attachment list — what the viewer opens at. */
  index: number;
  /** An odd last picture takes the whole row rather than leaving a hole. */
  fullWidth: boolean;
  height: number;
};

export function feedMediaTiles(urls: ReadonlyArray<string>): FeedMediaTile[] {
  const shown = urls.slice(0, FEED_MEDIA_MAX_TILES);
  if (shown.length === 1) {
    return [{ url: shown[0], index: 0, fullWidth: true, height: 200 }];
  }
  return shown.map((url, index) => ({
    url,
    index,
    fullWidth: shown.length % 2 === 1 && index === shown.length - 1,
    height: 112,
  }));
}

/**
 * The number printed beside a feed glyph, or null to print none. A zero is
 * not worth printing — the glyph alone already says "nobody yet".
 */
export function feedCountLabel(count: number): string | null {
  return Number.isFinite(count) && count > 0 ? String(Math.floor(count)) : null;
}

/**
 * The post's words: title and description as one body. A description that
 * just repeats the title is not shown twice.
 */
export function feedBodyText(idea: Pick<Idea, "title" | "description">): {
  title: string;
  description: string;
} {
  const title = idea.title.trim();
  const description = idea.description.trim();
  if (!title) return { title: description, description: "" };
  if (!description || description === title) return { title, description: "" };
  return { title, description };
}
