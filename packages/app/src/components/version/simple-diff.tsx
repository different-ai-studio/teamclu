/**
 * Line diff shared by the version-history preview and the conflict resolver.
 *
 * Deliberately dependency-free: an LCS table over lines is enough for the
 * documents this renders (team knowledge notes), and pulling a diff library in
 * for it would be the larger change.
 */
import { cn } from '@/lib/utils'

/**
 * Above this many LCS cells the table costs more than the answer is worth: a
 * 2000×2000 comparison already allocates 4M numbers on the main thread, and
 * every line becomes its own DOM node with no virtualization. Conflicts happen
 * on long shared notes, so this ceiling is reachable in normal use.
 */
const MAX_DIFF_CELLS = 1_000_000

/** Whether a line-by-line comparison of these two texts is worth attempting. */
export function canDiff(oldContent: string, newContent: string): boolean {
  const m = oldContent.split('\n').length
  const n = newContent.split('\n').length
  return m * n <= MAX_DIFF_CELLS
}

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  content: string
}

export function computeSimpleDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const result: DiffLine[] = []

  // Simple line-by-line diff using LCS
  const m = oldLines.length
  const n = newLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build diff
  const trace: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      trace.unshift({ type: 'unchanged', content: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      trace.unshift({ type: 'added', content: newLines[j - 1] })
      j--
    } else {
      trace.unshift({ type: 'removed', content: oldLines[i - 1] })
      i--
    }
  }

  return trace.length > 0 ? trace : result
}

interface SimpleDiffProps {
  oldContent: string
  newContent: string
}

export function SimpleDiff({ oldContent, newContent }: SimpleDiffProps) {
  if (!canDiff(oldContent, newContent)) {
    // Showing the newer text beats freezing the tab; the reader can still see
    // what the other side holds, just not what moved.
    return (
      <div>
        <div className="border-b border-border px-3 py-2 text-[11.5px] text-muted-foreground">
          Too large to compare line by line — showing the other version as-is.
        </div>
        <pre className="whitespace-pre-wrap break-all px-3 py-2 text-xs font-mono leading-relaxed">
          {newContent}
        </pre>
      </div>
    )
  }
  const lines = computeSimpleDiff(oldContent, newContent)
  return (
    <pre className="text-xs font-mono leading-relaxed">
      {lines.map((line, idx) => (
        <div
          key={idx}
          className={cn(
            'px-3 py-px',
            line.type === 'added' && 'bg-green-500/15 text-green-700 dark:text-green-400',
            line.type === 'removed' && 'bg-red-500/15 text-red-700 dark:text-red-400',
            line.type === 'unchanged' && 'text-foreground'
          )}
        >
          <span className="mr-2 select-none text-muted-foreground">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          {line.content}
        </div>
      ))}
    </pre>
  )
}
