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

/**
 * pi is the managed runtime and the one row with an in-app updater (#1250);
 * Node.js is installed with it and repaired through it, so its row carries no
 * update button of its own.
 */
describe('DependenciesSection update affordance', () => {
  beforeEach(() => {
    useDepsStore.setState({
      dependencies: [
        dep('node', { version: '24.20.0', required: true }),
        dep('pi', { version: '0.84.0', required: true }),
      ],
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

  it('labels pi with its available version', () => {
    useDepsStore.setState({
      versions: {
        pi: { installed: '0.84.0', latest: '0.84.2', upToDate: false },
      },
    })
    render(<DependenciesSection />)

    expect(within(rowFor('pi')).getByRole('button', { name: '更新到 0.84.2' })).toBeTruthy()
    // Node is updated as part of pi, never on its own.
    expect(within(rowFor('node')).queryByRole('button', { name: /更新/ })).toBeNull()
  })

  it('reports pi up to date', () => {
    useDepsStore.setState({
      versions: {
        pi: { installed: '0.84.2', latest: '0.84.2', upToDate: true },
      },
    })
    render(<DependenciesSection />)

    expect(within(rowFor('pi')).getByText('已是最新')).toBeTruthy()
  })

  // Reported: Dependencies showed pi 0.84.4 with a green "Up to date" while the
  // runtime was unusable — the MCP bridge was missing, and the one button that
  // reinstalls it was the button "Up to date" had replaced.
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

  // An unanswered doctor reports `upToDate: null`, and "unknown" must not be
  // shown as "you're current" — the update stays on offer.
  it('keeps offering the update when the available version is unknown', () => {
    useDepsStore.setState({ versions: {} })
    render(<DependenciesSection />)

    const row = within(rowFor('pi'))
    expect(row.getByRole('button', { name: '更新' })).toBeTruthy()
    expect(row.queryByText('已是最新')).toBeNull()
  })

  it('offers an install, not an update, when the runtime is missing', () => {
    useDepsStore.setState({
      dependencies: [dep('pi', { installed: false, version: null })],
    })
    render(<DependenciesSection />)

    const row = within(rowFor('pi'))
    expect(row.getByRole('button', { name: '安装' })).toBeTruthy()
    expect(row.queryByRole('button', { name: /更新/ })).toBeNull()
  })
})
