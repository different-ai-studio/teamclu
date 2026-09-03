import type { ToolCall } from "@/stores/session";
import {
  extractFilePath,
  extractPatchTextFromToolArgs,
} from "./tool-call-utils";
import { parseSingleFileDiff, type DiffLine } from "@/components/diff/diff-ast";
import { tryParseToolPatchForUI } from "@/components/diff/parse-tool-patch";

type ToolCallContentDiff = {
  path: string;
  oldText?: string;
  newText: string;
};

export type ToolCallContentBlock =
  | { type: "text"; text: string }
  | { type: "diff"; diff: ToolCallContentDiff }
  | { type: "terminal"; terminalId: string };

type ToolCallDiffViewModel = {
  lines: DiffLine[];
  additions: number;
  deletions: number;
  headerPath: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseDiffBlock(value: Record<string, unknown>): ToolCallContentDiff | null {
  const path = String(value.path ?? "");
  const newText = String(value.newText ?? value.new_text ?? "");
  if (!path || !newText) return null;
  const oldRaw = value.oldText ?? value.old_text;
  const oldText =
    typeof oldRaw === "string" && oldRaw.length > 0 ? oldRaw : undefined;
  return { path, oldText, newText };
}

/** Parse wire proto content[] or persisted metadata content JSON. */
export function parseToolContentBlocks(raw: unknown): ToolCallContentBlock[] {
  const root = record(raw);
  const items = Array.isArray(root.content) ? root.content : Array.isArray(raw) ? raw : [];
  const out: ToolCallContentBlock[] = [];

  for (const item of items) {
    const block = record(item);
    const payload = block.payload;
    if (payload && typeof payload === "object") {
      const p = payload as { case?: string; value?: Record<string, unknown> };
      if (p.case === "text" && p.value) {
        const text = String(p.value.text ?? "");
        if (text.trim()) out.push({ type: "text", text });
        continue;
      }
      if (p.case === "diff" && p.value) {
        const diff = parseDiffBlock(p.value);
        if (diff) out.push({ type: "diff", diff });
        continue;
      }
      if (p.case === "terminal" && p.value) {
        const terminalId = String(p.value.terminalId ?? p.value.terminal_id ?? "");
        if (terminalId) out.push({ type: "terminal", terminalId });
        continue;
      }
    }

    const type = String(block.type ?? "");
    if (type === "text") {
      const text = String(block.text ?? "");
      if (text.trim()) out.push({ type: "text", text });
    } else if (type === "diff") {
      const diff = parseDiffBlock(block);
      if (diff) out.push({ type: "diff", diff });
    } else if (type === "terminal") {
      const terminalId = String(block.terminal_id ?? block.terminalId ?? "");
      if (terminalId) out.push({ type: "terminal", terminalId });
    }
  }

  return out;
}

function generateUnifiedDiffFromStrings(
  oldText: string,
  newText: string,
  filePath: string,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  oldLines.forEach((line) => lines.push(`-${line}`));
  newLines.forEach((line) => lines.push(`+${line}`));
  return lines.join("\n");
}

function diffViewFromLines(
  lines: DiffLine[],
  additions: number,
  deletions: number,
  headerPath: string,
): ToolCallDiffViewModel {
  return { lines, additions, deletions, headerPath };
}

function diffViewFromAcp(diff: ToolCallContentDiff): ToolCallDiffViewModel | null {
  try {
    const oldText = diff.oldText ?? "";
    const diffText = generateUnifiedDiffFromStrings(oldText, diff.newText, diff.path);
    const parsed = parseSingleFileDiff(diffText, diff.path);
    if (!parsed) return null;
    const allLines: DiffLine[] = [];
    for (const hunk of parsed.hunks) {
      allLines.push(...hunk.lines);
    }
    return diffViewFromLines(allLines, parsed.addedCount, parsed.removedCount, diff.path);
  } catch {
    return null;
  }
}

function diffViewFromArgs(args: Record<string, unknown>): ToolCallDiffViewModel | null {
  const filePath = extractFilePath(args);
  const patchText = extractPatchTextFromToolArgs(args);
  const oldStr = String(args.old_string ?? args.oldString ?? "");
  const newStr = String(args.new_string ?? args.newString ?? "");

  try {
    if (oldStr || newStr) {
      const diffText = generateUnifiedDiffFromStrings(oldStr, newStr, filePath || "file");
      const parsed = parseSingleFileDiff(diffText, filePath || "file");
      if (!parsed) return null;
      const allLines: DiffLine[] = [];
      for (const hunk of parsed.hunks) {
        allLines.push(...hunk.lines);
      }
      return diffViewFromLines(
        allLines,
        parsed.addedCount,
        parsed.removedCount,
        filePath || "file",
      );
    }

    if (patchText) {
      const parsed = tryParseToolPatchForUI(patchText, filePath);
      if (!parsed || parsed.lines.length === 0) return null;
      return diffViewFromLines(
        parsed.lines,
        parsed.additions,
        parsed.deletions,
        filePath || parsed.filePath || "file",
      );
    }
  } catch {
    return null;
  }
  return null;
}

/** Prefer ACP content[] diff blocks, then fall back to tool arguments. */
export function resolveToolCallDiff(toolCall: ToolCall): ToolCallDiffViewModel | null {
  const fromContent = toolCall.content?.find(
    (block): block is { type: "diff"; diff: ToolCallContentDiff } =>
      block.type === "diff",
  );
  if (fromContent) {
    const view = diffViewFromAcp(fromContent.diff);
    if (view) return view;
  }

  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  return diffViewFromArgs(args);
}
