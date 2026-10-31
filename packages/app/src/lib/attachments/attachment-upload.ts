/**
 * attachment-upload.ts — Upload attachments before sending.
 */

import { getBackend } from "@/lib/backend";
import { compressImageForUpload } from "@/lib/attachments/image-compress";

export interface UploadedAttachment {
  attachmentId: string;
  fileName: string;
  signedUrl: string;
  mimeType: string;
  size: number;
}

const GENERIC_UPLOAD_ERRORS = new Set([
  "cloud api request failed.",
  "internal server error",
]);

/** Server message worth showing under the upload-failed toast. Generic
 * fallbacks are omitted so the toast stays the one sentence the user needs. */
export function attachmentUploadFailureDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const oneLine = error.message.replace(/\s+/g, " ").trim();
  if (!oneLine || GENERIC_UPLOAD_ERRORS.has(oneLine.toLowerCase())) return undefined;
  return oneLine.length > 180 ? `${oneLine.slice(0, 177)}…` : oneLine;
}

export async function uploadAttachment(
  file: File,
  { teamId, sessionId }: { teamId: string; sessionId: string },
): Promise<UploadedAttachment> {
  const toUpload = file.type.startsWith("image/")
    ? await compressImageForUpload(file)
    : file;
  return getBackend().attachments.uploadAttachment({
    file: toUpload,
    teamId,
    sessionId,
  });
}
