import { ExternalLink, FileText, Folder, type LucideIcon } from 'lucide-react'
import type { ShortcutNode } from '@/stores/shortcuts'

/** Icon for a shortcut that has no icon of its own. */
export function resolveFallbackIcon(node: ShortcutNode): LucideIcon {
  if (node.type === 'folder') return Folder
  if (node.type === 'native') return FileText
  return ExternalLink
}
