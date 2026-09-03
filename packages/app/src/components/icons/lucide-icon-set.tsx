import { icons, type LucideIcon, type LucideProps } from 'lucide-react'

/**
 * The full Lucide icon map, behind a lazy boundary.
 *
 * `icons` re-exports every icon in the set (~1,700 modules, close to a third of
 * the startup chunk when it was imported statically). Only shortcuts need
 * name-based lookup, so this module — and with it the whole set — loads the
 * first time a shortcut with a custom icon renders. Import it through
 * `LucideIconByName`, never directly.
 */
function resolveLucideIcon(name: string | null | undefined): LucideIcon | null {
  if (!name) return null
  return name in icons ? icons[name as keyof typeof icons] : null
}

interface LucideIconSetProps extends Omit<LucideProps, 'name'> {
  name: string
  /** Rendered when `name` is not a Lucide icon. */
  fallback: LucideIcon
}

export default function LucideIconSet({ name, fallback: Fallback, ...props }: LucideIconSetProps) {
  const Icon = resolveLucideIcon(name) ?? Fallback
  return <Icon {...props} />
}
