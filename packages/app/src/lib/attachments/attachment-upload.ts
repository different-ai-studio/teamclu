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
