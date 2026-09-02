import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  Loader2,
  Save,
  GitCompare,
  Code,
  Image,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Files,
  Eye,
  History,
} from "lucide-react";
import { cn, isTauri } from "@/lib/utils";
import {
  globalTeamKnowledgeShareDir,
  teamSyncKeyForPath,
} from "@/lib/team-skill-paths";
import { getEditorType } from "@/components/editors/utils";
import { UNSUPPORTED_BINARY_EXTENSIONS } from "@/components/viewers/UnsupportedFileViewer";
import { supportsPreview } from "@/components/editors/utils";
import { useAutoSave } from "@/components/editors/useAutoSave";
import { ConflictBanner } from "@/components/editors/ConflictBanner";
import { sendAgentPromptInActiveSession } from "@/lib/session-send-agent";
import { useWorkspaceStore } from "@/stores/workspace";
import { useCurrentTeamStore } from '@/stores/current-team'
import { OssHistoryProvider } from '@/lib/history/oss-provider'
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Editors - lazy loaded per file type
const LazyMarkdownEditor = lazy(
  () => import("@/components/editors/MarkdownEditor"),
);
const LazyCodeEditor = lazy(() => import("@/components/editors/CodeEditor"));
const LazyDiffRenderer = lazy(() => import("@/components/diff/DiffRenderer"));
const LazyFileHistoryView = lazy(() => import("@/components/history/FileHistoryView"));

// Viewers - lazy loaded
const LazyPDFViewer = lazy(
  () => import("@/components/viewers/PDFViewer"),
);
const LazyUnsupportedFileViewer = lazy(
  () => import("@/components/viewers/UnsupportedFileViewer"),
);

// Helper to detect file type
export function getFileType(
  filename: string,
): "image" | "pdf" | "binary" | "text" {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const imageExtensions = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "ico",
    "svg",
  ];
  if (imageExtensions.includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) return "binary";
  return "text";
}

