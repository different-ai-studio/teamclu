import i18n from "@/lib/i18n";
import { isTauri, openExternalUrl } from "@/lib/utils";
import { toast } from "sonner";
import { basenameOf, isPathAtOrUnder, joinPathLike } from "@/lib/fs-path";
import {
  isExecutableChatFile,
  parseChatTarget,
  resolveChatPath,
  sidebarPreviewKind,
  supportsSidebarPreview,
} from "@/lib/messages/chat-open-target";
import { useChatFilePreviewStore } from "@/stores/chat-file-preview-store";
import { useWorkspaceStore } from "@/stores/workspace";
import { useSessionStore } from "@/stores/session-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import {
  attachmentPathExists,
  getCachedAttachmentPath,
  normalizeAttachmentUrlKey,
  setCachedAttachmentPath,
} from "@/lib/attachments/attachment-download-index";
import { fetchAgentReplyAttachmentBytes } from "@/lib/attachments/download-remote-attachment";
import { openWithDefaultApp, revealInFileManager } from "@/components/workspace/file-tree-operations";

export type ChatOpenIntent = "primary" | "sidebar" | "default-app";

export type ChatAttachmentTarget = {
  filename: string;
  url?: string;
  bucketPath?: string;
  localPath?: string;
};

function notify(key: string, fallback: string) {
  toast.error(i18n.t(key, fallback));
}

/** Workspace first, then this session's live worktree when it differs. */
export function currentChatRoots(): string[] {
  const roots: string[] = [];
  const workspace = useWorkspaceStore.getState().workspacePath?.trim();
  if (workspace) roots.push(workspace);

  const sessionId = useSessionStore.getState().activeSessionId;
  if (!sessionId) return roots;
  const suffix = `::${sessionId}`;
  for (const [key, entry] of Object.entries(useRuntimeStateStore.getState().byRuntimeId)) {
    const matches = key.endsWith(suffix) || entry.info.runtimeId === sessionId;
    const worktree = entry.info.worktree?.trim();
    if (matches && worktree && !roots.includes(worktree)) roots.push(worktree);
  }
  return roots;
}

async function pathExists(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  return attachmentPathExists(path);
}

function rememberPreview(id: string, name: string, path?: string, text?: string) {
  const kind = sidebarPreviewKind(name);
  if (!kind) return;
  useChatFilePreviewStore.getState().openTab({ id, name, kind, path, text });
}

async function openTrustedFile(path: string, name: string, intent: ChatOpenIntent, text?: string) {
  const sidebar = supportsSidebarPreview(name);
  if (intent === "sidebar" || (intent === "primary" && sidebar)) {
    if (!sidebar) {
      notify("chat.fileOpen.sidebarUnsupported", "这个文件不能在侧边栏里打开");
      return;
    }
    let body = text;
    if (body == null && path && isTauri()) {
      try {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        body = await readTextFile(path);
      } catch (error) {
        console.error("[openChatFile] read failed", error);
        notify("chat.fileOpen.readFailed", "读不到这个文件");
        return;
      }
    }
    rememberPreview(path || name, name, path, body);
    return;
  }

  if (isExecutableChatFile(name) || isExecutableChatFile(path)) {
    if (isTauri()) await revealInFileManager(path);
    notify("chat.fileOpen.executableBlocked", "程序文件不会直接运行，已在文件夹中显示");
    return;
  }

  if (!isTauri()) {
    notify("chat.fileOpen.desktopOnly", "在桌面端才能用系统程序打开");
    return;
  }
  await openWithDefaultApp(path);
}

async function openLocalPath(input: string, intent: ChatOpenIntent) {
  if (!isTauri()) {
    notify("chat.fileOpen.desktopOnly", "在桌面端才能用系统程序打开");
    return;
  }
  const absolute = resolveChatPath(input, currentChatRoots());
  if (!absolute) {
    notify("chat.fileOpen.outsideWorkspace", "这个路径不在当前会话的目录里");
    return;
  }
  if (!(await pathExists(absolute))) {
    notify("chat.fileOpen.notFound", "找不到这个文件");
    return;
  }
  await openTrustedFile(absolute, basenameOf(absolute) || absolute, intent);
}

