import i18n from "@/lib/i18n";
import { isTauri, openExternalUrl } from "@/lib/utils";
import { toast } from "sonner";
import { allowFsScopeDirs } from "@/lib/fs-scope";
import { basenameOf, dirnameOf, isPathAtOrUnder, joinPathLike } from "@/lib/fs-path";
import {
  isExecutableChatFile,
  parseChatTarget,
  resolveChatPath,
  sidebarPreviewKind,
  supportsSidebarPreview,
} from "@/lib/messages/chat-open-target";
import { openPreviewTab, previewTabSource } from "@/lib/tabs/preview-tabs";
import { useTabsStore } from "@/stores/tabs";
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

/** Show the file in the content column, as a tab of the open session. */
function rememberPreview(id: string, name: string, path?: string, text?: string) {
  const kind = sidebarPreviewKind(name);
  if (!kind) return;
  openPreviewTab(id, { name, kind, path, text });
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

/**
 * A real file on this machine that the file tree can open: under the
 * workspace, or under an external root it shows (team knowledge). Those open
 * in the same editor the file tree uses, so one file does not have two ways
 * of opening. A downloaded attachment copy is never routed here, even though
 * it sits in `{workspace}/output`: it is a copy, and edits would go nowhere.
 */
function openableInFileEditor(path: string): boolean {
  const { workspacePath, externalTrees } = useWorkspaceStore.getState();
  const roots = [workspacePath?.trim(), ...Object.keys(externalTrees)].filter(
    (root): root is string => !!root,
  );
  return roots.some((root) => isPathAtOrUnder(path, root));
}

/** Opens `absolute` in the file editor when it qualifies; says whether it did. */
function openInFileEditorIfLocal(absolute: string, name: string, intent: ChatOpenIntent): boolean {
  if (intent !== "primary" && intent !== "sidebar") return false;
  if (!supportsSidebarPreview(name) || !openableInFileEditor(absolute)) return false;
  void useWorkspaceStore.getState().selectFile(absolute);
  return true;
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
  const name = basenameOf(absolute) || absolute;
  if (openInFileEditorIfLocal(absolute, name, intent)) return;
  await openTrustedFile(absolute, name, intent);
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

function hasRemoteAttachment(target: ChatAttachmentTarget): boolean {
  return Boolean(target.url?.trim() || target.bucketPath?.trim());
}

async function loadOrNotify(target: ChatAttachmentTarget): Promise<Uint8Array | null> {
  try {
    return await loadAttachmentBytes(target);
  } catch (error) {
    console.error("[openChatFile] download failed", error);
    notify("chat.attachment.downloadFailed", "下载失败");
    return null;
  }
}

function saveBrowserDownload(bytes: Uint8Array, filename: string) {
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
}

/** A copy we already saved, including one the user picked in the save dialog. */
export async function downloadedChatAttachmentPath(
  target: ChatAttachmentTarget,
): Promise<string | null> {
  if (!hasRemoteAttachment(target)) return null;
  const cached = getCachedAttachmentPath(cacheKeyFor(target));
  if (!cached) return null;
  const parent = dirnameOf(cached);
  if (parent) await allowFsScopeDirs([parent]);
  return (await pathExists(cached)) ? cached : null;
}

async function promptDownloadPath(filename: string): Promise<string | null> {
  const safe = filename.trim().replace(/[/\\?%*:|"<>]/g, "_") || "attachment";
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 ? safe.slice(dot + 1).toLowerCase() : "";
  const [{ safeSaveDialog }, { downloadDir }] = await Promise.all([
    import("@/lib/workspace/safe-save-dialog"),
    import("@tauri-apps/api/path"),
  ]);
  const downloads = await downloadDir();
  return safeSaveDialog({
    title: i18n.t("chat.attachment.saveAttachment", "保存附件"),
    defaultPath: joinPathLike(downloads, safe),
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
}

/** Ask where to save, defaulting to the user's Downloads folder. Remembers the path. */
export async function downloadChatAttachment(target: ChatAttachmentTarget): Promise<void> {
  const filename = target.filename.trim() || "attachment";
  if (!hasRemoteAttachment(target)) {
    notify("chat.attachment.downloadFailed", "下载失败");
    return;
  }
  if (await downloadedChatAttachmentPath(target)) return;
  if (!isTauri()) {
    const bytes = await loadOrNotify(target);
    if (bytes) saveBrowserDownload(bytes, filename);
    return;
  }
  let dest: string | null;
  try {
    dest = await promptDownloadPath(filename);
  } catch (error) {
    console.error("[openChatFile] save dialog failed", error);
    notify("chat.attachment.downloadFailed", "下载失败");
    return;
  }
  if (!dest) return;
  const bytes = await loadOrNotify(target);
  if (!bytes) return;
  try {
    const parent = dirnameOf(dest);
    if (parent) await allowFsScopeDirs([parent]);
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(dest, bytes);
    setCachedAttachmentPath(cacheKeyFor(target), dest, filename);
  } catch (error) {
    console.error("[openChatFile] save failed", error);
    notify("chat.attachment.downloadFailed", "下载失败");
  }
}

/** Show the already downloaded copy in the file manager. */
export async function revealDownloadedChatAttachment(target: ChatAttachmentTarget): Promise<void> {
  const path = await downloadedChatAttachmentPath(target);
  if (!path) {
    notify("chat.fileOpen.notFound", "找不到这个文件");
    return;
  }
  if (!isTauri()) {
    notify("chat.fileOpen.desktopOnly", "在桌面端才能用系统程序打开");
    return;
  }
  await revealInFileManager(path);
}

/** Left click, or a menu choice, for a chat attachment chip. */
export async function openChatAttachment(
  target: ChatAttachmentTarget,
  intent: ChatOpenIntent = "primary",
): Promise<void> {
  const filename = target.filename.trim() || "attachment";
  if (!hasRemoteAttachment(target)) {
    const local = target.localPath?.trim();
    if (local) {
      await openLocalPath(local, intent);
      return;
    }
    notify("chat.attachment.downloadFailed", "下载失败");
    return;
  }

  // The agent's own file, when it is on this machine: `local_path` is a path
  // on the agent's host, so it only counts when it resolves inside this
  // workspace and exists here. Then it opens in the editor like the file tree
  // does, rather than as a read-only preview of the uploaded copy.
  const local = target.localPath?.trim();
  if (local && isTauri()) {
    const absolute = resolveChatPath(local, currentChatRoots());
    if (
      absolute &&
      supportsSidebarPreview(filename) &&
      openableInFileEditor(absolute) &&
      (await pathExists(absolute)) &&
      openInFileEditorIfLocal(absolute, filename, intent)
    ) {
      return;
    }
  }

  const key = cacheKeyFor(target);
  const cached = await downloadedChatAttachmentPath(target);
  if (cached) {
    await openTrustedFile(cached, filename, intent);
    return;
  }

  const bytes = await loadOrNotify(target);
  if (!bytes) return;

  const sidebar = supportsSidebarPreview(filename);
  if (!isTauri()) {
    if (intent === "sidebar" || (intent === "primary" && sidebar)) {
      rememberPreview(key, filename, undefined, new TextDecoder().decode(bytes));
      return;
    }
    saveBrowserDownload(bytes, filename);
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
    const tabs = useTabsStore.getState();
    const tab = tabs.tabs.find((item) => {
      if (item.type !== "preview") return false;
      const source = previewTabSource(item.target);
      return source ? source.path === path || source.name === name : false;
    });
    if (tab) {
      tabs.setActiveTab(tab.id);
      return;
    }
  }
  if (!path) {
    notify("chat.fileOpen.desktopOnly", "在桌面端才能用系统程序打开");
    return;
  }
  await openTrustedFile(path, name, intent === "primary" ? "default-app" : intent);
}