// Image Viewer component
function ImageViewer({
  content,
  filename,
  filePath,
}: {
  content: string;
  filename: string;
  filePath: string;
}) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const isSvg = filename.toLowerCase().endsWith(".svg");
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 300));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 25));
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);
  const handleReset = () => {
    setZoom(100);
    setRotation(0);
  };

  const displayPath =
    workspacePath && filePath.startsWith(workspacePath + "/")
      ? filePath.slice(workspacePath.length + 1)
      : filePath;

  return (
    <div className="flex flex-col h-full" data-testid="file-editor">
      {/* Header - simple and clean */}
      <div className="flex items-center h-10 px-3 border-b bg-muted/30 shrink-0 gap-3">
        {/* Full file path */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Image className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{displayPath}</span>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleZoomOut}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground w-10 text-center">
            {zoom}%
          </span>
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleZoomIn}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            className="p-1.5 rounded hover:bg-muted text-muted-foreground"
            onClick={handleRotate}
          >
            <RotateCw className="h-4 w-4" />
          </button>
          <button
            className="px-2 py-1 rounded hover:bg-muted text-xs text-muted-foreground"
            onClick={handleReset}
          >
            {t("app.reset", "Reset")}
          </button>
        </div>
      </div>

      {/* Image container */}
      <div className="flex-1 overflow-auto bg-muted/20 flex items-center justify-center p-4">
        <div
          className="rounded-lg p-2"
          style={{
            backgroundColor: "#ffffff",
            backgroundImage:
              "linear-gradient(45deg, #f1f5f9 25%, transparent 25%), linear-gradient(-45deg, #f1f5f9 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f1f5f9 75%), linear-gradient(-45deg, transparent 75%, #f1f5f9 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
          }}
        >
          {isSvg ? (
            <iframe
              src={content}
              title={filename}
              sandbox=""
              className="max-w-full max-h-full min-h-[60vh] min-w-[60vw] border-0 bg-transparent transition-transform duration-200"
              style={{
                transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
              }}
            />
          ) : (
            <img
              src={content}
              alt={filename}
              className="max-w-full max-h-full object-contain transition-transform duration-200"
              style={{
                transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// File Content Viewer for File Mode - shows file editor or empty state
export function FileContentViewer({
  selectedFile,
  fileContent,
  isLoadingFile,
  onClose,
}: {
  selectedFile: string | null;
  fileContent: string | null;
  isLoadingFile: boolean;
  onClose: () => void;
}) {
  const reloadSelectedFile = useWorkspaceStore((s) => s.reloadSelectedFile);
  const { t } = useTranslation();
  const filename = selectedFile?.split("/").pop() || "";
  const fileType = getFileType(filename);
  const isFileOpen = !!selectedFile;

  // Listen for file changes and reload when the current file is modified
  useEffect(() => {
    if (!isTauri() || !selectedFile) return;

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");

        unlisten = await listen<{ paths: string[]; directories: string[] }>(
          "file-change-batch",
          (event) => {
            // Normalize paths for comparison
            const normalizedSelected = selectedFile.replace(/^\/+|\/+$/g, "");
            // One event per watcher window; reload if any path in it is our file.
            const touched = event.payload.paths.some((changedPath) => {
              const normalizedChanged = changedPath.replace(/^\/+|\/+$/g, "");
              return (
                normalizedSelected === normalizedChanged ||
                normalizedSelected.endsWith("/" + normalizedChanged) ||
                normalizedChanged.endsWith("/" + normalizedSelected)
              );
            });

            if (touched) {
              console.log(
                "[FileContentViewer] Current file changed, reloading:",
                selectedFile,
              );
              reloadSelectedFile();
            }
          },
        );
      } catch (error) {
        console.error(
          "[FileContentViewer] Failed to setup file change listener:",
          error,
        );
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [selectedFile, reloadSelectedFile]);

  if (!isFileOpen) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Files className="h-16 w-16 mb-4 opacity-30" />
        <p className="text-sm">
          {t("app.selectFile", "Select a file from the explorer")}
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          {t("app.clickFileToView", "Click on a file to view its contents")}
        </p>
      </div>
    );
  }

  if (isLoadingFile) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fileContent === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <FileText className="h-12 w-12 mb-3 opacity-50" />
        <p className="text-sm">
          {t("app.unableToLoadFile", "Unable to load file content")}
        </p>
        <Button variant="ghost" size="sm" onClick={onClose} className="mt-2">
          {t("common.close", "Close")}
        </Button>
      </div>
    );
  }

  // Render appropriate viewer based on file type
  if (fileType === "image") {
    return (
      <ImageViewer
        content={fileContent}
        filename={filename}
        filePath={selectedFile!}
      />
    );
  }

  if (fileType === "pdf") {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <LazyPDFViewer
          content={fileContent}
          filename={filename}
          filePath={selectedFile!}
        />
      </Suspense>
    );
  }

  if (fileType === "binary") {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <LazyUnsupportedFileViewer
          filename={filename}
          filePath={selectedFile!}
        />
      </Suspense>
    );
  }

  return (
    <FileEditor
      content={fileContent}
      filename={filename}
      filePath={selectedFile}
      onClose={onClose}
    />
  );
}

