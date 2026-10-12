import * as React from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getBackend } from '@/lib/backend'
import type { TeamJoinLink, TeamJoinLinkTtl } from '@/lib/backend/types'

interface TeamJoinLinkSectionProps {
  teamId: string
  onUpgradeRequired?: () => void
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown })?.status === 404
}

function isUpgradeRequired(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'upgrade_required'
}

const DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * DAY_MS
const THIRTY_DAYS_MS = 30 * DAY_MS

function inferTtl(row: TeamJoinLink): TeamJoinLinkTtl {
  if (row.expiresAt === null) return 'never'
  if (!row.createdAt) return '7d'
  const created = Date.parse(row.createdAt)
  const expires = Date.parse(row.expiresAt)
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return '7d'
  const duration = expires - created
  return Math.abs(duration - THIRTY_DAYS_MS) < Math.abs(duration - SEVEN_DAYS_MS) ? '30d' : '7d'
}

/** Empty → unlimited. A whole number ≥ 1 → that integer. Anything else → reject. */
function parseCap(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^[1-9]\d*$/.test(trimmed)) return { ok: false }
  return { ok: true, value: Number(trimmed) }
}

export function TeamJoinLinkSection({ teamId, onUpgradeRequired }: TeamJoinLinkSectionProps) {
  const [link, setLink] = React.useState<TeamJoinLink | null>(null)
  const [ttl, setTtl] = React.useState<TeamJoinLinkTtl>('7d')
  const [cap, setCap] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [boundTeamId, setBoundTeamId] = React.useState(teamId)

  if (boundTeamId !== teamId) {
    setBoundTeamId(teamId)
    setLink(null)
    setTtl('7d')
    setCap('')
    setLoadFailed(false)
    setLoading(true)
  }

  React.useEffect(() => {
    let cancelled = false
    setLink(null)
    setTtl('7d')
    setCap('')
    setLoadFailed(false)
    setLoading(true)
    void getBackend().teams.getTeamJoinLink(teamId)
      .then((row) => {
        if (cancelled) return
        setLink(row)
        setTtl(inferTtl(row))
        setCap(row.maxUses == null ? '' : String(row.maxUses))
        setLoadFailed(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (isNotFound(error)) {
          setLink(null)
          setLoadFailed(false)
          return
        }
        setLink(null)
        setLoadFailed(true)
        const msg = error instanceof Error ? error.message : String(error)
        toast.error(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId])

  const put = async (input: { ttl: TeamJoinLinkTtl; maxUses: number | null; rotate: boolean }) => {
    setBusy(true)
    try {
      const row = await getBackend().teams.putTeamJoinLink(teamId, input)
      setLink(row)
      setTtl(input.ttl)
    } catch (error) {
      if (isUpgradeRequired(error)) {
        onUpgradeRequired?.()
        return
      }
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const onTtlChange = (next: TeamJoinLinkTtl) => {
    setTtl(next)
    const parsed = parseCap(cap)
    if (link && parsed.ok) void put({ ttl: next, maxUses: parsed.value, rotate: false })
  }

  const onCapChange = (raw: string) => {
    setCap(raw)
    const parsed = parseCap(raw)
    if (link && parsed.ok) void put({ ttl, maxUses: parsed.value, rotate: false })
  }

  const copyUrl = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
    } catch {
      toast.error('复制失败')
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      await getBackend().teams.revokeTeamJoinLink(teamId)
      setLink(null)
      setCap('')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return null

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-col gap-2">
        <label className="block text-xs font-medium text-muted-foreground">有效期</label>
        <select
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={ttl}
          disabled={busy}
          onChange={(e) => onTtlChange(e.target.value as TeamJoinLinkTtl)}
        >
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
          <option value="never">不限期</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">人数上限（可选）</label>
        <Input
          type="number"
          min={1}
          value={cap}
          disabled={busy}
          onChange={(e) => onCapChange(e.target.value)}
        />
      </div>

      {link ? (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">加入链接</label>
            <div className="flex items-center gap-2">
              <Input value={link.url} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={() => void copyUrl()} title="复制">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex justify-center">
            <QRCodeSVG value={link.url} size={128} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            <span>{link.useCount}</span>
            {' · '}
            <span>{link.status}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void revoke()}>
              作废
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const parsed = parseCap(cap)
                if (parsed.ok) void put({ ttl, maxUses: parsed.value, rotate: true })
              }}
            >
              换一条新链接
            </Button>
          </div>
        </>
      ) : loadFailed ? null : (
        <Button
          disabled={busy}
          onClick={() => {
            const parsed = parseCap(cap)
            if (parsed.ok) void put({ ttl, maxUses: parsed.value, rotate: false })
          }}
        >
          生成链接
        </Button>
      )}
    </div>
  )
}
