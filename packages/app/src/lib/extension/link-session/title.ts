export function linkSessionTitle(linkText: string, now = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const suffix = ` (${pad(now.getHours())}:${pad(now.getMinutes())})`
  const maxText = Math.max(1, 80 - suffix.length)
  const label = linkText.trim().slice(0, maxText) || 'Link chat'
  return `${label}${suffix}`
}
