import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TEAM_SKILL_SUMMARY_MAX, clipTeamSkillSummary } from '@/lib/skills/team-skill-summary'
import { PublishVersionSheet } from '../PublishVersionSheet'
import type { TeamSkillItem } from '@/stores/team-share-browser'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}))

const longDescription =
  'Use when the user wants to get or query 抖音来客 (life.douyin.com) merchant order and 核销 data — e.g. asks about store orders, refunds, redemptions, or sales, or wants to set up scraping of their Douyin Life merchant account across stores and date ranges.'

const item: TeamSkillItem = {
  id: 'douyin-life-orders',
  slug: 'douyin-life-orders',
  name: 'douyin-life-orders',
  invocationName: 'douyin-life-orders',
  category: 'general',
  content: '',
  dirPath: '/skills/douyin-life-orders',
  filename: 'douyin-life-orders',
  origin: 'registry',
  kind: 'team-installed',
  personalSource: null,
  personalSourceLabel: null,
  summary: '抖音来客订单查询',
  whenToUse: null,
  whenNotToUse: null,
  requires: null,
  status: 'published',
  supersededBy: null,
  ownerActorId: 'actor-1',
  latestVersion: 1,
  installed: true,
  installedVersion: 1,
  hasUpdate: false,
  createdAt: null,
  updatedAt: null,
}

const loadPackPreview = async () => ({
  includedCount: 2,
  ignoredCount: 0,
  totalBytes: 1200,
  digest: 'sha256:abc',
  included: ['SKILL.md', 'scripts/run.sh'],
  ignored: [] as string[],
})

describe('PublishVersionSheet draft summary', () => {
  it('does not dump a long SKILL.md description into the summary field', async () => {
    render(
      <PublishVersionSheet
        item={item}
        nextVersion={2}
        baseVersion={1}
        open
        busy={false}
        onLoadDraftMetadata={async () => ({
          summary: longDescription,
          whenToUse: '',
          whenNotToUse: '',
          requires: [],
        })}
        onLoadPublishPreview={loadPackPreview}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('Reading draft metadata…')).toBeNull()
    })

    const summary = screen.getByDisplayValue('抖音来客订单查询') as HTMLInputElement
    expect(summary.value.length).toBeLessThanOrEqual(TEAM_SKILL_SUMMARY_MAX)
    expect(screen.getByDisplayValue(longDescription)).toBeTruthy()
    expect(screen.queryByText('Shortened to 200 characters so it can be published.')).toBeNull()
  })

  it('clips a long description when the registry has no short summary', async () => {
    render(
      <PublishVersionSheet
        item={{ ...item, summary: null }}
        nextVersion={2}
        baseVersion={1}
        open
        busy={false}
        onLoadDraftMetadata={async () => ({
          summary: longDescription,
          whenToUse: '',
          whenNotToUse: '',
          requires: [],
        })}
        onLoadPublishPreview={loadPackPreview}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('Reading draft metadata…')).toBeNull()
    })

    expect(screen.getByDisplayValue(clipTeamSkillSummary(longDescription))).toBeTruthy()
    expect(screen.getByDisplayValue(longDescription)).toBeTruthy()
    expect(screen.getByText('Shortened to 200 characters so it can be published.')).toBeTruthy()
  })
})