function cacheFileName(filename: string, key: string): string {
  const safe = filename.trim().replace(/[/\\?%*:|"<>]/g, "_") || "attachment";
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const stamp = hash.toString(16);
  const dot = safe.lastIndexOf(".");
  if (dot > 0) return `${safe.slice(0, dot)}-${stamp}${safe.slice(dot)}`;
  return `${safe}-${stamp}`;
}

function cacheKeyFor(target: ChatAttachmentTarget): string {
  if (target.bucketPath?.trim()) return `bucket:${target.bucketPath.trim()}`;
  if (target.url?.trim()) return normalizeAttachmentUrlKey(target.url.trim());
  return `name:${target.filename}`;
}

/** `{workspace}/output`. The open workspace is already in the webview fs scope. */
function workspaceOutputDir(): string | null {
  const workspace = useWorkspaceStore.getState().workspacePath?.trim();
  if (!workspace) return null;
  return joinPathLike(workspace, "output");
}

async function writeCache(filename: string, bytes: Uint8Array, key: string): Promise<string | null> {
  if (!isTauri()) return null;
  const dir = workspaceOutputDir();
  if (!dir) {
    notify("chat.fileOpen.noWorkspace", "没有当前工作目录，无法保存文件");
    return null;
  }
  try {
    const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
    await mkdir(dir, { recursive: true });
    const safe = cacheFileName(filename, key);
    const dest = joinPathLike(dir, safe);
    await writeFile(dest, bytes);
    setCachedAttachmentPath(key, dest, safe);
    return dest;
  } catch (error) {
    console.error("[openChatFile] cache write failed", error);
    notify("chat.attachment.downloadFailed", "下载失败");
    return null;
  }
}

async function loadAttachmentBytes(target: ChatAttachmentTarget): Promise<Uint8Array> {
  if (target.bucketPath?.trim() || target.url?.trim()) {
    const loaded = await fetchAgentReplyAttachmentBytes({
      filename: target.filename,
      mime: "",
      size: 0,
      url: target.url ?? "",
      bucketPath: target.bucketPath,
      isImage: false,
    });
    return loaded.bytes;
  }
  throw new Error("Attachment has no URL or storage path");
}

/** Left click, or a choice from the right-click menu, for a link or path. */
export async function openChatHref(href: string, intent: ChatOpenIntent = "primary"): Promise<void> {
  const parsed = parseChatTarget(href);
  if (parsed.kind === "ignore") return;
  if (parsed.kind === "web") {
    if (intent === "sidebar") {
      notify("chat.fileOpen.sidebarUnsupported", "这个文件不能在侧边栏里打开");
      return;
    }
    await openExternalUrl(parsed.url);
    return;
  }
  await openLocalPath(parsed.input, intent);
}

/** Left click, or a menu choice, for a chat attachment chip. */
export async function openChatAttachment(
  target: ChatAttachmentTarget,
  intent: ChatOpenIntent = "primary",
): Promise<void> {
  const filename = target.filename.trim() || "attachment";
  if (!target.url?.trim() && !target.bucketPath?.trim()) {
    notify("chat.attachment.downloadFailed", "下载失败");
    return;
  }

  const key = cacheKeyFor(target);
  const outputDir = workspaceOutputDir();
  const cached = getCachedAttachmentPath(key);
  if (outputDir && cached && isPathAtOrUnder(cached, outputDir) && (await pathExists(cached))) {
    await openTrustedFile(cached, filename, intent);
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await loadAttachmentBytes(target);
  } catch (error) {
    console.error("[openChatFile] download failed", error);
    notify("chat.attachment.downloadFailed", "下载失败");
    return;
  }

  const sidebar = supportsSidebarPreview(filename);
  if (!isTauri()) {
    if (intent === "sidebar" || (intent === "primary" && sidebar)) {
      const text = new TextDecoder().decode(bytes);
      rememberPreview(key, filename, undefined, text);
      return;
    }
    const blob = new Blob([Uint8Array.from(bytes)]);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return;
  }

  const dest = await writeCache(filename, bytes, key);
  if (!dest) return;
  await openTrustedFile(dest, filename, intent);
}

/** A tab we already accepted. Skips the workspace jail. */
export async function openPreviewTabFile(
  path: string | undefined,
  name: string,
  intent: ChatOpenIntent,
): Promise<void> {
  if (intent === "sidebar" || intent === "primary") {
    const tab = useChatFilePreviewStore.getState().tabs.find((item) => item.path === path || item.name === name);
    if (tab) {
      useChatFilePreviewStore.getState().setActive(tab.id);
      return;
    }
  }
  if (!path) {
    notify("chat.fileOpen.desktopOnly", "在桌面端才能用系统程序打开");
    return;
  }
  await openTrustedFile(path, name, intent === "primary" ? "default-app" : intent);
}