// File Editor component - routes to appropriate editor based on file type
export function FileEditor({
  content,
  filename,
  filePath,
  onClose,
}: {
  content: string;
  filename: string;
  filePath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const targetLine = useWorkspaceStore((s) => s.targetLine);
  const targetHeading = useWorkspaceStore((s) => s.targetHeading);
  const [currentContent, setCurrentContent] = useState(content);
  const [isModified, setIsModified] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPreview, setShowPreview] = useState(supportsPreview(filename) === "html");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [externalUpdateType, setExternalUpdateType] = useState<
    "updated" | "changed_externally" | null
  >(null);
  const previousContentRef = useRef(content);

  // --- Markdown auto-save & conflict state ---
  const isMarkdown = supportsPreview(filename) === "markdown";
  const markdownEditorRef = useRef<import("@/components/editors/MarkdownEditor").MarkdownEditorHandle>(null);

  // Conflict state for markdown files
  const [conflictAgentContent, setConflictAgentContent] = useState<string | null>(null);
  const [showConflictDiff, setShowConflictDiff] = useState(false);

  // Auto-save hook (only active for markdown files)
  const { saveStatus, isSelfWrite, saveNow, cancelPendingSave } = useAutoSave({
    filePath,
    content: currentContent,
    isModified: isMarkdown ? isModified : false,
    enabled: isMarkdown,
  });

  // Git HEAD content for git gutter decorations
  const [gitHeadContent, setGitHeadContent] = useState<string | null>(null);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const displayPath =
    workspacePath && filePath && filePath.startsWith(workspacePath + "/")
      ? filePath.slice(workspacePath.length + 1)
      : (filePath ?? "");

  // The team's real knowledge dir (`~/.amuxd[-<brand>]/teams/<id>/shared/
  // knowledge`) — the directory the OSS sync engine owns, resolved by absolute
  // path rather than through any workspace link.
  const [syncRoot, setKnowledgeDir] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    globalTeamKnowledgeShareDir()
      .then((dir) => { if (!cancelled) setKnowledgeDir(dir) })
      .catch(() => { if (!cancelled) setKnowledgeDir(null) })
    return () => { cancelled = true }
  }, [])

  // The key sync addresses this file by (`knowledge/<rel>`), null when the file
  // is not team-synced content. Files opened from the Knowledge column carry the
  // real absolute path; files opened from the workspace panel come in under the
  // `team-knowledge` symlink. Both map to the same key, so the same document has
  // the same history whichever surface opened it.
  const teamSyncKey = useMemo(
    () => (filePath ? teamSyncKeyForPath(filePath, { syncRoot, workspacePath }) : null),
    [filePath, syncRoot, workspacePath],
  )
  // Team content is exactly what sync carries. This used to be "anywhere under
  // `teamclu-team/`", which is a tree sync retired: it offered history on files
  // that have none, and offered none on knowledge documents, which are the only
  // files that do.
  const isTeamFile = !!teamSyncKey

  const historyProvider = useMemo(() => {
    if (!teamSyncKey) return null
    // `workspacePath` is passed through but never decides anything — the daemon
    // keys versions by team id + sync key. A knowledge document opened with no
    // folder open still has its history.
    return new OssHistoryProvider(workspacePath, teamSyncKey)
  }, [teamSyncKey, workspacePath])

  // Fetch the file's baseline content from the daemon for gutter decorations
  // (team files only). The daemon's `team_file_content(..., "baseline")` proxy
  // resolves to git HEAD in git mode and to the last-synced copy in oss mode,
  // so the gutter works for both team share modes.
  useEffect(() => {
    const teamId = useCurrentTeamStore.getState().team?.id;
    if (!isTauri() || !teamSyncKey || !teamId) {
      setGitHeadContent(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const res = await invoke<{ content: string | null }>("team_file_content", {
          teamId,
          path: teamSyncKey,
          ref: "baseline",
        });
        if (!cancelled) {
          setGitHeadContent(res.content);
        }
      } catch {
        if (!cancelled) {
          setGitHeadContent(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teamSyncKey]);

  // Check if this file supports preview
  const previewType = supportsPreview(filename);

  // Changes are measured against git HEAD; the per-session diff feed that used
  // to be consulted here never had a producer.
  const hasChanges = gitHeadContent !== null && gitHeadContent !== content;

  // Compute git-level +/- stats against HEAD
  const gitDiffStats = useMemo(() => {
    if (!gitHeadContent) return null;
    const oldLines = gitHeadContent.split("\n");
    const newLines = content.split("\n");
    // Simple line count diff
    let additions = 0;
    let deletions = 0;
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= oldLines.length) {
        additions++;
        continue;
      }
      if (i >= newLines.length) {
        deletions++;
        continue;
      }
      if (oldLines[i] !== newLines[i]) {
        additions++;
        deletions++;
      }
    }
    return { additions, deletions };
  }, [gitHeadContent, content]);

  // Detect dark mode
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Handle external content changes (e.g., file modified by agent)
  useEffect(() => {
    // Check if content prop changed externally
    if (content !== previousContentRef.current) {
      previousContentRef.current = content;

      if (isMarkdown) {
        // IMMEDIATELY cancel any pending auto-save to prevent it from
        // overwriting the incoming external content with stale editor state.
        // Auto-save will re-arm naturally when the user makes further edits.
        cancelPendingSave();

        // For markdown files: use auto-save aware flow
        // Check if this is our own auto-save write
        isSelfWrite(content).then((selfWrite) => {
          if (selfWrite) {
            // Our own auto-save write — DO NOT touch editor state.
            // The editor already has the correct (or newer) content.
            // Updating currentContent here would overwrite any
            // characters the user typed since the save fired.
            return;
          }

          // External change (agent or other)
          if (isModified) {
            // Conflict! User has unsaved changes
            setConflictAgentContent(content);
          } else {
            // No local changes — apply with diff-based highlighting
            if (markdownEditorRef.current) {
              markdownEditorRef.current.applyAgentChange(content);
            }
            setCurrentContent(content);
            setExternalUpdateType("updated");
            setTimeout(() => setExternalUpdateType(null), 2000);
          }
        });
      } else {
        // Non-markdown files: original behavior
        if (!isModified) {
          setCurrentContent(content);
          setExternalUpdateType("updated");
          setTimeout(() => setExternalUpdateType(null), 2000);
        } else {
          setExternalUpdateType("changed_externally");
        }
      }
    }
    // Note: isModified is intentionally captured from the render closure but
    // NOT listed as a dependency — we only want to run when content changes.
    // The previousContentRef guard prevents re-processing on isModified changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, isMarkdown, isSelfWrite, cancelPendingSave]);

  // Track if content is modified
  useEffect(() => {
    setIsModified(currentContent !== content);
  }, [currentContent, content]);

  // Save file (for non-markdown or as fallback) - wrapped in useCallback for stable reference
  const handleSave = useCallback(async () => {
    if (!isModified || isSaving) return;

    // For markdown, use auto-save's saveNow
    if (isMarkdown) {
      await saveNow();
      setIsModified(false);
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);

    try {
      if (isTauri()) {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(filePath, currentContent);
        setIsModified(false);
        setSaveMessage(t("app.saved", "Saved"));
        // Clear message after 2 seconds
        setTimeout(() => setSaveMessage(null), 2000);
      } else {
        setSaveMessage(t("app.cannotSaveWebMode", "Cannot save in web mode"));
        setTimeout(() => setSaveMessage(null), 3000);
      }
    } catch (error) {
      console.error("Failed to save file:", error);
      setSaveMessage(`Save failed: ${error}`);
      setTimeout(() => setSaveMessage(null), 3000);
    } finally {
      setIsSaving(false);
    }
  }, [isModified, isSaving, filePath, currentContent, t, isMarkdown, saveNow]);

  // Keyboard shortcut: Cmd+S / Ctrl+S for save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  // --- Conflict resolution handlers ---
  const handleAcceptAgent = useCallback(() => {
    if (conflictAgentContent !== null) {
      if (markdownEditorRef.current) {
        markdownEditorRef.current.applyAgentChange(conflictAgentContent);
      }
      setCurrentContent(conflictAgentContent);
      setConflictAgentContent(null);
      setShowConflictDiff(false);
    }
  }, [conflictAgentContent]);

  const handleKeepMine = useCallback(() => {
    setConflictAgentContent(null);
    setShowConflictDiff(false);
    // Next auto-save will overwrite disk with user's version
  }, []);

  const handleViewConflictDiff = useCallback(() => {
    setShowConflictDiff((prev) => !prev);
  }, []);

  const handleConfirmClose = useCallback(() => {
    setShowCloseConfirm(false);
    onClose();
  }, [onClose]);

  const handleSaveAndClose = useCallback(async () => {
    setShowCloseConfirm(false);
    await handleSave();
    onClose();
  }, [handleSave, onClose]);

  // Save status indicator for markdown files
  const renderSaveStatusIndicator = () => {
    if (!isMarkdown) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs",
          saveStatus === "saved" && "text-green-500",
          saveStatus === "modified" && "text-amber-500",
          saveStatus === "saving" && "text-blue-500",
        )}
        title={
          saveStatus === "saved"
            ? t("app.saved", "Saved")
            : saveStatus === "saving"
              ? t("app.saving", "Saving...")
              : t("app.unsavedChanges", "Unsaved changes")
        }
      >
        {saveStatus === "saved" && (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            {t("app.saved", "Saved")}
          </>
        )}
        {saveStatus === "modified" && (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          </>
        )}
        {saveStatus === "saving" && (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("app.saving", "Saving...")}
          </>
        )}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* File tab header - simple and clean */}
      <div className="flex items-center h-10 px-3 border-b bg-muted/30 shrink-0 gap-3">
        {/* Full file path with status indicator */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{displayPath}</span>
          {isMarkdown ? (
            renderSaveStatusIndicator()
          ) : (
            isModified && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0"
                title={t("app.unsavedChanges", "Unsaved changes")}
              />
            )
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 ml-auto">
          {/* Save button - only for non-markdown files */}
          {!isMarkdown && (
            <button
              onClick={handleSave}
              disabled={!isModified || isSaving}
              className={`p-1.5 rounded transition-colors ${
                isModified
                  ? "text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-900/30"
                  : "text-muted-foreground/50"
              }`}
              title={isModified ? `${t("common.save", "Save")} (⌘S)` : t("app.noChanges", "No changes")}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Code toggle - only for HTML files (switch between preview and code) */}
          {previewType === "html" && (
            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`p-1.5 rounded transition-colors ${
                !showPreview
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title={
                !showPreview
                  ? t("app.preview", "Preview")
                  : t("app.editMode", "Edit mode")
              }
            >
              {!showPreview ? (
                <Eye className="h-4 w-4" />
              ) : (
                <Code className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Diff toggle - icon only */}
          {hasChanges && (
            <button
              onClick={() => {
                if (showDiff) {
                  setShowDiff(false);
                } else {
                  setShowDiff(true);
                  setShowHistory(false);
                }
              }}
              className={`p-1.5 rounded transition-colors ${
                showDiff
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title={
                showDiff
                  ? t("app.editMode", "Edit mode")
                  : t("app.viewChanges", "View changes")
              }
            >
              {showDiff ? (
                <Code className="h-4 w-4" />
              ) : (
                <GitCompare className="h-4 w-4" />
              )}
            </button>
          )}

          {isTeamFile && isTauri() && (
            <button
              onClick={() => {
                if (showHistory) {
                  setShowHistory(false);
                } else {
                  setShowHistory(true);
                  setShowDiff(false);
                }
              }}
              className={`p-1.5 rounded transition-colors ${
                showHistory
                  ? "text-primary bg-primary/10"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              title={t("app.viewHistory", "View history")}
            >
              <History className="h-4 w-4" />
            </button>
          )}

          {/* Change stats */}
          {hasChanges && (
            <span className="text-xs text-muted-foreground">
              <span className="text-green-600">
                +{gitDiffStats?.additions ?? 0}
              </span>{" "}
              <span className="text-red-500">
                -{gitDiffStats?.deletions ?? 0}
              </span>
            </span>
          )}
        </div>

        {/* Save message - toast style (non-markdown only) */}
        {!isMarkdown && saveMessage && (
          <span
            className={`text-xs ${saveMessage.includes("failed") ? "text-red-500" : "text-green-500"}`}
          >
            {saveMessage}
          </span>
        )}

        {/* External update message (non-markdown only) */}
        {!isMarkdown && externalUpdateType && (
          <div className="flex items-center gap-2">
            <span
              className={`text-xs ${externalUpdateType === "changed_externally" ? "text-amber-500" : "text-green-500"}`}
            >
              {externalUpdateType === "updated"
                ? t("app.fileUpdated", "File updated")
                : t("app.fileChangedExternally", "File changed externally")}
            </span>
            {/* Show reload button if user has local changes and file changed externally */}
            {isModified && externalUpdateType === "changed_externally" && (
              <button
                onClick={() => {
                  setCurrentContent(content);
                  setExternalUpdateType(null);
                }}
                className="text-xs text-blue-500 hover:text-blue-600 underline"
              >
                {t("app.discardReload", "Discard & Reload")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Conflict banner for markdown files */}
      {isMarkdown && conflictAgentContent !== null && (
        <ConflictBanner
          onAcceptAgent={handleAcceptAgent}
          onKeepMine={handleKeepMine}
          onViewDiff={handleViewConflictDiff}
          showingDiff={showConflictDiff}
        />
      )}

      {/* Editor / Diff / Preview - file-type-routed */}
      <div className="flex-1 overflow-hidden">
        {/* History view */}
        {showHistory && historyProvider ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LazyFileHistoryView
              provider={historyProvider}
              filePath={filePath}
              isDark={isDark}
            />
          </Suspense>
        ) : showHistory ? null : isMarkdown && showConflictDiff && conflictAgentContent !== null ? (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LazyDiffRenderer
              before={currentContent}
              after={conflictAgentContent}
              filePath={filePath}
              isDark={isDark}
            />
          </Suspense>
        ) : showDiff && hasChanges && gitHeadContent !== null ? (
          // Diff view - custom diff renderer with Shiki
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <LazyDiffRenderer
              before={gitHeadContent ?? ""}
              after={currentContent}
              filePath={filePath}
              isDark={isDark}
              onSendToAgent={(agentPrompt) => {
                void sendAgentPromptInActiveSession(agentPrompt);
              }}
            />
          </Suspense>
        ) : (
          (() => {
            // Route to appropriate editor based on file type
            const editorType = getEditorType(filename);

            if (editorType === "markdown") {
              return (
                <Suspense
                  fallback={
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  }
                >
                  <LazyMarkdownEditor
                    ref={markdownEditorRef}
                    content={currentContent}
                    filename={filename}
                    filePath={filePath}
                    onChange={(value) => setCurrentContent(value)}
                    isDark={isDark}
                    targetLine={targetLine}
                    targetHeading={targetHeading}
                  />
                </Suspense>
              );
            }

            // Code editor (default) - CodeMirror 6
            // For HTML files: toggle between full preview and full code editor
            return (
              <div className="flex h-full overflow-hidden">
                {showPreview && previewType === "html" ? (
                  // Full screen HTML preview
                  <div className="w-full bg-white">
                    {/* No `allow-same-origin`: for a srcdoc frame it means the
                        *parent's* origin, which would put the previewed file in
                        the app's own document and hand it `parent.__TAURI__`
                        (withGlobalTauri) — i.e. every IPC command and the
                        whole-disk fs grants. Without it the frame gets an opaque
                        origin and reaching `parent` throws SecurityError, while
                        the preview still renders. */}
                    <iframe
                      srcDoc={currentContent}
                      className="w-full h-full border-0"
                      sandbox="allow-scripts"
                      title={t("app.htmlPreview", "HTML Preview")}
                    />
                  </div>
                ) : (
                  // Full screen code editor
                  <div className="w-full">
                    <Suspense
                      fallback={
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                      }
                    >
                      <LazyCodeEditor
                        content={currentContent}
                        filename={filename}
                        filePath={filePath}
                        onChange={(value) => setCurrentContent(value)}
                        isDark={isDark}
                        originalContent={gitHeadContent ?? null}
                        targetLine={targetLine}
                    />
                  </Suspense>
                </div>
              )}
              </div>
            );
          })()
        )}
      </div>

      {/* Unsaved changes confirmation dialog (non-markdown only) */}
      <AlertDialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("app.unsavedChangesTitle", "Unsaved Changes")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "app.unsavedChangesMessage",
                "You have unsaved changes in this file. Do you want to save before closing?",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowCloseConfirm(false)}>
              {t("common.cancel", "Cancel")}
            </AlertDialogCancel>
            <Button variant="destructive" onClick={handleConfirmClose}>
              {t("app.discardChanges", "Don't Save")}
            </Button>
            <AlertDialogAction onClick={handleSaveAndClose}>
              {t("app.saveAndClose", "Save")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
