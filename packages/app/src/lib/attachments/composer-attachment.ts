/** A file waiting in the composer. Cloud files upload on send. Local files stay on disk. */

export interface LocalPathAttachment {
  name: string;
  size: number;
  path: string;
}

export type ComposerAttachment =
  | { kind: "cloud"; file: File }
  | ({ kind: "local" } & LocalPathAttachment);

export function composerAttachmentName(item: ComposerAttachment): string {
  return item.kind === "cloud" ? item.file.name : item.name;
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Message token for a file that never left this machine. */
export function localAttachmentToken(name: string, path: string): string {
  return `[Attachment: ${name}] (path: ${path})`;
}
