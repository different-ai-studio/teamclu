import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appShortName } from '@/lib/config/build-config'
import en from '../../locales/en.json'
import zhCN from '../../locales/zh-CN.json'

const store: Record<string, string> = {}

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach((key) => delete store[key]) },
})

function setNavigatorLanguage(language: string, languages: string[] = [language]) {
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: language,
  })
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    value: languages,
  })
}

function flattenLocaleKeys(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      return flattenLocaleKeys(nestedValue as Record<string, unknown>, nextKey)
    }
    return nextKey
  })
}

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['__tests__', 'coverage', 'dist', 'locales', 'node_modules'].includes(entry.name)) {
        return []
      }
      return collectSourceFiles(fullPath)
    }

    if (!/\.(tsx?|jsx?)$/.test(entry.name) || /\.d\.ts$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) {
      return []
    }

    return fullPath
  })
}

function collectTranslationKeys(): string[] {
  const root = path.resolve(process.cwd(), 'src')
  const keys = new Set<string>()

  for (const file of collectSourceFiles(root)) {
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(sourceFile)
        const firstArg = node.arguments[0]
        if (
          (expression === 't' || expression.endsWith('.t') || expression === 'i18n.t' || expression.endsWith('i18n.t')) &&
          firstArg &&
          ts.isStringLiteralLike(firstArg)
        ) {
          keys.add(firstArg.text)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return [...keys].sort()
}

const RENDERED_TEXT_SCAN_FILES = [
  'components/app-sidebar.tsx',
  'components/chat/CommandPopover.tsx',
  'components/chat/MessageStarRating.tsx',
  'components/history/CommitList.tsx',
  'components/history/FileHistoryView.tsx',
  'components/telemetry/TelemetryConsentDialog.tsx',
  'components/version/VersionHistoryTab.tsx',
  'components/version/VersionList.tsx',
  'components/version/VersionPreview.tsx',
  'components/version/VersionedFileList.tsx',
  'components/workspace/FileTreeNode.tsx',
  'lib/dynamic-ui/DynamicUI.tsx',
]

function isTranslationCall(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const expression = node.expression.getText(sourceFile)
  return expression === 't' || expression.endsWith('.t') || expression === 'i18n.t' || expression.endsWith('i18n.t')
}

function containsUserFacingText(text: string): boolean {
  return /[\p{Script=Han}]|[A-Za-z]{2,}/u.test(text)
}

function normalizeJsxText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const IGNORED_RENDERED_TEXT_LITERALS = new Set([
  'Esc',
  'actors',
  'added',
  'content',
  'git',
  'ideas',
  'knowledge',
  'removed',
  'session',
  'shortcuts',
])

function collectRenderedTextLiterals(): string[] {
  const root = path.resolve(process.cwd(), 'src')
  const hardcoded = new Set<string>()

  for (const relativeFile of RENDERED_TEXT_SCAN_FILES) {
    const file = path.join(root, relativeFile)
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const add = (node: ts.Node, value: string) => {
      const text = normalizeJsxText(value)
      if (!text || !containsUserFacingText(text)) return
      if (IGNORED_RENDERED_TEXT_LITERALS.has(text)) return
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      hardcoded.add(`${relativeFile}:${line + 1}: ${text}`)
    }

    const visitExpression = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) {
        visit(node)
        return
      }

      if (ts.isCallExpression(node) && isTranslationCall(node, sourceFile)) {
        return
      }

      if (ts.isStringLiteralLike(node)) {
        add(node, node.text)
        return
      }

      if (ts.isNoSubstitutionTemplateLiteral(node)) {
        add(node, node.text)
        return
      }

      if (ts.isTemplateExpression(node)) {
        add(node, node.getText(sourceFile))
        return
      }

      ts.forEachChild(node, visitExpression)
    }

    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        add(node, node.getText(sourceFile))
      } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        visitExpression(node.expression)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return [...hardcoded].sort()
}

describe('locale helpers', () => {
  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key])
    vi.resetModules()
  })

  it('follows a Chinese system when there is no saved language', async () => {
    setNavigatorLanguage('zh-CN')

    const { getPreferredLanguage } = await import('@/lib/locale')

    expect(getPreferredLanguage()).toBe('zh-CN')
  })

  // Chinese is the only non-English locale shipped, so everything else lands on
  // English rather than on a language the build cannot render.
  it.each(['ja', 'fr-FR', 'de'])('falls back to English on a %s system', async (lang) => {
    setNavigatorLanguage(lang)

    const { getPreferredLanguage } = await import('@/lib/locale')

    expect(getPreferredLanguage()).toBe('en')
  })

  it.each([
    ['en', 'zh-CN'],
    ['zh-CN', 'en'],
  ])('prefers the saved language over a %s system', async (system, saved) => {
    setNavigatorLanguage(system)
    store[`${appShortName}-language`] = saved

    const { getPreferredLanguage } = await import('@/lib/locale')

    expect(getPreferredLanguage()).toBe(saved)
  })

  it('defaults to English for an unsupported saved or system language', async () => {
    setNavigatorLanguage('fr-FR')

    const { getPreferredLanguage } = await import('@/lib/locale')

    expect(getPreferredLanguage()).toBe('en')
  })

  it('only advertises languages that have frontend translation resources', async () => {
    const { SUPPORTED_LANGUAGES } = await import('@/lib/locale')

    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'zh-CN'])
  })

  it('keeps English and Simplified Chinese locale keys in sync', () => {
    expect(flattenLocaleKeys(zhCN).sort()).toEqual(flattenLocaleKeys(en).sort())
  })

  it('keeps every statically referenced translation key in locale resources', () => {
    const enKeys = new Set(flattenLocaleKeys(en))
    const zhKeys = new Set(flattenLocaleKeys(zhCN))

    const missingKeys = collectTranslationKeys().filter((key) => !enKeys.has(key) || !zhKeys.has(key))

    expect(missingKeys).toEqual([])
  })

  it('keeps high-visibility rendered text behind translations', () => {
    expect(collectRenderedTextLiterals()).toEqual([])
  })
})
