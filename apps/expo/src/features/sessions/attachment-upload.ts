import { Buffer } from "buffer";
import * as FileSystem from "expo-file-system";

import { cloudApiBaseUrl } from "../../lib/cloud-api/client";
import { uuidV4 } from "../../lib/uuid";

export type UploadedAttachment = {
  path: string;
  publicUrl: string;
  mime: string;
  size: number | null;
};

type LocalFileBody = {
  body: ArrayBuffer;
  mime: string;
  size: number | null;
};

function inferMime(uri: string, fallback: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".caf")) return "audio/x-caf";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return fallback;
}

function inferExtension(uri: string, mime: string): string {
  const fromUri = uri.split(".").pop()?.toLowerCase();
  if (fromUri && fromUri.length >= 2 && fromUri.length <= 5 && /^[a-z0-9]+$/.test(fromUri)) {
    return fromUri;
  }
  if (mime.startsWith("image/")) return mime.split("/")[1] ?? "bin";
  if (mime.startsWith("video/")) return mime.split("/")[1] ?? "mp4";
  if (mime.startsWith("audio/")) return "m4a";
  if (mime === "application/pdf") return "pdf";
  return "bin";
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readLocalFileForUpload(uri: string, fallbackMime: string): Promise<LocalFileBody> {
  try {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Couldn't read picked file (${response.status}).`);
    }
    const blob = await response.blob();
    const body = await blob.arrayBuffer();
    return {
      body,
      mime: blob.type || fallbackMime,
      size: blob.size ?? body.byteLength,
    };
  } catch (fetchError) {
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = Buffer.from(base64, "base64");
      return {
        body: copyToArrayBuffer(bytes),
        mime: fallbackMime,
        size: bytes.byteLength,
      };
    } catch {
      throw fetchError;
    }
  }
}

type CloudUploadOptions = {
  getAccessToken: () => Promise<string | null>;
  path: string;
  bucket: string;
  body: ArrayBuffer;
  mime: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** POST raw bytes to `/v1/attachments?path=&bucket=`. The attachments/avatars
 * buckets are public, so FC returns the public object URL directly. */
async function postBytesToCloud(opts: CloudUploadOptions): Promise<{ path: string; url: string }> {
  const token = await opts.getAccessToken();
  if (!token) throw new Error("Missing auth session access token.");
  const baseUrl = (opts.baseUrl ?? cloudApiBaseUrl()).replace(/\/+$/, "");
  const uploadFetch = opts.fetchImpl ?? fetch;
  const query = new URLSearchParams({ path: opts.path, bucket: opts.bucket });

  const response = await uploadFetch(`${baseUrl}/v1/attachments?${query.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": opts.mime,
    },
    body: opts.body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Couldn't upload the file.");
  }
  return { path: opts.path, url: payload?.url ?? "" };
}

/**
 * Reads the file behind `localUri` and uploads it to the Cloud API
 * (`POST /v1/attachments?path=<path>&bucket=<bucket>`, raw bytes) under
 * `<teamId>/<sessionId>/<uuid>.<ext>`. The path convention matches the iOS
 * app's `AttachmentUploadManager.makeRemotePath` so the same row in
 * `message_attachments` can be read interchangeably.
 *
 * Returns the storage path, the public object URL, the resolved MIME, and the
 * size when available.
 */
export async function uploadAttachment(args: {
  getAccessToken: () => Promise<string | null>;
  teamId: string;
  sessionId: string;
  localUri: string;
  fallbackMime?: string;
  bucket?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedAttachment> {
  const fallbackMime = inferMime(args.localUri, args.fallbackMime ?? "application/octet-stream");
  const { body, mime, size } = await readLocalFileForUpload(args.localUri, fallbackMime);
  const ext = inferExtension(args.localUri, mime);
  const path = `${args.teamId}/${args.sessionId}/${uuidV4()}.${ext}`;

  const { url } = await postBytesToCloud({
    getAccessToken: args.getAccessToken,
    path,
    bucket: args.bucket ?? "attachments",
    body,
    mime,
    baseUrl: args.baseUrl,
    fetchImpl: args.fetchImpl,
  });

  return { path, publicUrl: url, mime, size };
}

/** Base64 image bytes, with or without a `data:<mime>;base64,` prefix. */
export function decodePastedImage(
  data: string,
  fallbackMime: string,
): { bytes: Uint8Array; mime: string } {
  const match = /^data:([^;,]+);base64,/i.exec(data);
  const mime = match?.[1] ?? fallbackMime;
  const bytes = Buffer.from(match ? data.slice(match[0].length) : data, "base64");
  return { bytes: new Uint8Array(bytes), mime };
}

/**
 * Uploads an image pasted from the clipboard (iOS #1709): the same bucket and
 * path convention as a picked photo, straight from the pasted bytes.
 */
export async function uploadPastedImage(args: {
  getAccessToken: () => Promise<string | null>;
  teamId: string;
  sessionId: string;
  /** What the clipboard handed over (base64, possibly a data URI). */
  data: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedAttachment> {
  const { bytes, mime } = decodePastedImage(args.data, "image/jpeg");
  if (bytes.byteLength === 0) throw new Error("The clipboard image is empty.");
  const ext = mime === "image/png" ? "png" : "jpg";
  const path = `${args.teamId}/${args.sessionId}/${uuidV4()}.${ext}`;
  const { url } = await postBytesToCloud({
    getAccessToken: args.getAccessToken,
    path,
    bucket: "attachments",
    body: copyToArrayBuffer(bytes),
    mime,
    baseUrl: args.baseUrl,
    fetchImpl: args.fetchImpl,
  });
  return { path, publicUrl: url, mime, size: bytes.byteLength };
}

/**
 * Reads the image behind `localUri` and uploads it to the public `avatars`
 * bucket under `<actorId>/<uuid>.<ext>` (mirrors iOS `uploadAvatar`). Returns
 * the public URL to persist on the actor row.
 */
export async function uploadAvatar(args: {
  getAccessToken: () => Promise<string | null>;
  actorId: string;
  localUri: string;
  fallbackMime?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fallbackMime = inferMime(args.localUri, args.fallbackMime ?? "image/jpeg");
  const { body, mime } = await readLocalFileForUpload(args.localUri, fallbackMime);
  const ext = inferExtension(args.localUri, mime);
  const path = `${args.actorId}/${uuidV4()}.${ext}`;

  const { url } = await postBytesToCloud({
    getAccessToken: args.getAccessToken,
    path,
    bucket: "avatars",
    body,
    mime,
    baseUrl: args.baseUrl,
    fetchImpl: args.fetchImpl,
  });
  return url;
}
