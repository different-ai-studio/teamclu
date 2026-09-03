import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * `srcDoc` frames are `about:srcdoc` documents, and `allow-same-origin` on one
 * means the *parent's* origin — not an opaque one. Combined with
 * `withGlobalTauri`, the previewed markup would run inside the app's own
 * document and could call `parent.__TAURI__.core.invoke(...)`, reaching every
 * IPC command and the whole-disk fs grants in
 * apps/desktop/capabilities/default.json.
 *
 * Verified in WKWebView: with both flags the frame reaches `parent.__TAURI__`;
 * with `allow-scripts` alone the access throws SecurityError while the preview
 * still renders.
 *
 * A remote `src=` frame is different — there `allow-same-origin` preserves the
 * *remote* origin, which stays cross-origin to the app — so this only guards
 * srcDoc.
 */
describe('srcDoc iframes stay origin-isolated', () => {
  const offenders: string[] = []

  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('srcDoc')) continue

    for (const match of text.matchAll(/<iframe\b[\s\S]*?\/>/g)) {
      const tag = match[0]
      if (!/\bsrcDoc\b/.test(tag)) continue
      if (!/sandbox=("[^"]*"|'[^']*')/.test(tag)) {
        offenders.push(`${path.relative(SRC, file)}: srcDoc iframe with no sandbox`)
        continue
      }
      if (/sandbox=("[^"]*allow-same-origin[^"]*"|'[^']*allow-same-origin[^']*')/.test(tag)) {
        offenders.push(
          `${path.relative(SRC, file)}: srcDoc iframe carries allow-same-origin`,
        )
      }
    }
  }

  it('never combines srcDoc with allow-same-origin', () => {
    expect(offenders).toEqual([])
  })

  it('actually scanned the HTML preview frame', () => {
    const editor = fs.readFileSync(path.join(SRC, 'components', 'FileEditor.tsx'), 'utf8')
    expect(editor).toMatch(/srcDoc=\{previewSrcDoc\}/)
    expect(editor).toMatch(/sandbox="allow-scripts"/)
  })

  /**
   * SEC-9: the sandbox denies the frame an origin, not the network. A srcdoc
   * frame inherits the embedder's CSP, and the app's own policy allows
   * `connect-src … https:` — so the previewed document carries a policy of its
   * own. Losing that silently is the whole failure mode this guards.
   */
  it('feeds the preview through withHtmlPreviewCsp', () => {
    const editor = fs.readFileSync(path.join(SRC, 'components', 'FileEditor.tsx'), 'utf8')
    expect(editor).toContain('withHtmlPreviewCsp')
    expect(editor).toMatch(/previewSrcDoc\s*=\s*useMemo\(/)
  })
})
