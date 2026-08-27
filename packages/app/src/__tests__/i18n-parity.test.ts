import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// i18n guardrail tests. These keep the two locale files structurally in sync,
// catch interpolation drift, and stop both runtime-missing keys and dead-key
// accumulation. See docs/i18n-audit.md for the one-off cleanup these enforce.

const testDir = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(testDir, '..') // packages/app/src
const localesDir = path.join(srcDir, 'locales')

const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'))
const zh = JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN.json'), 'utf8'))

type Json = Record<string, unknown>

function flatten(obj: Json, prefix = '', out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Json, key, out)
    else out[key] = v
  }
  return out
}

const flatEn = flatten(en)
const flatZh = flatten(zh)
const enKeys = Object.keys(flatEn)
const zhKeys = Object.keys(flatZh)

// Keys whose values are intentionally identical English/technical terms in both
// locales (brand names, IDs, URLs, placeholders) are fine — we do NOT assert
// translation difference. We only assert structural + interpolation invariants.

function placeholders(s: unknown): string {
  if (typeof s !== 'string') return ''
  return [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',')
}

// --- Source scan (for missing / unused key detection) ---------------------

const SOURCE_EXTS = new Set(['.ts', '.tsx'])
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'locales') continue
      walk(full, acc)
    } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
      if (entry.name.includes('.test.') || full.includes(`${path.sep}__tests__${path.sep}`)) continue
      acc.push(full)
    }
  }
  return acc
}

const sourceBlob = walk(srcDir).map((f) => fs.readFileSync(f, 'utf8')).join('\n')

// Broad reference set: any full dotted key path appearing as a quoted string
// literal. Intentionally lenient — used for the dead-key check so that a key
// touched anywhere (props, constant tables) is not falsely flagged as unused.
const referenced = new Set<string>()
for (const m of sourceBlob.matchAll(/['"`]([\w]+(?:\.[\w]+)+)['"`]/g)) referenced.add(m[1])

// Strict reference set: only genuine i18n call sites — t('a.b'),
// <Trans i18nKey="a.b">, and the `xxxKey: 'a.b'` config convention
// (titleKey/descKey/labelKey). Used for the missing-key check so that log
// event names, filenames, and telemetry tags that merely look dotted
// (e.g. "permission.reply.begin", "daemon.toml") are NOT treated as keys.
const referencedStrict = new Set<string>()
for (const m of sourceBlob.matchAll(/\bt\(\s*['"`]([\w]+(?:\.[\w]+)+)['"`]/g)) referencedStrict.add(m[1])
for (const m of sourceBlob.matchAll(/i18nKey=['"]([\w]+(?:\.[\w]+)+)['"]/g)) referencedStrict.add(m[1])
// Config-driven i18n convention in this codebase: { titleKey, descKey, labelKey }.
// Require a dotted value so unrelated *Key props (queryKey, storageKey) are skipped.
for (const m of sourceBlob.matchAll(/\b(?:title|desc|label)Key:\s*['"]([\w]+(?:\.[\w]+)+)['"]/g)) referencedStrict.add(m[1])

// Keys built dynamically as t(`prefix.${x}`) — list the static prefixes here.
const DYNAMIC_PREFIXES = [
  'actors.role.',
  // Keyed by the gateway an external actor came in through (externalSourceLabel).
  'actors.source.',
  'setupWizard.deps.',
  // Keyed by OnboardingStep at the call site (#881).
  'settings.daemonOnboarding.steps.',
  'settings.daemonOnboarding.slowHint.',
  'settings.daemonOnboarding.recovery.',
  // Keyed by AppAuthMode / permission level in the app control panel
  // (AppControlPanel.tsx — t(`…${mode}`) / t(`…${level}`)).
  'apps.controlPanel.authModeOption.',
  'apps.controlPanel.permission.',
]
// i18next plural/context suffixes resolve from the base key at runtime.
const PLURAL_SUFFIX = /_(plural|one|two|few|many|other|zero|\d+)$/

function isReferenced(key: string): boolean {
  if (referenced.has(key)) return true
  if (DYNAMIC_PREFIXES.some((p) => key.startsWith(p))) return true
  if (PLURAL_SUFFIX.test(key) && referenced.has(key.replace(PLURAL_SUFFIX, ''))) return true
  return false
}

// --- Tests ----------------------------------------------------------------

describe('i18n locale parity', () => {
  test('en and zh-CN define exactly the same keys', () => {
    const onlyEn = enKeys.filter((k) => !(k in flatZh))
    const onlyZh = zhKeys.filter((k) => !(k in flatEn))
    expect({ onlyEn, onlyZh }).toEqual({ onlyEn: [], onlyZh: [] })
  })

  test('values have matching primitive types across locales', () => {
    const mismatches = enKeys
      .filter((k) => k in flatZh && typeof flatEn[k] !== typeof flatZh[k])
      .map((k) => `${k}: en=${typeof flatEn[k]} zh=${typeof flatZh[k]}`)
    expect(mismatches).toEqual([])
  })

  test('interpolation placeholders match across locales', () => {
    const mismatches = enKeys
      .filter((k) => k in flatZh && placeholders(flatEn[k]) !== placeholders(flatZh[k]))
      .map((k) => `${k}: en={${placeholders(flatEn[k])}} zh={${placeholders(flatZh[k])}}`)
    expect(mismatches).toEqual([])
  })
})

describe('i18n key usage', () => {
  test('every key referenced in source exists in en.json (no runtime-missing keys)', () => {
    const defined = new Set(enKeys)
    const missing = [...referencedStrict].filter((k) => !defined.has(k))
    expect(missing.sort()).toEqual([])
  })

  test('no dead keys (defined but never referenced)', () => {
    const dead = enKeys.filter((k) => !isReferenced(k))
    // If this fails: either delete the unused key, reference it, or — for keys
    // built dynamically — add the static prefix to DYNAMIC_PREFIXES above.
    expect(dead.sort()).toEqual([])
  })
})
