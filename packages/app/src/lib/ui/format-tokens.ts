/**
 * Format a token count for display (e.g., 1200 → "1.2k", 1500000 → "1.5M")
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`
  }
  return String(count)
}

/**
 * Format a cost value for display (e.g., 0.003 → "$0.003", 1.5 → "$1.50")
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0'
  if (cost < 0.001) return `$${cost.toFixed(4)}`
  if (cost < 0.01) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}
