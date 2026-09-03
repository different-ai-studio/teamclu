import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatTokenCount, formatCost } from '@/lib/ui/format-tokens'
import { cn } from '@/lib/utils'

interface MessageTokenUsageProps {
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost?: number
}

export function MessageTokenUsage({ tokens, cost }: MessageTokenUsageProps) {
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
        <span>↓{formatTokenCount(tokens.input)}</span>
        <span>↑{formatTokenCount(tokens.output)}</span>
        <span>tokens</span>
        {cost !== undefined && cost > 0 && (
          <>
            <span>·</span>
            <span>{formatCost(cost)}</span>
          </>
        )}
      </button>

      {expanded && (
        <div className="text-[11px] text-muted-foreground/70 pl-5 mt-0.5 space-y-0.5">
          <div className="flex gap-4">
            <span>Input: {formatTokenCount(tokens.input)}</span>
            <span>Output: {formatTokenCount(tokens.output)}</span>
          </div>
          <div className="flex gap-4">
            <span>Reasoning: {formatTokenCount(tokens.reasoning)}</span>
            <span>Cache R: {formatTokenCount(tokens.cache.read)}</span>
            <span>Cache W: {formatTokenCount(tokens.cache.write)}</span>
          </div>
          {cost !== undefined && cost > 0 && (
            <div>Cost: {formatCost(cost)}</div>
          )}
        </div>
      )}
    </div>
  )
}
