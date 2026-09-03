import { useTranslation } from 'react-i18next'
import { type TeamSkillItem } from '@/stores/team-share-browser'

export function UsageBoundary({ item }: { item: TeamSkillItem }) {
  const { t } = useTranslation()
  if (!item.whenToUse && !item.whenNotToUse) return null
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-border px-5 py-4 sm:grid-cols-2">
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillWhenToUse', 'When to use')}
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {item.whenToUse || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </section>
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {t('teamShare.skillWhenNotToUse', 'When not to use')}
        </h3>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {item.whenNotToUse || t('teamShare.skillFieldEmpty', '—')}
        </p>
      </section>
    </div>
  )
}
