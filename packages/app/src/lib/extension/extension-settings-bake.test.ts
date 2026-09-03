import { describe, expect, it } from 'vitest'
import {
  parseExtensionPackConfig,
  parseExtensionSettingsBake,
  toSidePanelDomain,
} from '@/lib/extension/extension-settings-bake'

describe('parseExtensionSettingsBake', () => {
  it('defaults to visible settings button and empty link-hover lists', () => {
    expect(parseExtensionSettingsBake(undefined)).toEqual({
      hideButton: false,
      linkHover: { domains: [], urlPatterns: [] },
    })
  })

  it('parses hideButton and linkHover defaults', () => {
    expect(
      parseExtensionSettingsBake({
        hideButton: true,
        linkHover: {
          domains: [' accounting.i.shopee.io '],
          urlPatterns: ['*/discrepancy-details-info-v2/*', ''],
        },
      }),
    ).toEqual({
      hideButton: true,
      linkHover: {
        domains: ['accounting.i.shopee.io'],
        urlPatterns: ['*/discrepancy-details-info-v2/*'],
      },
    })
  })
})

describe('parseExtensionPackConfig', () => {
  it('parses solo and domains', () => {
    expect(
      parseExtensionPackConfig({
        solo: true,
        domains: ['*.shopee.io', 'https://accounting.i.shopee.io/*'],
        settings: { hideButton: true },
      }),
    ).toEqual({
      solo: true,
      domains: ['*.shopee.io', 'accounting.i.shopee.io'],
      settings: {
        hideButton: true,
        linkHover: { domains: [], urlPatterns: [] },
      },
      teamOnboarding: {
        autoCreateTeam: true,
        noTeamMessage: {},
      },
    })
  })

  it('parses the extension-only team onboarding policy', () => {
    expect(
      parseExtensionPackConfig({
        teamOnboarding: {
          autoCreateTeam: false,
          noTeamMessage: {
            'zh-CN': ' 请联系管理员邀请你加入团队。 ',
            en: ' Ask an administrator for an invite. ',
            empty: '   ',
            invalid: 42,
          },
        },
      }),
    ).toMatchObject({
      teamOnboarding: {
        autoCreateTeam: false,
        noTeamMessage: {
          'zh-CN': '请联系管理员邀请你加入团队。',
          en: 'Ask an administrator for an invite.',
        },
      },
    })
  })

  it('keeps automatic team creation enabled when the policy is omitted', () => {
    expect(parseExtensionPackConfig(undefined).teamOnboarding).toEqual({
      autoCreateTeam: true,
      noTeamMessage: {},
    })
  })
})

describe('toSidePanelDomain', () => {
  it('strips chrome match patterns', () => {
    expect(toSidePanelDomain('https://*.shopee.io/*')).toBe('*.shopee.io')
    expect(toSidePanelDomain('Accounting.i.Shopee.io')).toBe('accounting.i.shopee.io')
  })
})
