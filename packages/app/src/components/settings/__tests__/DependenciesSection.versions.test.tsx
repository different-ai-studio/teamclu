import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('@/lib/utils', () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
  isTauri: () => true,
  copyToClipboard: vi.fn(),
}))

import { DependenciesSection } from '../DependenciesSection'
import { useDepsStore, type DependencyInfo } from '@/stores/deps'

const dep = (name: string, over: Partial<DependencyInfo> = {}): DependencyInfo => ({
  name,
  installed: true,
  version: '1.0.0',
  required: false,
  description: `${name} description`,
  install_commands: { macos: '', windows: '', linux: '' },
  affected_features: [],
  priority: 1,
  ...over,
})

/** The row for one dependency, found by its name cell. */
function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name)
  const row = label.closest('div.flex.items-start')
  if (!row) throw new Error(`no row for ${name}`)
  return row as HTMLElement
}

describe('DependenciesSection update affordance', () => {
  beforeEach(() => {
    useDepsStore.setState({
      dependencies: [dep('opencode', { version: '1.17.0' }), dep('pi', { version: '0.84.0' })],
      loading: false,
      installing: false,
      currentInstalling: null,
      installResults: {},
      installOutput: {},
      versions: {},
      checkDependencies: vi.fn(async () => {}),
      checkVersions: vi.fn(async () => {}),
      updateDependency: vi.fn(async () => {}),
      resetInstallState: vi.fn(),
    })
  })

  // The regression this exists for: `UpdateButton` read opencode's versions for
  // every row, so pi could not be listed here without being offered an update
  // labelled with opencode's version number.
  it('labels each runtime with its own available version', () => {
    useDepsStore.setState({
      versions: {
        opencode: { installed: '1.17.0', latest: '1.18.5', upToDate: false },
        pi: { installed: '0.84.0', latest: '0.84.2', upToDate: false },
      },
    })
    render(<DependenciesSection />)

    expect(within(rowFor('opencode')).getByRole('button', { name: '更新到 1.18.5' })).toBeTruthy()
    expect(within(rowFor('pi')).getByRole('button', { name: '更新到 0.84.2' })).toBeTruthy()
  })

  it('reports each runtime up to date independently', () => {
    useDepsStore.setState({
      versions: {
        opencode: { installed: '1.17.0', latest: '1.18.5', upToDate: false },
        pi: { installed: '0.84.2', latest: '0.84.2', upToDate: true },
      },
    })
    render(<DependenciesSection />)

    expect(within(rowFor('pi')).getByText('已是最新')).toBeTruthy()
    expect(within(rowFor('opencode')).queryByText('已是最新')).toBeNull()
  })

  // Reported: Dependencies showed pi 0.84.4 with a green "Up to date" while the
  // runtime picker refused it as "not installed". pi's own version was fine;
  // the MCP bridge amuxd installs beside its extension was missing, and the one
  // button that reinstalls it was the button "Up to date" had replaced.
  it('offers a repair instead of a green tick when the runtime is current but unusable', () => {
    useDepsStore.setState({
      versions: {
        pi: { installed: '0.84.4', latest: '0.84.4', upToDate: true, needsRepair: true },
      },
    })
    render(<DependenciesSection />)

    const row = rowFor('pi')
    expect(within(row).queryByText('已是最新')).toBeNull()
    expect(within(row).getByRole('button', { name: '修复' })).toBeTruthy()
    expect(within(row).getByText(/运行时有一部分缺失/)).toBeTruthy()
  })

  // A mirror we could not reach reports `upToDate: null`, and "unknown" must
  // not be shown as "you're current" — the update stays on offer.
  it('keeps offering the update when the available version is unknown', () => {
    useDepsStore.setState({ versions: {} })
    render(<DependenciesSection />)

    for (const name of ['opencode', 'pi']) {
      const row = within(rowFor(name))
      expect(row.getByRole('button', { name: '更新' })).toBeTruthy()
      expect(row.queryByText('已是最新')).toBeNull()
    }
  })

  it('offers an install, not an update, when a runtime is missing', () => {
    useDepsStore.setState({
      dependencies: [dep('pi', { installed: false, version: null })],
    })
    render(<DependenciesSection />)

    const row = within(rowFor('pi'))
    expect(row.getByRole('button', { name: '安装' })).toBeTruthy()
    expect(row.queryByRole('button', { name: /更新/ })).toBeNull()
  })
})
