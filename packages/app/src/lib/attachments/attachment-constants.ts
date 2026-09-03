/** Max size for non-image attachments uploaded to cloud storage. */
const MAX_NON_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function exceedsNonImageLimit(file: File): boolean {
  return exceedsNonImageLimitBySize(file.name, file.size);
}

export function exceedsNonImageLimitBySize(name: string, size: number): boolean {
  if (isImageFileName(name)) return false;
  return size > MAX_NON_IMAGE_ATTACHMENT_BYTES;
}

export function isImageFileName(name: string): boolean {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(name)) return true;
  return false;
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return isImageFileName(file.name);
}
