import * as React from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'

const LucideIconSet = React.lazy(() => import('./lucide-icon-set'))

// `LucideProps` inherits the SVG `name` attribute; ours is the icon name.
interface LucideIconByNameProps extends Omit<LucideProps, 'name'> {
  /** PascalCase Lucide icon name (e.g. "ShoppingCart"). Full list: https://lucide.dev/icons */
  name: string | null | undefined
  /** Rendered while the icon set loads and when `name` is unknown or empty. */
  fallback: LucideIcon
}

/**
 * Renders a Lucide icon chosen by name at runtime.
 *
 * Name-based lookup needs the whole icon map, which is far too large to sit in
 * the startup bundle for the handful of shortcuts that use it. The map lives in
 * a lazily loaded chunk; until it arrives the fallback icon renders in its
 * place, so the row keeps its layout and the swap is a single repaint.
 */
export function LucideIconByName({ name, fallback: Fallback, ...props }: LucideIconByNameProps) {
  if (!name) return <Fallback {...props} />
  return (
    <React.Suspense fallback={<Fallback {...props} />}>
      <LucideIconSet name={name} fallback={Fallback} {...props} />
    </React.Suspense>
  )
}
