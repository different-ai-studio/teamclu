import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { safeOpenDialog } from '../safe-open-dialog'

describe('safeOpenDialog', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('returns the single path when multiple is off', async () => {
    invoke.mockResolvedValue(['/tmp/dir'])
    await expect(safeOpenDialog({ directory: true, title: 'Pick' })).resolves.toBe('/tmp/dir')
    expect(invoke).toHaveBeenCalledWith('safe_open_dialog', {
      args: { title: 'Pick', defaultPath: undefined, filters: undefined, directory: true, multiple: false },
    })
  })

  it('returns every path when multiple is on', async () => {
    invoke.mockResolvedValue(['/a', '/b'])
    await expect(safeOpenDialog({ multiple: true })).resolves.toEqual(['/a', '/b'])
  })

  it('returns null on cancel', async () => {
    invoke.mockResolvedValue(null)
    await expect(safeOpenDialog({ multiple: true })).resolves.toBeNull()
    invoke.mockResolvedValue([])
    await expect(safeOpenDialog()).resolves.toBeNull()
  })

  it('rejects when the native panel fails', async () => {
    invoke.mockRejectedValue(new Error('File dialog failed (native panel unavailable).'))
    await expect(safeOpenDialog()).rejects.toThrow('native panel unavailable')
  })
})

// The plugin's open()/save() panic in AppKit when the native panel comes back
// NULL (TEAMCLU-RUST-10/11/15-18). Desktop code goes through the guarded
// commands in safe-open-dialog.ts / safe-save-dialog.ts instead.
describe('guardrail: no @tauri-apps/plugin-dialog imports in app source', () => {
  const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const IMPORT_RE =
    /\bimport\b[^;\n]*\bfrom\s+['"]@tauri-apps\/plugin-dialog['"]|\bimport\s*\(\s*['"]@tauri-apps\/plugin-dialog['"]/

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full, acc)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        acc.push(full)
      }
    }
    return acc
  }

  it('detects static and dynamic imports', () => {
    expect(IMPORT_RE.test("import { open } from '@tauri-apps/plugin-dialog'")).toBe(true)
    expect(IMPORT_RE.test("const { open } = await import('@tauri-apps/plugin-dialog')")).toBe(true)
  })

  it('finds none outside tests', () => {
    const offenders = walk(SRC_DIR).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (IMPORT_RE.test(line) ? [`${path.relative(SRC_DIR, file)}:${i + 1}`] : [])),
    )
    expect(offenders).toEqual([])
  })
})
