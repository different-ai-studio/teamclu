import { describe, expect, it } from 'vitest'
import {
  basenameOf,
  isPathAtOrUnder,
  isPathUnder,
  isSamePath,
  joinPathLike,
  normalizePathForCompare,
  relativePathUnder,
} from '@/lib/fs-path'

/**
 * The two spellings every one of these helpers exists for: what the app builds
 * (`homeDir()` + `/`-joined segments) and what Rust hands back (`PathBuf`,
 * rendered with the platform separator).
 */
const BUILT = 'C:\\Users\\x/.amuxd/teams/t1/shared/team-sync'
const FROM_RUST = 'C:\\Users\\x\\.amuxd\\teams\\t1\\shared\\team-sync'

describe('normalizePathForCompare', () => {
  it('unifies separators and drops trailing ones', () => {
    expect(normalizePathForCompare(BUILT)).toBe(normalizePathForCompare(FROM_RUST))
    expect(normalizePathForCompare('/a/b/')).toBe('/a/b')
    expect(normalizePathForCompare('C:\\a\\b\\')).toBe('C:/a/b')
  })

  it('leaves case alone', () => {
    expect(isSamePath('/srv/Docs', '/srv/docs')).toBe(false)
  })
})

describe('isPathAtOrUnder / isPathUnder', () => {
  it('matches the same directory written both ways', () => {
    expect(isPathAtOrUnder(FROM_RUST, BUILT)).toBe(true)
    expect(isPathUnder(FROM_RUST, BUILT)).toBe(false)
    expect(isPathAtOrUnder(`${FROM_RUST}\\documents`, BUILT)).toBe(true)
    expect(isPathUnder(`${FROM_RUST}\\documents`, BUILT)).toBe(true)
  })

  it('only matches on a path boundary', () => {
    expect(isPathAtOrUnder('/a/bc', '/a/b')).toBe(false)
    expect(isPathAtOrUnder('C:\\a\\bc', 'C:/a/b')).toBe(false)
  })
})

describe('relativePathUnder', () => {
  it('returns a /-separated key for a Windows path', () => {
    expect(relativePathUnder(`${FROM_RUST}\\documents\\hr\\合同.pdf`, BUILT)).toBe(
      'documents/hr/合同.pdf',
    )
  })

  it('is null for the root itself and for anything outside', () => {
    expect(relativePathUnder(FROM_RUST, BUILT)).toBeNull()
    expect(relativePathUnder('D:\\other\\file.md', BUILT)).toBeNull()
  })
})

describe('joinPathLike', () => {
  it('keeps the separator the parent already uses', () => {
    expect(joinPathLike('C:\\a\\b', 'c.md')).toBe('C:\\a\\b\\c.md')
    expect(joinPathLike('/a/b', 'c.md')).toBe('/a/b/c.md')
    expect(joinPathLike('/a/b/', '/c.md')).toBe('/a/b/c.md')
  })
})

describe('basenameOf', () => {
  it('reads the last segment under either separator', () => {
    expect(basenameOf('C:\\a\\b\\报告.pdf')).toBe('报告.pdf')
    expect(basenameOf('/a/b/report.pdf')).toBe('report.pdf')
    expect(basenameOf('C:\\a\\b\\')).toBe('b')
    expect(basenameOf('report.pdf')).toBe('report.pdf')
  })
})
