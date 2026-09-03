import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  FilePenLine,
  Loader2,
} from "lucide-react";
import { ToolCall } from "@/stores/session-types";
import { useWorkspaceStore } from "@/stores/workspace";
import {
  extractFilePath,
  getFileName,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";
import { ToolCallDiffBody } from "./ToolCallDiffBody";
import {
  resolveWorkspaceRelativePath,
  useToolCallFileOnDisk,
} from "@/hooks/use-tool-call-file-on-disk";
import { ToolCallStatusGlyph } from "./ToolCallStatusGlyph";
import { ToolCallDisclosure } from "./ToolCallDisclosure";

// Generate unified diff for new file (empty before)
function generateNewFileDiff(content: string, filePath: string): string {
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push('new file mode 100644');
  lines.push(`--- /dev/null`);
  lines.push(`+++ b/${filePath}`);
  
  const contentLines = content.split('\n');
  lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
  
  for (const line of contentLines) {
    lines.push(`+${line}`);
  }
  
  return lines.join('\n');
}

export function WriteToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);

  // Content can come from arguments (when complete) or from result (during streaming)
  const argsContent = String(args?.contents || args?.content || "");
  const streamingContent =
    typeof toolCall.result === "string" ? toolCall.result : "";
  const content = argsContent || streamingContent;

  // Generate unified diff for new file (shows as all additions)
  const fullPath = useMemo(
    () => resolveWorkspaceRelativePath(filePath, workspacePath),
    [filePath, workspacePath],
  );
  const shouldVerifyFileOnDisk =
    Boolean(fullPath) && toolCall.status === "completed";
  const fileOnDisk = useToolCallFileOnDisk(fullPath, shouldVerifyFileOnDisk);
  const fileMissingOnDisk = fileOnDisk === false;

  const diffData = useMemo(() => {
    if (!content) return null;
    try {
      const diffText = generateNewFileDiff(content, filePath || "file");
      const parsed = parseSingleFileDiff(diffText, filePath || "file");
      if (!parsed) return null;

      // Merge all hunks into a single list of lines
      const allLines: DiffLine[] = [];
      for (const hunk of parsed.hunks) {
        allLines.push(...hunk.lines);
      }

      return {
        lines: allLines,
        additions: parsed.addedCount,
      };
    } catch (error) {
      console.error("[WriteToolCard] Failed to generate diff:", error);
      return null;
    }
  }, [content, filePath]);

  const canOpenFile =
    Boolean(filePath) &&
    Boolean(fullPath) &&
    toolCall.status !== "failed" &&
    !fileMissingOnDisk;

  const handleOpenFile = useCallback(() => {
    if (!canOpenFile || !fullPath) return;
    selectFile(fullPath);
  }, [canOpenFile, fullPath, selectFile]);

  return (
    <ToolCallDisclosure
      testId="tool-card-write"
      icon={<FilePenLine className="h-3.5 w-3.5" />}
      title={t("chat.toolCall.write.title", "Write")}
      target={filePath ? getFileName(filePath) : undefined}
      targetTitle={filePath || undefined}
      onTargetClick={canOpenFile ? handleOpenFile : undefined}
      meta={diffData && diffData.additions > 0 ? `+${diffData.additions}` : undefined}
      status={<ToolCallStatusGlyph status={toolCall.status} />}
    >
      {diffData && diffData.lines.length > 0 && (
        <ToolCallDiffBody lines={diffData.lines} variant="snippet" previewLineCount={3} />
      )}

      {!content && toolCall.status === "calling" && (
        <div className="flex items-center gap-2 px-3 py-2.5 text-[11.5px] text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span>{t("chat.toolCall.write.writing", "Writing file...")}</span>
        </div>
      )}

      {content && !diffData && (
        <div className="px-3 py-2.5 text-[11.5px] italic text-muted-foreground">
          {t("chat.toolCall.diff.unavailable", "Unable to generate diff view")}
        </div>
      )}
    </ToolCallDisclosure>
  );
}
