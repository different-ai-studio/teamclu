import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CreateAppDialog, isValidGitRemoteUrl } from '../CreateAppDialog'

const t = (_k: string, fallback?: string) => fallback ?? _k

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}))

// Mock the Dialog wrapper so the test never mounts Radix FocusScope/portal —
// mirrors IdeaDetailDialog.test.tsx and sidesteps any jsdom focus loop entirely.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

// The name field is selected by role, not by placeholder copy: `t` is mocked
// to return the fallback string, so a placeholder reword breaks every test
// that reaches the form. It already did — this suite went red on the copy
// change in #626, not on a behaviour change.
const createMock = vi.fn()
const refreshLocalAppsMock = vi.fn()
const inspectDirMock = vi.fn()
const bindWorkdirMock = vi.fn()
const pickDirMock = vi.fn()

vi.mock('@/stores/apps-store', () => ({
  useAppsStore: {
    getState: () => ({ create: createMock, refreshLocalApps: refreshLocalAppsMock }),
  },
}))

vi.mock('@/lib/daemon/daemon-local-client', () => ({
  inspectDaemonDir: (...args: unknown[]) => inspectDirMock(...args),
  bindDaemonAppWorkdir: (...args: unknown[]) => bindWorkdirMock(...args),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return { ...actual, isTauri: () => true }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => pickDirMock(...args),
}))

beforeEach(() => {
  createMock.mockReset()
  createMock.mockResolvedValue({ id: 'app-1', name: 'My app' })
  refreshLocalAppsMock.mockReset()
  refreshLocalAppsMock.mockResolvedValue(undefined)
  inspectDirMock.mockReset()
  bindWorkdirMock.mockReset()
  bindWorkdirMock.mockResolvedValue({ workdir: '/repo', gitRemoteUrl: null })
  pickDirMock.mockReset()
})

/** The name input — the source-specific fields appear once a source is chosen. */
const nameField = () => screen.getByLabelText('Name')
const repoField = () => screen.getByLabelText('Repository URL')
// Matched on the Chinese fallbacks: `t` is mocked to return the fallback, and
// these rows carry Chinese ones to match the APP_TYPES rows beside them.
/** Switch to "clone from a git address", which reveals the repo field. */
const chooseRemoteSource = () =>
  fireEvent.click(screen.getByRole('radio', { name: /从 git 地址克隆/ }))
/** Switch to "use a directory on this machine", which reveals the picker. */
const chooseLocalSource = () =>
  fireEvent.click(screen.getByRole('radio', { name: /用本机已有的目录/ }))

describe('CreateAppDialog', () => {
  it('submits trimmed name + literal type + default visibility, then closes', async () => {
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: '  My app  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith({
      teamId: 'team-1',
      name: 'My app',
      // Pinned deliberately: this is DEFAULT_APP_TYPE, and an unintended
      // change to it silently alters what every new app gets built as.
      // `fullstack_tanstack_postgres` is now LEGACY_DATA_APP_TYPE — the id
      // stored on apps created before the type split, never a new default.
      type: 'static_web',
      visibility: 'personal',
      // No repo typed → null, not undefined: "seed from the template" is a
      // decision the create call states, not one the API infers.
      gitRemoteUrl: null,
      // Stated, not inferred: "the code is already on this machine" is the one
      // thing that stops the server provisioning a repo and the desktop writing
      // a template over it.
      localOnly: false,
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('submit is disabled with an empty name', () => {
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('submits team visibility when the team radio is selected', async () => {
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Shared app' } })
    fireEvent.click(screen.getByDisplayValue('team'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'team', name: 'Shared app' }),
    )
  })

  it('keeps the dialog open and shows an error when create fails', async () => {
    createMock.mockRejectedValueOnce(new Error('boom'))
    const onOpenChange = vi.fn()
    render(<CreateAppDialog open onOpenChange={onOpenChange} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'My app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('passes an optional repo URL through, trimmed', async () => {
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Imported' } })
    chooseRemoteSource()
    fireEvent.change(repoField(), {
      target: { value: '  https://github.com/owner/repo.git  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitRemoteUrl: 'https://github.com/owner/repo.git' }),
    )
  })

  it('blocks submit on a repo URL git would not clone', async () => {
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Imported' } })
    chooseRemoteSource()
    fireEvent.change(repoField(), { target: { value: 'ext::sh -c whoami' } })

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(repoField()).toHaveAttribute('aria-invalid', 'true')

    // Clearing it no longer falls back to a template app: the source is an
    // explicit choice now, and "clone from an address" with no address is
    // incomplete rather than a different kind of app.
    fireEvent.change(repoField(), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()

    // Choosing the template source is what re-enables it.
    fireEvent.click(screen.getByRole('radio', { name: /新建一个/ }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })

  it('a local directory is checked before any app row is created', async () => {
    // A folder that is not a git checkout must be refused at the picker. Left
    // to bind time the app row already exists, so the user is left with an app
    // pointing nowhere and no obvious sign of why.
    pickDirMock.mockResolvedValue('/not/a/repo')
    inspectDirMock.mockResolvedValue({ isGitRepo: false, gitRemoteUrl: null })
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Mine' } })
    chooseLocalSource()
    fireEvent.click(screen.getByRole('button', { name: /选择一个 git 目录/ }))

    // Regex, not the exact string: the banner renders "创建失败" and the reason
    // as separate text nodes in one element.
    await waitFor(() => expect(screen.getByText(/不是 git 仓库/)).toBeInTheDocument())
    expect(createMock).not.toHaveBeenCalled()
  })

  it('a local checkout is created local-only and carries its own origin', async () => {
    pickDirMock.mockResolvedValue('/home/me/project')
    inspectDirMock.mockResolvedValue({
      isGitRepo: true,
      gitRemoteUrl: 'git@github.com:me/project.git',
    })
    render(<CreateAppDialog open onOpenChange={vi.fn()} teamId="team-1" />)

    fireEvent.change(nameField(), { target: { value: 'Mine' } })
    chooseLocalSource()
    fireEvent.click(screen.getByRole('button', { name: /选择一个 git 目录/ }))
    await waitFor(() => expect(inspectDirMock).toHaveBeenCalledWith('/home/me/project'))

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        // `imported`, not a picked type: an unknown type would be read as a
        // data app and demand a Postgres schema on first deploy.
        type: 'imported',
        localOnly: true,
        gitRemoteUrl: 'git@github.com:me/project.git',
      }),
    )
    await waitFor(() =>
      expect(bindWorkdirMock).toHaveBeenCalledWith('app-1', 'team-1', '/home/me/project'),
    )
  })
})

describe('isValidGitRemoteUrl', () => {
  it('accepts what git treats as an address, and nothing else', () => {
    for (const ok of [
      '',
      '   ',
      'https://github.com/owner/repo.git',
      'http://git.internal/owner/repo',
      'ssh://git@github.com/owner/repo.git',
      'git://example.com/repo.git',
      'git@github.com:owner/repo.git',
    ]) {
      expect(isValidGitRemoteUrl(ok), ok).toBe(true)
    }
    for (const bad of [
      'ext::sh -c whoami',
      '--upload-pack=x',
      '/etc/passwd',
      'file:///etc/passwd',
      'https://example.com/repo .git',
    ]) {
      expect(isValidGitRemoteUrl(bad), bad).toBe(false)
    }
  })
})
