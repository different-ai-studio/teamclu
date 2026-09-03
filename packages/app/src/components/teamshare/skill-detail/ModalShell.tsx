import * as React from 'react'
import { cn } from '@/lib/utils'

export function ModalShell({
  title,
  hint,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  footer: React.ReactNode
  onClose: () => void
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex max-h-[85vh] w-full flex-col overflow-hidden rounded-[14px] border border-border bg-paper shadow-lg',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
          {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </div>
  )
}
