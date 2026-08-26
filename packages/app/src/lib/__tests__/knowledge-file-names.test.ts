import { describe, expect, it } from 'vitest'

import { withDefaultExtension } from '../knowledge-file-names'

describe('withDefaultExtension', () => {
  it('adds the extension when there is none', () => {
    expect(withDefaultExtension('untitled', '.md')).toBe('untitled.md')
    expect(withDefaultExtension('会议纪要', '.md')).toBe('会议纪要.md')
  })

  it('leaves a real extension alone', () => {
    expect(withDefaultExtension('note.md', '.md')).toBe('note.md')
    expect(withDefaultExtension('diagram.png', '.md')).toBe('diagram.png')
    expect(withDefaultExtension('archive.tar.gz', '.md')).toBe('archive.tar.gz')
  })

  // The reason `hasExtension` is narrow. These are ordinary document names, and
  // treating the trailing fragment as an extension would leave them without
  // `.md` — which is exactly the bug being fixed.
  it('treats a version-like dot as part of the name, not an extension', () => {
    expect(withDefaultExtension('v1.2 计划', '.md')).toBe('v1.2 计划.md')
    expect(withDefaultExtension('2026.03 复盘', '.md')).toBe('2026.03 复盘.md')
    expect(withDefaultExtension('report.FINALVERSION', '.md')).toBe('report.FINALVERSION.md')
  })

  it('treats a leading dot as a hidden file, not an extension', () => {
    expect(withDefaultExtension('.gitignore', '.md')).toBe('.gitignore')
  })

  it('trims, and passes an empty name straight through', () => {
    expect(withDefaultExtension('  note  ', '.md')).toBe('note.md')
    expect(withDefaultExtension('   ', '.md')).toBe('')
  })
})
