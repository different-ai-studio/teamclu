import { useSessionNoticeStore, type SessionNotice } from '@/stores/session-notice-store'

type Props = {
  sessionId: string | null
}

/** Stable fallback — `?? []` in a zustand selector creates a new ref every call → infinite re-renders. */
const EMPTY_NOTICES: SessionNotice[] = []

export function SessionNoticeList({ sessionId }: Props) {
  const notices = useSessionNoticeStore((s) =>
    sessionId ? (s.bySession[sessionId] ?? EMPTY_NOTICES) : EMPTY_NOTICES,
  )
  if (!sessionId || notices.length === 0) return null

  return (
    <div className="space-y-2 px-[26px] pb-2" data-testid="session-notice-list">
      {notices.map((n) => (
        <div
          key={n.id}
          className="border-l border-border-soft pl-3 text-[12px] leading-relaxed text-faint"
          role="status"
        >
          {n.text}
        </div>
      ))}
    </div>
  )
}
