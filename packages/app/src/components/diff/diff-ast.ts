/**
 * DiffAST - Parse git diff output into structured AST.
 *
 * Supports:
 * - Line-level parsing (added, removed, context)
 * - Hunk-level grouping
 * - Change-level logical grouping
 * - Line number mapping (old/new)
 */

type LineType = 'added' | 'removed' | 'context';

export interface DiffLine {
  type: LineType;
  content: string;
  /** Line number in the old file (null for added lines) */
  oldLineNumber: number | null;
  /** Line number in the new file (null for removed lines) */
  newLineNumber: number | null;
}

export interface DiffHunk {
  /** Hunk index (1-based) */
  index: number;
  /** Raw hunk header (e.g., "@@ -1,5 +1,7 @@") */
  header: string;
  /** Optional function/context from hunk header */
  context: string;
  /** Start line in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldCount: number;
  /** Start line in new file */
  newStart: number;
  /** Number of lines in new file */
  newCount: number;
  /** Lines in this hunk */
  lines: DiffLine[];
  /** Number of added lines */
  addedCount: number;
  /** Number of removed lines */
  removedCount: number;
}

export type FileStatus = 'modified' | 'renamed' | 'new' | 'deleted';

export interface DiffFile {
  /** File path (new path if renamed) */
  filePath: string;
  /** Old file path (only if renamed) */
  oldFilePath?: string;
  /** File status */
  status: FileStatus;
  /** Total added lines */
  addedCount: number;
  /** Total removed lines */
  removedCount: number;
  /** Hunks in this file */
  hunks: DiffHunk[];
}

/**
 * Parse a unified diff string (git diff output) into structured DiffFile array.
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Look for diff header
    if (lines[i].startsWith('diff --git')) {
      const file = parseFileSection(lines, i);
      if (file) {
        files.push(file.file);
        i = file.nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return files;
}

/**
 * Parse a single file section from a diff.
 */
function parseFileSection(
  lines: string[],
  startIndex: number,
): { file: DiffFile; nextIndex: number } | null {
  let i = startIndex;

  // Parse "diff --git a/path b/path"
  const diffLine = lines[i];
  const diffMatch = diffLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!diffMatch) return null;

  // diffMatch[1] is oldPath, diffMatch[2] is newPath
  const newPath = diffMatch[2];
  i++;

  let status: FileStatus = 'modified';
  let oldFilePath: string | undefined;

  // Parse metadata lines (index, old mode, new mode, etc.)
  while (i < lines.length && !lines[i].startsWith('---') && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
    if (lines[i].startsWith('new file')) {
      status = 'new';
    } else if (lines[i].startsWith('deleted file')) {
      status = 'deleted';
    } else if (lines[i].startsWith('rename from')) {
      status = 'renamed';
      oldFilePath = lines[i].replace('rename from ', '');
    }
    i++;
  }

  // Skip --- and +++ lines
  if (i < lines.length && lines[i].startsWith('---')) i++;
  if (i < lines.length && lines[i].startsWith('+++')) i++;

  // Parse hunks
  const hunks: DiffHunk[] = [];
  let hunkIndex = 0;

  while (i < lines.length && !lines[i].startsWith('diff --git')) {
    if (lines[i].startsWith('@@')) {
      hunkIndex++;
      const hunk = parseHunk(lines, i, hunkIndex);
      if (hunk) {
        hunks.push(hunk.hunk);
        i = hunk.nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  // Calculate totals
  let addedCount = 0;
  let removedCount = 0;
  for (const hunk of hunks) {
    addedCount += hunk.addedCount;
    removedCount += hunk.removedCount;
  }

  return {
    file: {
      filePath: newPath,
      oldFilePath: status === 'renamed' ? oldFilePath : undefined,
      status,
      addedCount,
      removedCount,
      hunks,
    },
    nextIndex: i,
  };
}

/**
 * Parse a single hunk from diff lines.
 */
function parseHunk(
  lines: string[],
  startIndex: number,
  hunkIndex: number,
): { hunk: DiffHunk; nextIndex: number } | null {
  const headerLine = lines[startIndex];
  const headerMatch = headerLine.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)?$/,
  );
  if (!headerMatch) return null;

  const oldStart = parseInt(headerMatch[1], 10);
  const oldCount = headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1;
  const newStart = parseInt(headerMatch[3], 10);
  const newCount = headerMatch[4] !== undefined ? parseInt(headerMatch[4], 10) : 1;
  const context = headerMatch[5] || '';

  const diffLines: DiffLine[] = [];
  let currentOld = oldStart;
  let currentNew = newStart;
  let addedCount = 0;
  let removedCount = 0;
  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];

    // Stop at next hunk or file
    if (line.startsWith('@@') || line.startsWith('diff --git')) break;

    if (line.startsWith('+')) {
      diffLines.push({
        type: 'added',
        content: line.substring(1),
        oldLineNumber: null,
        newLineNumber: currentNew,
      });
      currentNew++;
      addedCount++;
    } else if (line.startsWith('-')) {
      diffLines.push({
        type: 'removed',
        content: line.substring(1),
        oldLineNumber: currentOld,
        newLineNumber: null,
      });
      currentOld++;
      removedCount++;
    } else if (line.startsWith(' ') || line === '') {
      diffLines.push({
        type: 'context',
        content: line.startsWith(' ') ? line.substring(1) : line,
        oldLineNumber: currentOld,
        newLineNumber: currentNew,
      });
      currentOld++;
      currentNew++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" - skip
    } else {
      break;
    }

    i++;
  }

  return {
    hunk: {
      index: hunkIndex,
      header: headerLine,
      context,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: diffLines,
      addedCount,
      removedCount,
    },
    nextIndex: i,
  };
}

/**
 * Parse a single-file diff (e.g., from `git diff -- path`).
 * Returns a DiffFile or null.
 */
export function parseSingleFileDiff(diffText: string, filePath: string): DiffFile | null {
  // If it starts with "diff --git", use full parser
  if (diffText.startsWith('diff --git')) {
    const files = parseDiff(diffText);
    return files[0] || null;
  }

  // Otherwise, try to parse as raw hunk output
  const hunks: DiffHunk[] = [];
  const lines = diffText.split('\n');
  let i = 0;
  let hunkIndex = 0;

  // Skip non-hunk lines
  while (i < lines.length && !lines[i].startsWith('@@')) i++;

  while (i < lines.length) {
    if (lines[i].startsWith('@@')) {
      hunkIndex++;
      const hunk = parseHunk(lines, i, hunkIndex);
      if (hunk) {
        hunks.push(hunk.hunk);
        i = hunk.nextIndex;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  if (hunks.length === 0) return null;

  let addedCount = 0;
  let removedCount = 0;
  for (const hunk of hunks) {
    addedCount += hunk.addedCount;
    removedCount += hunk.removedCount;
  }

  return {
    filePath,
    status: 'modified',
    addedCount,
    removedCount,
    hunks,
  };
}
