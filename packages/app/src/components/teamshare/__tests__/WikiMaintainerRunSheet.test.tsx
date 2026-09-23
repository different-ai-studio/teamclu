import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { WikiMaintainerRunSheet } from '../WikiMaintainerRunSheet'

const MODELS = [
  { id: 'glm-4.6', name: '标准' },
  { id: 'glm-4-flash', name: '快速' },
]

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

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
  it('opens directly on a recovered cross-device publish summary', () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[]}
        initialSelected={[]}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        initialSummary={{
          runId: 'run-recovered',
          sourceCount: 2,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 0,
          visionPages: 0,
          estimatedCost: null,
          currency: 'CNY',
          canPublish: true,
          blockers: [],
        }}
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={vi.fn()}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('2 source files checked')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm publish' })).toBeEnabled()
  })

  it('does not compile until the user clicks Check and compile', async () => {
    const prepare = vi.fn()
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[
          { path: 'documents/features/', label: 'features' },
          { path: 'documents/spec-docs/', label: 'spec-docs' },
        ]}
        initialSelected={['documents/features/', 'documents/spec-docs/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={prepare}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('checkbox', { name: 'features' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'spec-docs' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Check and compile' })).toBeEnabled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('shows live compile steps while preparing', async () => {
    let resolvePrepare!: (value: unknown) => void
    const prepare = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePrepare = resolve
        }),
    )
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={prepare}
        onPublish={vi.fn()}
        onClose={vi.fn()}
        subscribeProgress={(handler) => {
          handler({ stage: 'plan' })
          handler({ stage: 'estimate' })
          handler({
            stage: 'ingest',
            action: 'add',
            path: 'documents/handbook/leave.md',
            current: 1,
            total: 3,
          })
          return () => {}
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(await screen.findByText('Compiling sources')).toBeTruthy()
    expect(screen.getByText('1 / 3 · compile · documents/handbook/leave.md')).toBeTruthy()
    resolvePrepare({
      runId: 'run-live',
      sourceCount: 3,
      retractCount: 0,
      added: 1,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 0,
      estimatedCost: 0,
      currency: 'CNY',
      canPublish: true,
      blockers: [],
    })
    expect(await screen.findByText('3 source files checked')).toBeTruthy()
  })

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
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={prepare}
        onPublish={publish}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'handbook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))

    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith('team-1', ['documents/handbook/'], 'glm-4.6'),
    )
    expect(await screen.findByText('4 source files checked')).toBeTruthy()
    expect(screen.getByText('2 pages added')).toBeTruthy()
    expect(screen.getByText('1 source failed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm publish' }))
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ runId: 'run-1' }),
        false,
      ),
    )
    expect(await screen.findByText('Published and synced')).toBeTruthy()
  })

  it('publishes pages that passed while failed sources stay listed', async () => {
    const publish = vi.fn().mockResolvedValue({ syncStatus: 'synced' })
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/features/', label: 'features' }]}
        initialSelected={['documents/features/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-partial',
          sourceCount: 2,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 1,
          visionPages: 0,
          estimatedCost: 0,
          currency: 'CNY',
          canPublish: true,
          blockers: ['documents/features/bad.md: quality gate'],
        })}
        onPublish={publish}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(await screen.findByText('documents/features/bad.md: quality gate')).toBeTruthy()
    expect(screen.getByText(/Pages that passed are saved/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm publish' }))
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ runId: 'run-partial' }),
        false,
      ),
    )
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
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
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

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
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
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
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
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({ runId: 'run-cost' }),
        true,
      ),
    )
  })

  it('compiles with the model the user picked', async () => {
    const prepare = vi.fn().mockResolvedValue({
      runId: 'run-model',
      sourceCount: 1,
      added: 1,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 0,
      estimatedCost: 0,
      currency: 'CNY',
      canPublish: true,
      blockers: [],
    })
    const saveModel = vi.fn()
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={saveModel}
        onPrepare={prepare}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'Compiler model' }), {
      target: { value: 'glm-4-flash' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    await waitFor(() =>
      expect(prepare).toHaveBeenCalledWith('team-1', ['documents/handbook/'], 'glm-4-flash'),
    )
    expect(saveModel).toHaveBeenCalledWith('team-1', 'glm-4-flash')
  })

  it('does not compile until a compiler model is available', () => {
    const prepare = vi.fn()
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        compilerModels={[]}
        initialCompilerModel=""
        onSaveSelection={vi.fn()}
        onPrepare={prepare}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Check and compile' })).toBeDisabled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('waits for an explicit model when the checkpoint compiler is missing', () => {
    const prepare = vi.fn()
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        compilerModels={MODELS}
        initialCompilerModel=""
        checkpointModel="missing-model"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={prepare}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(/does not have the model/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check and compile' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Compiler model' }), {
      target: { value: 'glm-4.6' },
    })
    expect(screen.getByRole('button', { name: 'Check and compile' })).toBeEnabled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('keeps a finished result publishable when the compiler model is missing', () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[]}
        initialSelected={[]}
        compilerModels={MODELS}
        initialCompilerModel=""
        checkpointModel="missing-model"
        initialSummary={{
          runId: 'run-recovered',
          sourceCount: 1,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 0,
          visionPages: 0,
          estimatedCost: null,
          currency: 'CNY',
          canPublish: true,
          blockers: [],
        }}
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn()}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByText(/does not have the model/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm publish' })).toBeEnabled()
  })
})
