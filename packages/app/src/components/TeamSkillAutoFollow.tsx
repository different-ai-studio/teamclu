import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { isTauri } from '@/lib/utils'
import { isCloudAuthError } from '@/lib/backend/cloud-api/http'
import { RECONCILE_INTERVAL_MS } from '@/lib/skills/auto-follow'
import { useTeamShareBrowserStore } from '@/stores/team-share-browser'

/**
 * Keeps installed team skills on the version the team is running.
 *
 * Mounted app-wide rather than inside the team-share panel, because the members
 * this exists for are precisely the ones who never open that panel. A reconcile
 * that only ran while the UI was visible would leave everyone else on whatever
 * version they happened to install, which is the situation auto-follow replaces.
 *
 * Errors are swallowed on purpose. This is background maintenance the user did
 * not ask for; a toast about a failed sync while they are doing something else
 * is noise, and the next tick retries anyway. What the user does need to see —
 * a local edit blocking an update — surfaces in the skills panel as a conflict,
 * not as a transient error here.
 *
 * One thing does get announced: a skill the team deleted. That is not a
 * transient failure to retry, it is a pack that left this machine because of
 * somebody else's decision, and unlike a conflict it has no row left to surface
 * in. See the effect below.
 *
 * Auth (401 / expired session) is not transient: the next tick fails the same
 * way. Toast once per team so the 10-minute timer does not spam.
 */

const NO_RETIREMENTS: Record<string, never> = {}

export function TeamSkillAutoFollow({ teamId }: { teamId: string | null }) {
  const { t } = useTranslation()
  const reconcile = useTeamShareBrowserStore((s) => s.reconcileSkills)
  // Defaulted, and to a stable object: this component is mounted app-wide, so
  // it also renders against test doubles and partial store states that never
  // set the field. A fresh `{}` here would be a new identity every render.
  const retired = useTeamShareBrowserStore((s) => s.skillRetired) ?? NO_RETIREMENTS
  const dismissRetired = useTeamShareBrowserStore((s) => s.dismissRetired)
  // Announced once per slug per team. A ref rather than the store record,
  // because `kept` has to stay in the store for the detail pane to explain it —
  // clearing it on announce would take the explanation with it.
  const announced = React.useRef(new Set<string>())
  const authToastShown = React.useRef(false)

  // Paired with the store dropping `skillRetired` on the same switch: slugs are
  // unique per team, not globally, so team A's notices must not be announced
  // while the user is looking at team B.
  React.useEffect(() => {
    announced.current = new Set()
    authToastShown.current = false
  }, [teamId])

  /*
   * The one thing this component says out loud.
   *
   * Everything else here is background maintenance the user did not ask for and
   * does not need narrated. A deletion is the opposite: the skill is gone from
   * their machine, they did not do it, and the row it would have been explained
   * in has already disappeared with it. Said once, per skill, and only to
   * someone who actually had it installed — `skillRetired` is only ever written
   * for a pack that was on this disk.
   */
  React.useEffect(() => {
    for (const [slug, outcome] of Object.entries(retired)) {
      if (announced.current.has(slug)) continue
      announced.current.add(slug)
      if (outcome === 'removed') {
        toast.info(
          t('teamShare.skillRetiredToast', '「{{slug}}」已被团队移除，已从本机卸载。', { slug }),
        )
        // Nothing left to attach it to — the row is gone from every list.
        dismissRetired(slug)
      } else {
        toast.info(
          t(
            'teamShare.skillRetiredKeptToast',
            '「{{slug}}」已被团队移除。你改过它，所以本地副本保留了下来。',
            { slug },
          ),
        )
      }
    }
  }, [retired, dismissRetired, t])

  React.useEffect(() => {
    if (!teamId || !isTauri()) return
    let cancelled = false

    const run = () => {
      if (cancelled) return
      void reconcile().catch((e) => {
        if (!isCloudAuthError(e) || authToastShown.current) return
        authToastShown.current = true
        toast.error(
          t(
            'teamShare.skillAutoFollowSessionExpired',
            '登录已过期，团队技能无法自动同步。请重新登录。',
          ),
        )
      })
    }

    run()
    const timer = window.setInterval(run, RECONCILE_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [teamId, reconcile, t])

  return null
}

export default TeamSkillAutoFollow
