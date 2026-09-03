import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FilePenLine, Trash2 } from "lucide-react";
import { ToolCall } from "@/stores/session-types";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  extractFilePath,
  extractPatchTextFromToolArgs,
  parseDeleteOnlyPatch,
  getFileName,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";
import { resolveToolCallDiff } from "./tool-call-content";
import { ToolCallDiffBody } from "./ToolCallDiffBody";
import {
  resolveWorkspaceRelativePath,
  useToolCallFileOnDisk,
} from "@/hooks/use-tool-call-file-on-disk";
import { ToolCallStatusGlyph } from "./ToolCallStatusGlyph";
import { ToolCallDisclosure } from "./ToolCallDisclosure";

function generateNewFileDiff(content: string, filePath: string): string {
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push("new file mode 100644");
  lines.push("--- /dev/null");
  lines.push(`+++ b/${filePath}`);
  const contentLines = content.split("\n");
  lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
  for (const line of contentLines) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}

export function EditToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const patchText = extractPatchTextFromToolArgs(args);

  const deletedFiles = useMemo(
    () => (patchText ? parseDeleteOnlyPatch(patchText) : null),
    [patchText],
  );

  const diffData = useMemo(() => {
    const fromContent = resolveToolCallDiff(toolCall);
    if (fromContent) return fromContent;

    try {
      const wholeFile = String(args?.contents || args?.content || "");
      if (wholeFile && !wholeFile.trim().startsWith("diff --git")) {
        const diffText = generateNewFileDiff(wholeFile, filePath || "file");
        const parsed = parseSingleFileDiff(diffText, filePath || "file");
        if (!parsed) return null;

        const allLines: DiffLine[] = [];
        for (const hunk of parsed.hunks) {
          allLines.push(...hunk.lines);
        }

        return {
          lines: allLines,
          additions: parsed.addedCount,
          deletions: parsed.removedCount,
          headerPath: filePath || "file",
        };
      }
    } catch {
      return null;
    }
    return null;
  }, [toolCall, filePath, args?.content, args?.contents]);

  const headerPath = diffData?.headerPath ?? filePath;
  const pathForDisk =
    headerPath && headerPath !== "file" ? headerPath : filePath || null;
  const fullPath = useMemo(
    () => resolveWorkspaceRelativePath(pathForDisk, workspacePath),
    [pathForDisk, workspacePath],
  );
  const shouldVerifyFileOnDisk =
    Boolean(fullPath) && toolCall.status === "completed";
  const fileOnDisk = useToolCallFileOnDisk(fullPath, shouldVerifyFileOnDisk);
  const fileMissingOnDisk = fileOnDisk === false;

  const canOpenFile =
    Boolean(headerPath) &&
    Boolean(fullPath) &&
    toolCall.status !== "failed" &&
    !fileMissingOnDisk;

  const handleOpenFile = useCallback(() => {
    if (!canOpenFile || !fullPath) return;
    selectFile(fullPath);
  }, [canOpenFile, fullPath, selectFile]);

  if (deletedFiles) {
    return (
      <ToolCallDisclosure
        testId="tool-card-edit"
        icon={<Trash2 className="h-3.5 w-3.5" />}
        title={t("chat.toolCall.edit.title", "Edit")}
        target={t("chat.toolCall.edit.deletedFiles", "Deleted {{count}} files", {
          count: deletedFiles.length,
        })}
        status={<ToolCallStatusGlyph status={toolCall.status} />}
      >
        <div className="space-y-0.5 px-3 py-2">
          {deletedFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
              <span className="text-red-500 dark:text-red-400 text-[10px]">D</span>
              <span className="truncate font-mono">{getFileName(f)}</span>
            </div>
          ))}
        </div>
      </ToolCallDisclosure>
    );
  }

  return (
    <ToolCallDisclosure
      testId="tool-card-edit"
      icon={<FilePenLine className="h-3.5 w-3.5" />}
      title={t("chat.toolCall.edit.title", "Edit")}
      target={headerPath ? getFileName(headerPath) : undefined}
      targetTitle={headerPath || undefined}
      onTargetClick={canOpenFile ? handleOpenFile : undefined}
      meta={
        diffData
          ? `${diffData.deletions > 0 ? `-${diffData.deletions}` : ""}${
              diffData.deletions > 0 && diffData.additions > 0 ? " " : ""
            }${diffData.additions > 0 ? `+${diffData.additions}` : ""}`
          : undefined
      }
      status={<ToolCallStatusGlyph status={toolCall.status} />}
    >
      {diffData?.lines.length ? (
        <ToolCallDiffBody lines={diffData.lines} variant="snippet" />
      ) : patchText ? (
        <div className="px-3 py-2.5 text-[11.5px] italic text-muted-foreground">
          {t("chat.toolCall.diff.unavailable", "Unable to generate diff view")}
        </div>
      ) : null}
    </ToolCallDisclosure>
  );
}
