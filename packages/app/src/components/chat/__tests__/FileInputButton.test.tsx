import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileInputButton } from '../FileInputButton'

const platformState = vi.hoisted(() => ({ tauriInvoke: false }))

vi.mock('@/lib/config/platform', () => ({
  capabilities: {
    get tauriInvoke() {
      return platformState.tauriInvoke
    },
  },
}))

const openDialog = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openDialog(...args),
}))

const readFile = vi.fn()
const stat = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (...args: unknown[]) => readFile(...args),
  stat: (...args: unknown[]) => stat(...args),
}))

describe('FileInputButton', () => {
  beforeEach(() => {
    platformState.tauriInvoke = false
    openDialog.mockReset()
    readFile.mockReset()
    stat.mockReset()
    stat.mockResolvedValue({ size: 1024 })
  })

  it('opens a browser file input when Tauri is unavailable', () => {
    const onFilesSelected = vi.fn()
    render(<FileInputButton onFilesSelected={onFilesSelected} />)

    const input = screen.getByTestId('file-input-browser') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(openDialog).not.toHaveBeenCalled()

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onFilesSelected).toHaveBeenCalledWith([file])
  })

  it('reads desktop paths into File objects on Tauri', async () => {
    platformState.tauriInvoke = true
    openDialog.mockResolvedValue(['/tmp/a.png'])
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const onFilesSelected = vi.fn()

    render(<FileInputButton onFilesSelected={onFilesSelected} />)

    fireEvent.click(screen.getByRole('button', { name: /attach files/i }))
    await vi.waitFor(() => {
      expect(openDialog).toHaveBeenCalledTimes(1)
      expect(stat).toHaveBeenCalledWith('/tmp/a.png')
      expect(readFile).toHaveBeenCalledWith('/tmp/a.png')
      expect(onFilesSelected).toHaveBeenCalledTimes(1)
    })

    const files = onFilesSelected.mock.calls[0][0] as File[]
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('a.png')
    expect(files[0].type).toBe('image/png')
  })

  it('rejects non-image files over 20MB on web', async () => {
    const onFilesSelected = vi.fn()
    render(<FileInputButton onFilesSelected={onFilesSelected} />)

    const input = screen.getByTestId('file-input-browser') as HTMLInputElement
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'big.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(input, { target: { files: [big] } })
    expect(onFilesSelected).not.toHaveBeenCalled()
  })
})
