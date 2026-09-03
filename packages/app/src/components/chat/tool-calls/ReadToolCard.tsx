import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { ToolCall } from "@/stores/session-types";
import { extractFilePath, getFileName } from "./tool-call-utils";
import { ToolCallDisclosure } from "./ToolCallDisclosure";
import { ToolCallStatusGlyph } from "./ToolCallStatusGlyph";

export function ReadToolCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation();
  const args = toolCall.arguments as Record<string, unknown>;
  const filePath = extractFilePath(args);
  const displayName = filePath ? getFileName(filePath) : t("chat.toolCall.read.defaultFile", "file");

  const sizeText = useMemo(() => {
    if (typeof toolCall.result !== "string" || !toolCall.result.length) return null;
    const bytes = new TextEncoder().encode(toolCall.result).length;
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }, [toolCall.result]);

  return (
    <ToolCallDisclosure
      testId="tool-row-read"
      icon={<FileText className="h-3.5 w-3.5" />}
      title={t("chat.toolCall.read.title", "Read")}
      target={displayName}
      targetTitle={filePath || undefined}
      meta={sizeText}
      status={<ToolCallStatusGlyph status={toolCall.status} />}
    >
      {typeof toolCall.result === "string" && toolCall.result.length > 0 ? (
        <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words bg-background/60 px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-ink-2">
          {toolCall.result}
        </pre>
      ) : null}
    </ToolCallDisclosure>
  );
}
