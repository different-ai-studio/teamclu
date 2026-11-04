import { describe, it, expect } from 'vitest'
import {
  buildInstallDiagnostics,
  classifyInstallFailure,
  summarizeInstallFailure,
} from '../install-failure'

// Shape of the 2026-11-04 failure: npm crashed with an uncaught exception, so
// the tail ends on Node's version footer. Only that footer reached the screen.
const NODE_CRASH = [
  'amuxd install-pi failed: pi install failed (exit status: 1): node:internal/modules/cjs/loader:1386',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module '/Users/x/.amuxd/cache/node/24.20.0/lib/node_modules/npm/bin/npm-cli.js'",
  '    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)',
  '    at node:internal/main/run_main_module:36:49 {',
  "  code: 'MODULE_NOT_FOUND',",
  '  requireStack: []',
  '}',
  '',
  'Node.js v24.20.0',
].join('\n')

const NPM_NETWORK = [
  'amuxd install-pi failed: pi install failed (exit status: 1): npm error code ENOTFOUND',
  'npm error syscall getaddrinfo',
  'npm error errno ENOTFOUND',
  'npm error network request to https://registry.npmjs.org/chalk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
  'npm error A complete log of this run can be found in: /x/_logs/debug-0.log',
].join('\n')

describe('summarizeInstallFailure', () => {
  it('names the crash, not the Node.js version footer', () => {
    const { headline, detail } = summarizeInstallFailure(NODE_CRASH)
    expect(headline).toMatch(/^Error: Cannot find module/)
    expect(headline).not.toMatch(/Node\.js v/)
    expect(detail).toContain('Node.js v24.20.0')
    expect(detail).not.toMatch(/^amuxd install-pi failed/)
  })

  it("picks npm's summary over its code/errno bookkeeping", () => {
    expect(summarizeInstallFailure(NPM_NETWORK).headline).toMatch(
      /^npm error network request to https:\/\/registry\.npmjs\.org/,
    )
  })

  it('keeps a one-line error as it is, with nothing to expand', () => {
    expect(summarizeInstallFailure('amuxd install-pi exited with code Some(3)')).toEqual({
      headline: 'amuxd install-pi exited with code Some(3)',
      detail: null,
    })
  })

  it('never shows the footer alone even when it is all there is', () => {
    const { headline } = summarizeInstallFailure(
      'amuxd install-pi failed: pi install failed (exit status: 1): boom\nNode.js v24.20.0',
    )
    expect(headline).toBe('pi install failed (exit status: 1): boom')
  })
})

describe('classifyInstallFailure', () => {
  it.each([
    [NODE_CRASH, 'node_crash'],
    [NPM_NETWORK, 'npm_network'],
    ['could not download Node.js 24.20.0 from any source: a; b', 'node_download'],
    ['Pi OSS bundle checksum mismatch; retry later', 'checksum'],
    ['pi install failed (exit status: 1): npm error code E404', 'npm_error'],
    ['pi install produced 1.1.0, but 1.5.0 is required', 'verify'],
    ['lock /x/pi-install.lock: denied', 'other'],
  ] as const)('%#: %s', (error, kind) => {
    expect(classifyInstallFailure(error)).toBe(kind)
  })
})

describe('buildInstallDiagnostics', () => {
  it('holds everything we would ask a stuck user for, in one paste', () => {
    const report = buildInstallDiagnostics({
      error: NODE_CRASH,
      output: [
        JSON.stringify({ event: 'install', message: 'running npm ci' }),
        'raw stderr line',
        JSON.stringify({ event: 'error', message: 'DUPLICATE OF ERROR' }),
      ],
      appVersion: '0.4.1-beta.110',
      platform: 'Mac',
      logPath: '~/.amuxd/logs/install-pi.log',
      attempts: 2,
    })
    expect(report).toContain('App: 0.4.1-beta.110')
    expect(report).toContain('Attempts: 2')
    expect(report).toContain('Log: ~/.amuxd/logs/install-pi.log')
    expect(report).toContain("Error: Cannot find module '/Users/x/")
    expect(report).toContain('[install] running npm ci')
    expect(report).toContain('raw stderr line')
    expect(report).not.toContain('DUPLICATE OF ERROR')
  })
})
