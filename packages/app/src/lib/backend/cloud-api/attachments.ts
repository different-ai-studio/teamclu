import type { AttachmentRef, AttachmentsBackend, AttachmentUploadInput } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";
import {
  attachmentStorageContentType,
  safeObjectName,
} from "@/lib/attachments/storage-object-key";

export function createAttachmentsModule(client: CloudApiClient): AttachmentsBackend {
  return {
    async uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef> {
      const attachmentId = crypto.randomUUID();
      // The object key cannot carry the display name. Storage 1.54.1 rejects
      // non-ASCII keys with InvalidKey, which surfaced as "Failed to upload
      // attachment — message not sent". `fileName` below stays the original.
      const storagePath = `${input.teamId}/${input.sessionId}/${attachmentId}/${safeObjectName(input.file.name)}`;
      const bytes: BodyInit = await input.file.arrayBuffer();
      const out = await client.postRaw<{
        path: string;
        url?: string;
        signedUrl?: string;
        attachmentId?: string;
        fileName?: string;
        mimeType?: string;
        size?: number;
      }>(
        `/v1/attachments?path=${encodeURIComponent(storagePath)}`,
        bytes,
        { contentType: attachmentStorageContentType(input.file.type) },
      );
      const signedUrl = out.url ?? out.signedUrl;
      if (!signedUrl) {
        throw new Error("Attachment upload succeeded but returned no URL");
      }
      return {
        attachmentId: out.attachmentId ?? attachmentId,
        fileName: out.fileName ?? input.file.name,
        signedUrl,
        mimeType: out.mimeType ?? input.file.type,
        size: out.size ?? input.file.size,
      };
    },
    async downloadByStoragePath(storagePath: string) {
      const trimmed = storagePath.trim();
      if (!trimmed) {
        throw new Error("Missing attachment storage path");
      }
      const response = await client.getRaw(
        `/v1/attachments/${encodeURIComponent(trimmed)}`,
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      return { bytes, contentType };
    },
  };
}
