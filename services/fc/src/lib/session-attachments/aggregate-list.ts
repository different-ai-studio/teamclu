import {
  dedupeSessionAttachments,
  extractSessionAttachmentsFromMessage,
  type ExtractedSessionAttachment,
  type SessionAttachmentExtractRow,
} from "./extract-from-metadata.js";

export type SessionAttachmentListCursor = {
  attachedAt: string;
  storagePath: string;
};

export function aggregateSessionAttachmentsFromMessages(
  rows: SessionAttachmentExtractRow[],
): ExtractedSessionAttachment[] {
  const flat: ExtractedSessionAttachment[] = [];
  for (const row of rows) {
    flat.push(...extractSessionAttachmentsFromMessage(row));
  }
  return dedupeSessionAttachments(flat);
}

export function paginateSessionAttachments(
  sorted: ExtractedSessionAttachment[],
  cursor: SessionAttachmentListCursor | null,
  limit: number,
): { items: ExtractedSessionAttachment[]; nextCursor: SessionAttachmentListCursor | null } {
  let start = 0;
  if (cursor?.attachedAt && cursor?.storagePath) {
    start = sorted.findIndex(
      (item) =>
        item.attachedAt === cursor.attachedAt && item.storagePath === cursor.storagePath,
    );
    if (start >= 0) start += 1;
    else {
      // Cursor referred to a removed/changed item — skip anything not strictly older.
      start = sorted.findIndex((item) => compareAttachmentSort(item, cursor) < 0);
      if (start < 0) start = sorted.length;
    }
  }

  const items = sorted.slice(start, start + limit);
  if (items.length < limit || start + limit >= sorted.length) {
    return { items, nextCursor: null };
  }
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: { attachedAt: last.attachedAt, storagePath: last.storagePath },
  };
}

function compareAttachmentSort(
  a: ExtractedSessionAttachment,
  b: SessionAttachmentListCursor,
): number {
  if (a.attachedAt !== b.attachedAt) return a.attachedAt > b.attachedAt ? -1 : 1;
  if (a.storagePath !== b.storagePath) return a.storagePath > b.storagePath ? -1 : 1;
  return 0;
}
