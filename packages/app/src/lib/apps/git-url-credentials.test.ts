import { describe, expect, it } from 'vitest'
import { isHttpGitUrl, splitGitUrlCredentials } from './git-url-credentials'

describe('splitGitUrlCredentials', () => {
  it('leaves an address with no credentials alone', () => {
    expect(splitGitUrlCredentials(' https://github.com/o/r.git ')).toEqual({
      url: 'https://github.com/o/r.git',
      username: '',
      token: '',
    })
  })

  it('lifts user and token out of the address', () => {
    expect(splitGitUrlCredentials('https://me:ghp_abc@github.com/o/r.git')).toEqual({
      url: 'https://github.com/o/r.git',
      username: 'me',
      token: 'ghp_abc',
    })
  })

  it("reads GitHub's token-only form as a token", () => {
    expect(splitGitUrlCredentials('https://github_pat_11AB@github.com/o/r.git')).toEqual({
      url: 'https://github.com/o/r.git',
      username: '',
      token: 'github_pat_11AB',
    })
  })

  it("reads Bitbucket's user-only form as a username", () => {
    expect(splitGitUrlCredentials('https://alice@bitbucket.org/team/r.git')).toEqual({
      url: 'https://bitbucket.org/team/r.git',
      username: 'alice',
      token: '',
    })
  })

  it('decodes percent-encoded parts and keeps a port', () => {
    expect(splitGitUrlCredentials('http://a%40b:p%3Ass@git.internal:8443/o/r')).toEqual({
      url: 'http://git.internal:8443/o/r',
      username: 'a@b',
      token: 'p:ss',
    })
  })

  it('never touches an ssh address, where the user part is the address', () => {
    for (const url of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git']) {
      expect(splitGitUrlCredentials(url)).toEqual({ url, username: '', token: '' })
    }
  })
})

describe('isHttpGitUrl', () => {
  it('is true only for http(s)', () => {
    expect(isHttpGitUrl('https://github.com/o/r.git')).toBe(true)
    expect(isHttpGitUrl('HTTP://x/y')).toBe(true)
    expect(isHttpGitUrl('git@github.com:o/r.git')).toBe(false)
    expect(isHttpGitUrl('')).toBe(false)
    expect(isHttpGitUrl(null)).toBe(false)
  })
})
