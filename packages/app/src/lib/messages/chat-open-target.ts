import { dirnameOf, isPathAtOrUnder, joinPathLike } from "@/lib/fs-path";

/** Never hand these to the default-app opener — that would execute them. */
const EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "msi",
  "ps1",
  "app",
  "command",
  "sh",
  "bash",
  "scr",
]);

export type ParsedChatTarget =
  | { kind: "web"; url: string }
  | { kind: "path"; input: string }
  | { kind: "ignore" };

export type SidebarPreviewKind = "md" | "html";

export function chatFileExtension(name: string): string {
  const trimmed = name.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const file = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return "";
  return file.slice(dot + 1).toLowerCase();
}

export function sidebarPreviewKind(name: string): SidebarPreviewKind | null {
  const ext = chatFileExtension(name);
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

export function supportsSidebarPreview(name: string): boolean {
  return sidebarPreviewKind(name) !== null;
}

export function isExecutableChatFile(name: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(chatFileExtension(name));
}

function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/** `file:///C:/a` → `C:/a`, `file:///Users/a` → `/Users/a`. */
export function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path || null;
  } catch {
    return null;
  }
}

export function isAbsoluteChatPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isRelativeChatPath(value: string): boolean {
  return /^\.\.?([\\/]|$)/.test(value);
}

export function parseChatTarget(raw: string): ParsedChatTarget {
  const value = raw.trim();
  if (!value) return { kind: "ignore" };
  if (isWebUrl(value)) return { kind: "web", url: value };
  if (value.toLowerCase().startsWith("file:")) {
    return fileUrlToPath(value) ? { kind: "path", input: value } : { kind: "ignore" };
  }
  if (value.startsWith("//")) return { kind: "ignore" };
  if (isAbsoluteChatPath(value) || isRelativeChatPath(value)) {
    return { kind: "path", input: value };
  }
  return { kind: "ignore" };
}

export function looksLikeLocalChatPath(value: string): boolean {
  return parseChatTarget(value).kind === "path";
}

function joinRelativePath(root: string, rel: string): string {
  let current = root;
  for (const piece of rel.split(/[/\\]+/)) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      const parent = dirnameOf(current);
      current = parent || current;
      continue;
    }
    current = joinPathLike(current, piece);
  }
  return current;
}

/**
 * Resolve a message path against the session roots.
 * Relative paths try each root. Absolute paths must already sit under one.
 * Returns null when the path would leave those roots.
 */
export function resolveChatPath(input: string, roots: readonly string[]): string | null {
  const cleaned = input.trim();
  const fromFileUrl = cleaned.toLowerCase().startsWith("file:") ? fileUrlToPath(cleaned) : null;
  const path = fromFileUrl ?? cleaned;
  if (!path) return null;

  const usable = roots.map((root) => root.trim()).filter(Boolean);
  if (isAbsoluteChatPath(path)) {
    return usable.some((root) => isPathAtOrUnder(path, root)) ? path : null;
  }
  if (!isRelativeChatPath(path)) return null;

  for (const root of usable) {
    const joined = joinRelativePath(root, path);
    if (isPathAtOrUnder(joined, root)) return joined;
  }
  return null;
}
