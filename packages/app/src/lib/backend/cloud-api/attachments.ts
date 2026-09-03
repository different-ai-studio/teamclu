import type { AttachmentRef, AttachmentsBackend, AttachmentUploadInput } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createAttachmentsModule(client: CloudApiClient): AttachmentsBackend {
  return {
    async uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef> {
      const attachmentId = crypto.randomUUID();
      const storagePath = `${input.teamId}/${input.sessionId}/${attachmentId}/${input.file.name}`;
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
        { contentType: input.file.type },
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
  };
}
