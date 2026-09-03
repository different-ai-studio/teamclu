import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}))
vi.mock('@/stores/cron', () => ({
  useCronStore: vi.fn(() => ({
    addJob: vi.fn(),
    updateJob: vi.fn(),
    runJob: vi.fn(),
  })),
}))
vi.mock('@/stores/channels-store', () => ({
  useChannelsStore: vi.fn(() => ({
    discord: null,
    feishu: null,
    email: null,
    kook: null,
    wecom: null,
  })),
}))
vi.mock('@/stores/provider', () => ({
  useProviderStore: vi.fn(() => ({
    models: [],
    providers: [],
    configuredProviders: [],
    refreshConfiguredProviders: vi.fn(),
  })),
}))
vi.mock('@/lib/utils', () => ({ cn: (...a: string[]) => a.join(' ') }))
vi.mock('../../shared', () => ({
  ToggleSwitch: ({ enabled }: { enabled: boolean }) => <input type="checkbox" checked={enabled} readOnly />,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => null,
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: any) => <textarea {...props} />,
}))

import { CronJobDialog } from '../CronJobDialog'

describe('CronJobDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CronJobDialog open={false} onOpenChange={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('does not render the deprecated timeout field when editing a legacy job', () => {
    const now = new Date().toISOString()
    const { queryByText } = render(
      <CronJobDialog
        open
        onOpenChange={vi.fn()}
        editJob={{
          id: 'job-1',
          name: 'Legacy job',
          enabled: true,
          schedule: { kind: 'every', everyMs: 30 * 60 * 1000 },
          payload: {
            message: 'legacy',
            timeoutSeconds: 30,
          },
          deleteAfterRun: false,
          createdAt: now,
          updatedAt: now,
        }}
      />
    )

    expect(queryByText('Timeout (seconds)')).toBeNull()
    expect(queryByText(/Auto-aborts if exceeded/)).toBeNull()
  })

  // Every automation entry point pins a model at creation time (ADR-0007).
  // "Use default model" resolved at run time against the device MRU, so the
  // same job ran on whatever model that device last happened to use.
  it('offers no "use default model" escape hatch', () => {
    const { queryByText } = render(
      <CronJobDialog open onOpenChange={vi.fn()} />
    )
    expect(queryByText('Use default model')).toBeNull()
    expect(queryByText('Select a model')).not.toBeNull()
  })
})
