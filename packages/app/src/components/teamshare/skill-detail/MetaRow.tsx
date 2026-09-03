import { useTranslation } from 'react-i18next'
import { type TeamSkillItem } from '@/stores/team-share-browser'
import { formatShortDate } from './format'

export function MetaRow({ item, ownerLabel }: { item: TeamSkillItem; ownerLabel: string | null }) {
  const { t } = useTranslation()
  const primary: string[] = []
  if (item.kind === 'personal' && item.personalSourceLabel) primary.push(item.personalSourceLabel)
  if (item.category) primary.push(item.category)
  if (item.latestVersion) primary.push(`v${item.latestVersion}`)
  if (item.installed && item.installedVersion && item.installedVersion !== item.latestVersion) {
    primary.push(t('teamShare.skillInstalledVersion', 'installed v{{v}}', { v: item.installedVersion }))
  }
  if (item.requires?.length) {
    primary.push(t('teamShare.skillRequiresList', 'requires {{list}}', { list: item.requires.join(', ') }))
  }

  const secondary: string[] = []
  if (ownerLabel) {
    secondary.push(t('teamShare.skillOwner', 'Owner · {{name}}', { name: ownerLabel }))
  }
  const updated = formatShortDate(item.updatedAt)
  if (updated) {
    secondary.push(t('teamShare.skillUpdated', 'Updated {{date}}', { date: updated }))
  }

  if (!primary.length && !secondary.length) return null
  return (
    <div className="space-y-1 border-b border-border px-5 py-2 text-[12px] text-muted-foreground">
      {primary.length > 0 && <div>{primary.join(' · ')}</div>}
      {secondary.length > 0 && <div className="text-[11px] text-faint">{secondary.join(' · ')}</div>}
    </div>
  )
}
