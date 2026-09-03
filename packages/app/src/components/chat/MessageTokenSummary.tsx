import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatTokenCount, formatCost } from '@/lib/ui/format-tokens'
import { cn } from '@/lib/utils'

interface MessageTokenSummaryProps {
  summary: {
    steps: number
    totalInput: number
    totalOutput: number
    totalCost: number
  }
}

export function MessageTokenSummary({ summary }: MessageTokenSummaryProps) {
  const [expanded, setExpanded] = React.useState(false)

  return (
    <div className="mt-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors",
          "rounded px-1.5 py-0.5 -ml-1.5 hover:bg-muted/50"
        )}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>{summary.steps} steps</span>
        <span>·</span>
        <span>↓{formatTokenCount(summary.totalInput)}</span>
        <span>↑{formatTokenCount(summary.totalOutput)}</span>
        <span>tokens</span>
        {summary.totalCost > 0 && (
          <>
            <span>·</span>
            <span>{formatCost(summary.totalCost)}</span>
          </>
        )}
      </button>

      {expanded && (
        <div className="text-[11px] text-muted-foreground/70 pl-5 mt-0.5 space-y-0.5">
          <div className="flex gap-4">
            <span>Total Input: {formatTokenCount(summary.totalInput)}</span>
            <span>Total Output: {formatTokenCount(summary.totalOutput)}</span>
          </div>
          {summary.totalCost > 0 && (
            <div>Total Cost: {formatCost(summary.totalCost)}</div>
          )}
        </div>
      )}
    </div>
  )
}
