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
        true,
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
        true,
      ),
    )
  })

  it('collapses a wall of identical compiler skips into one notice', async () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/seahelm-log/', label: 'seahelm-log' }]}
        initialSelected={['documents/seahelm-log/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-skip-wall',
          sourceCount: 3,
          added: 0,
          updated: 0,
          deleted: 0,
          failed: 3,
          visionPages: 0,
          estimatedCost: 0,
          currency: 'CNY',
          canPublish: false,
          blockers: [
            'documents/seahelm-log/a.txt: The compiler did not write a Wiki page for this source.',
            'documents/seahelm-log/b.txt: The compiler did not write a Wiki page for this source.',
            'documents/features/09-apps-platform.md: The compiler did not write a Wiki page for this source.',
          ],
        })}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(
      await screen.findByText(
        'The compiler finished without writing Wiki pages for 3 sources. Try another compiler model, then compile again.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('documents/seahelm-log/a.txt')).toBeTruthy()
    expect(screen.getByText('documents/features/09-apps-platform.md')).toBeTruthy()
    expect(
      screen.queryByText(/This source was skipped this run and will be compiled again next time/),
    ).toBeNull()
    expect(
      screen.getByText(
        'Review the result, then confirm publish. Nothing is written to the knowledge base until you confirm.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm publish' })).toBeDisabled()
  })

  it('blocks publish when a deleted source is still cited', async () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-retract-failed',
          sourceCount: 1,
          retractCount: 0,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 1,
          visionPages: 0,
          estimatedCost: 0,
          currency: 'CNY',
          canPublish: false,
          blockers: [
            'A deleted source is still cited. Compile again before publishing.',
            'documents/handbook/gone.md: This source was skipped this run and will be compiled again next time.',
          ],
        })}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(
      await screen.findByText(
        'A deleted source is still cited. Compile again before publishing.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/deleted sources retracted/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm publish' })).toBeDisabled()
  })

  it('reports restricted folders as counts and blocks publish while restricted content remains', async () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/handbook/', label: 'handbook' }]}
        initialSelected={['documents/handbook/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-restricted',
          sourceCount: 1,
          retractCount: 0,
          restrictedPrefixes: ['documents/handbook/secret/'],
          restrictedFolderCount: 1,
          restrictedRetractCount: 2,
          added: 0,
          updated: 1,
          deleted: 0,
          failed: 1,
          visionPages: 0,
          estimatedCost: 0,
          currency: 'CNY',
          canPublish: false,
          blockers: ['Restricted content is still in the Wiki. Compile again before publishing.'],
        })}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(await screen.findByText('1 restricted folders were not compiled.')).toBeTruthy()
    expect(screen.getByText('Removed content from 2 restricted sources.')).toBeTruthy()
    expect(
      screen.getByText('Restricted content is still in the Wiki. Compile again before publishing.'),
    ).toBeTruthy()
    expect(screen.queryByText(/secret/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm publish' })).toBeDisabled()
  })

  it('shows the compiler model error instead of a skip sentence', async () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/seahelm-log/', label: 'seahelm-log' }]}
        initialSelected={['documents/seahelm-log/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onPrepare={vi.fn().mockResolvedValue({
          runId: 'run-model-error',
          sourceCount: 1,
          added: 0,
          updated: 0,
          deleted: 0,
          failed: 1,
          visionPages: 0,
          estimatedCost: 0,
          currency: 'CNY',
          canPublish: false,
          blockers: [
            'documents/seahelm-log/a.txt: Compiler model failed: 429 Too Many Requests',
          ],
        })}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(
      await screen.findByText(
        'documents/seahelm-log/a.txt: Compiler model failed: 429 Too Many Requests',
      ),
    ).toBeTruthy()
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

  it('asks for the vision cost before compiling', async () => {
    const publish = vi.fn().mockResolvedValue({ syncStatus: 'synced' })
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({
        runId: 'run-quote',
        sourceCount: 1,
        added: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        visionPages: 1,
        estimatedCost: 0.12,
        currency: 'CNY',
        canPublish: false,
        blockers: [],
        needsVisionAcceptance: true,
      })
      .mockResolvedValueOnce({
        runId: 'run-done',
        sourceCount: 1,
        added: 1,
        updated: 0,
        deleted: 0,
        failed: 0,
        visionPages: 1,
        estimatedCost: 0.12,
        currency: 'CNY',
        canPublish: true,
        blockers: [],
      })
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
        onPublish={publish}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    expect(
      await screen.findByText(
        '1 pages need visual recognition, estimated 0.12 CNY. Agree to send them to the current model. If it cannot read images, those files fail and the rest still compile.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm publish' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Agree and compile' }))
    expect(await screen.findByRole('button', { name: 'Confirm publish' })).toBeEnabled()
    expect(prepare).toHaveBeenLastCalledWith(
      'team-1',
      ['documents/handbook/'],
      'glm-4.6',
      'accept',
    )
    expect(screen.queryByRole('checkbox', { name: 'Accept estimated vision cost' })).toBeNull()
  })

  it('asks how to handle each large file before compiling, then compiles with the answers', async () => {
    const table = 'documents/营运部/整车成本_已拆分司机信息.csv'
    const longText = 'documents/营运部/会议纪要.txt'
    const base = {
      sourceCount: 3,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 0,
      estimatedCost: null,
      currency: 'CNY',
      blockers: [],
    }
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({
        ...base,
        runId: 'run-ask',
        added: 0,
        canPublish: false,
        needsLargeSourceDecision: true,
        largeSources: [
          {
            path: table,
            chars: 186000,
            limit: 50000,
            kind: 'table',
            encoding: 'gb18030',
            parts: 6,
            maxParts: 20,
            options: ['profile', 'segment', 'skip'],
            defaultChoice: 'profile',
          },
          {
            path: longText,
            chars: 64000,
            limit: 50000,
            kind: 'document',
            parts: 0,
            maxParts: 20,
            reason: 'no_breaks',
            options: ['skip'],
            defaultChoice: 'skip',
          },
        ],
      })
      .mockResolvedValueOnce({ ...base, runId: 'run-done', added: 3, canPublish: true })
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[{ path: 'documents/营运部/', label: '营运部' }]}
        initialSelected={['documents/营运部/']}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={prepare}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))

    expect(await screen.findByText(/2 files are too long to compile at once/)).toBeTruthy()
    expect(screen.getByText('186,000 / 50,000 chars')).toBeTruthy()
    expect(screen.getByText(`${table} · GB18030`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm publish' })).toBeNull()
    const profile = screen.getByRole('radio', {
      name: '整车成本_已拆分司机信息.csv: Summarize the table structure only',
    })
    expect(profile).toBeChecked()
    expect(screen.getByText('6 parts, 6 model calls.')).toBeTruthy()
    const textParts = screen.getByRole('radio', { name: '会议纪要.txt: Compile in parts' })
    expect(textParts).toBeDisabled()
    expect(screen.getByText('No pages, rows, or headings to split at.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '会议纪要.txt: Skip this run' })).toBeChecked()

    fireEvent.click(
      screen.getByRole('radio', { name: '整车成本_已拆分司机信息.csv: Compile in parts' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compile as chosen' }))

    expect(await screen.findByRole('button', { name: 'Confirm publish' })).toBeEnabled()
    expect(prepare).toHaveBeenLastCalledWith(
      'team-1',
      ['documents/营运部/'],
      'glm-4.6',
      undefined,
      { [table]: 'segment', [longText]: 'skip' },
    )
  })

  it('keeps the vision answer when the large-file step comes after it', async () => {
    const source = 'documents/handbook/big.md'
    const base = {
      sourceCount: 1,
      updated: 0,
      deleted: 0,
      failed: 0,
      visionPages: 1,
      estimatedCost: 0.12,
      currency: 'CNY',
      blockers: [],
    }
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ...base, runId: 'r1', added: 0, canPublish: false, needsVisionAcceptance: true })
      .mockResolvedValueOnce({
        ...base,
        runId: 'r2',
        added: 0,
        canPublish: false,
        needsLargeSourceDecision: true,
        largeSources: [
          {
            path: source,
            chars: 90000,
            limit: 50000,
            kind: 'document',
            parts: 3,
            maxParts: 20,
            options: ['segment', 'skip'],
            defaultChoice: 'segment',
          },
        ],
      })
      .mockResolvedValueOnce({ ...base, runId: 'r3', added: 1, canPublish: true })
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
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check and compile' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Agree and compile' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Compile as chosen' }))
    expect(await screen.findByRole('button', { name: 'Confirm publish' })).toBeEnabled()
    expect(prepare).toHaveBeenLastCalledWith(
      'team-1',
      ['documents/handbook/'],
      'glm-4.6',
      'accept',
      { [source]: 'segment' },
    )
  })

  it('explains an over-long source and a failed part in plain words', () => {
    render(
      <WikiMaintainerRunSheet
        open
        teamId="team-1"
        sourceDirectories={[]}
        initialSelected={[]}
        compilerModels={MODELS}
        initialCompilerModel="glm-4.6"
        initialSummary={{
          runId: 'run-x',
          sourceCount: 2,
          added: 1,
          updated: 0,
          deleted: 0,
          failed: 2,
          visionPages: 0,
          estimatedCost: null,
          currency: 'CNY',
          canPublish: true,
          blockers: [
            'documents/a.txt: This source is too long after extraction (64000 characters, limit 50000). Split it into shorter files, then compile again.',
            'documents/b.csv: Part 3 of 12 failed: Compiler model failed: 429 Too Many Requests The 2 parts before it were kept, and the whole source compiles again next time.',
          ],
        }}
        onSaveSelection={vi.fn()}
        onSaveCompilerModel={vi.fn()}
        onPrepare={vi.fn()}
        onPublish={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByText(
        'documents/a.txt: This source is too long after extraction (64,000 characters, limit 50,000). Split it into shorter files, then compile again.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'documents/b.csv: Part 3 of 12 failed: Compiler model failed: 429 Too Many Requests The 2 parts before it were kept, and the whole source compiles again next time.',
      ),
    ).toBeTruthy()
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
