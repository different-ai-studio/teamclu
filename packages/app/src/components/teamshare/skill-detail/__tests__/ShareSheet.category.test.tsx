import * as React from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import en from '@/locales/en.json'
import zh from '@/locales/zh-CN.json'
import type { TeamSkillItem } from '@/stores/team-share-browser'
import { ShareSheet } from '../ShareSheet'
import { MetaRow } from '../MetaRow'

const i18n = i18next.createInstance()
await i18n.init({
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zh },
  },
  interpolation: { escapeValue: false },
})

const ZH_LABELS = ['通用', '编程', '运维', '数据', '研究', '写作', '沟通', '集成']
const EN_LABELS = ['General', 'Coding', 'DevOps', 'Data', 'Research', 'Writing', 'Communication', 'Integration']

beforeAll(() => {
  // Radix Select calls these on pointerdown. jsdom does not implement them.
  const proto = Element.prototype as Element & {
    hasPointerCapture?: (pointerId: number) => boolean
    setPointerCapture?: (pointerId: number) => void
    releasePointerCapture?: (pointerId: number) => void
  }
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
})

function item(overrides: Partial<TeamSkillItem> = {}): TeamSkillItem {
  return {
    id: 'personal:cost-table',
    slug: 'cost-table',
    name: '物流运输成本预估（整车）',
    invocationName: 'cost-table',
    category: null,
    content: '',
    dirPath: '/skills',
    filename: 'cost-table',
    origin: 'personal',
    kind: 'personal',
    personalSource: 'global-agent',
    personalSourceLabel: 'Agent',
    summary: '物流运输成本预估（整车）。',
    whenToUse: '',
    whenNotToUse: '',
    requires: null,
    status: null,
    supersededBy: null,
    ownerActorId: null,
    latestVersion: null,
    installed: true,
    installedVersion: null,
    hasUpdate: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function renderShare(overrides: Partial<TeamSkillItem> = {}) {
  const onSubmit = vi.fn(async () => {})
  render(
    <I18nextProvider i18n={i18n}>
      <ShareSheet
        item={item(overrides)}
        open
        busy={false}
        takenSlugs={new Set()}
        onClose={() => {}}
        onSubmit={onSubmit}
      />
    </I18nextProvider>,
  )
  return onSubmit
}

describe('ShareSheet category labels', () => {
  beforeEach(async () => {
    cleanup()
    await i18n.changeLanguage('zh-CN')
  })

  it('shows Chinese labels in a Chinese UI and submits the stored slug', async () => {
    const onSubmit = renderShare({ category: 'general' })
    const user = userEvent.setup()

    expect(screen.getByRole('combobox')).toHaveTextContent('通用')
    expect(screen.queryByText('general')).toBeNull()

    await user.click(screen.getByRole('combobox'))
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent?.trim())).toEqual(ZH_LABELS)
    for (const slug of ['general', 'coding', 'devops', 'data', 'research', 'writing', 'communication', 'integration']) {
      expect(screen.queryByRole('option', { name: slug })).toBeNull()
    }

    await user.click(screen.getByRole('option', { name: '编程' }))
    expect(screen.getByRole('combobox')).toHaveTextContent('编程')

    await user.click(screen.getByRole('button', { name: '分享并安装' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ category: 'coding' }))
    const submitted = onSubmit.mock.calls[0]?.[0] as { category: string }
    expect(submitted.category).not.toBe('编程')
  })

  it('shows English labels in an English UI and still submits the slug', async () => {
    await i18n.changeLanguage('en')
    const onSubmit = renderShare({ category: 'data' })
    const user = userEvent.setup()

    expect(screen.getByRole('combobox')).toHaveTextContent('Data')
    await user.click(screen.getByRole('combobox'))
    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual(EN_LABELS)

    await user.click(screen.getByRole('option', { name: 'Integration' }))
    await user.click(screen.getByRole('button', { name: 'Share & install' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ category: 'integration' }))
  })

  it('keeps an untouched category id when the sheet is submitted', async () => {
    const onSubmit = renderShare({ category: 'devops' })
    expect(screen.getByRole('combobox')).toHaveTextContent('运维')
    await userEvent.click(screen.getByRole('button', { name: '分享并安装' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ category: 'devops' }))
  })
})

describe('MetaRow category label', () => {
  beforeEach(async () => {
    cleanup()
    await i18n.changeLanguage('zh-CN')
  })

  it('renders the localized category on the skill detail line', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MetaRow item={item({ category: 'research' })} ownerLabel={null} />
      </I18nextProvider>,
    )
    expect(screen.getByText(/研究/)).toBeTruthy()
    expect(screen.queryByText(/research/)).toBeNull()

    await i18n.changeLanguage('en')
    expect(await screen.findByText(/Research/)).toBeTruthy()
    expect(screen.queryByText(/研究/)).toBeNull()
  })

  it('shows a category outside the fixed set as stored', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MetaRow item={item({ category: 'custom-pack' })} ownerLabel={null} />
      </I18nextProvider>,
    )
    expect(screen.getByText(/custom-pack/)).toBeTruthy()
  })
})
