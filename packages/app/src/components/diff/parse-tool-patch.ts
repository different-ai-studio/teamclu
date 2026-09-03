/**
 * Parse patch / unified-diff strings from agent "apply_patch" (and similar) tools
 * into the DiffLine[] shape used by chat tool cards.
 */

import {
  parseDiff,
  parseSingleFileDiff,
  type DiffLine,
} from "@/components/diff/diff-ast";

interface ParsedToolPatch {
  lines: DiffLine[];
  additions: number;
  deletions: number;
  filePath: string;
}

function extractPathFromDiffGit(text: string): string {
  const m = text.match(/^diff --git a\/(.+?) b\//m);
  return m ? m[1].trim() : "";
}

function extractPathFromUnifiedPlus(text: string): string {
  const m = text.match(/^\+\+\+\s+[ab]\/(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

/**
 * Parse V4A-style "*** Begin Patch" blocks that contain +/- lines, with or without @@ hunks.
 */
function parseV4ALoosePatch(
  text: string,
  defaultPath: string,
): ParsedToolPatch | null {
  if (!text.includes("*** Begin Patch")) return null;

  let filePath = defaultPath;
  const updateMatch = text.match(/\*\*\* Update File:\s*(.+?)\s*$/m);
  const addMatch = text.match(/\*\*\* Add File:\s*(.+?)\s*$/m);
  if (updateMatch) filePath = updateMatch[1].trim();
  else if (addMatch) filePath = addMatch[1].trim();

  const endIdx = text.indexOf("*** End Patch");
  const startIdx = text.indexOf("*** Begin Patch");
  const slice =
    endIdx >= 0
      ? text.slice(startIdx, endIdx)
      : startIdx >= 0
        ? text.slice(startIdx)
        : text;

  const rawLines = slice.split("\n");
  const bodyLines = rawLines.filter((l) => !l.trimStart().startsWith("***"));

  const body = bodyLines.join("\n").trim();
  if (body.includes("@@")) {
    const parsed = parseSingleFileDiff(body, filePath || "file");
    if (parsed && parsed.hunks.length > 0) {
      const allLines: DiffLine[] = [];
      for (const h of parsed.hunks) {
        allLines.push(...h.lines);
      }
      return {
        lines: allLines,
        additions: parsed.addedCount,
        deletions: parsed.removedCount,
        filePath: parsed.filePath || filePath || "file",
      };
    }
  }

  let oldN = 1;
  let newN = 1;
  const diffLines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const line of bodyLines) {
    const t = line.trimEnd();
    if (t === "") continue;
    if (t.startsWith("\\")) continue;

    const c = t[0];
    const rest = t.slice(1);

    if (c === "+") {
      diffLines.push({
        type: "added",
        content: rest,
        oldLineNumber: null,
        newLineNumber: newN,
      });
      newN++;
      additions++;
    } else if (c === "-") {
      diffLines.push({
        type: "removed",
        content: rest,
        oldLineNumber: oldN,
        newLineNumber: null,
      });
      oldN++;
      deletions++;
    } else if (c === " ") {
      diffLines.push({
        type: "context",
        content: rest,
        oldLineNumber: oldN,
        newLineNumber: newN,
      });
      oldN++;
      newN++;
    }
  }

  if (diffLines.length === 0) return null;

  return {
    lines: diffLines,
    additions,
    deletions,
    filePath: filePath || "file",
  };
}

/**
 * Best-effort parse of patch text from apply_patch / edit tools for the diff UI.
 */
export function tryParseToolPatchForUI(
  patchText: string,
  hintPath: string,
): ParsedToolPatch | null {
  const trimmed = patchText.trim();
  if (!trimmed) return null;

  const pathHint =
    hintPath ||
    extractPathFromDiffGit(trimmed) ||
    extractPathFromUnifiedPlus(trimmed);

  if (trimmed.startsWith("diff --git")) {
    const files = parseDiff(trimmed);
    if (files.length === 0) return null;
    const target = files[0];
    const allLines: DiffLine[] = [];
    for (const h of target.hunks) {
      allLines.push(...h.lines);
    }
    return {
      lines: allLines,
      additions: target.addedCount,
      deletions: target.removedCount,
      filePath: target.filePath || pathHint || "file",
    };
  }

  const single = parseSingleFileDiff(trimmed, pathHint || "file");
  if (single && single.hunks.length > 0) {
    const allLines: DiffLine[] = [];
    for (const h of single.hunks) {
      allLines.push(...h.lines);
    }
    return {
      lines: allLines,
      additions: single.addedCount,
      deletions: single.removedCount,
      filePath: single.filePath || pathHint || "file",
    };
  }

  return parseV4ALoosePatch(trimmed, pathHint || "file");
}
