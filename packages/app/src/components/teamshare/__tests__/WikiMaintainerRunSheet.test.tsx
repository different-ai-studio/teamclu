import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { WikiMaintainerRunSheet } from '../WikiMaintainerRunSheet'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
      if (typeof fallback !== 'string') return _key
      return Object.entries(vars ?? {}).reduce(
        (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
        fallback,
      )
    },
  }),
}))

describe('WikiMaintainerRunSheet', () => {
  it('selects source folders once, compiles, shows a human summary, then publishes', async () => {
    const prepare = vi.fn().mockResolvedValue({
      runId: 'run-1',
      sourceCount: 4,
      added: 2,
      updated: 1,
      deleted: 0,
      failed: 1,
      visionPages: 0,
      estimatedCost: 0,
      currency: 'CNY',
      canPublish: true,
      blockers: [],
    })
    const publish = vi.fn().mockResolvedValue({ syncStatus: 'synced' })

    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[
          { path: 'documents/handbook/', label: 'handbook' },
          { path: 'documents/training/', label: 'training' },
        ]}
        initialSelected={[]}
        onSaveSelection={vi.fn()}
        onPrepare={prepare}
        onPublish={publish}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'handbook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))

    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith('team-1', ['documents/handbook/']),
    )
    expect(await screen.findByText('4 source files checked')).toBeTruthy()
    expect(screen.getByText('2 pages added')).toBeTruthy()
    expect(screen.getByText('1 source failed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm publish' }))
    await waitFor(() => expect(publish).toHaveBeenCalledWith('run-1', false))
    expect(await screen.findByText('Published and synced')).toBeTruthy()
  })

  it('blocks publishing when quality checks fail', async () => {
    const publish = vi.fn()
    const cancel = vi.fn().mockResolvedValue(undefined)
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-2',
          sourceCount: 1,
          added: 0,
          updated: 0,
          deleted: 0,
          failed: 1,
          visionPages: 0,
          estimatedCost: 0,
          currency: 'CNY',
          canPublish: false,
          blockers: ['Source ACL is not team-public'],
        })}
        onPublish={publish}
        onCancel={cancel}
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('Source ACL is not team-public')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm publish' })).toBeDisabled()
    expect(publish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Change source folders' }))
    expect(screen.getByRole('checkbox', { name: 'handbook' })).toBeTruthy()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('requires explicit cost confirmation before publish', async () => {
    const publish = vi.fn().mockResolvedValue({ syncStatus: 'synced' })
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={[]}
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-cost',
          sourceCount: 1,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 0,
          visionPages: 2,
          estimatedCost: 0.24,
          currency: 'CNY',
          canPublish: true,
          blockers: [],
        })}
        onPublish={publish}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'handbook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))

    const publishButton = await screen.findByRole('button', { name: 'Confirm publish' })
    expect(publishButton).toBeDisabled()
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Accept estimated vision cost' }),
    )
    expect(publishButton).toBeEnabled()
    fireEvent.click(publishButton)
    await waitFor(() => expect(publish).toHaveBeenCalledWith('run-cost', true))
  })
})
