import type { TFunction } from 'i18next'

/**
 * Whether a name the user typed can be written as a single file or folder name
 * on every platform the app runs on.
 *
 * Windows refuses `< > : " / \ | ? *`, control characters, names ending in a
 * space or a period, and the DOS device names (`CON`, `NUL`, `COM1`…) with or
 * without an extension. The write then fails with an OS error the file tree
 * swallows, so a rename to `会议: 周一.md` silently did nothing. The check runs
 * on macOS too: workspace and knowledge files sync to teammates, and a name a
 * Windows machine cannot write fails there instead, later and out of sight.
 */

export type InvalidFileName =
  | { kind: 'chars'; chars: string[] }
  | { kind: 'reserved' }
  | { kind: 'trailing' }

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHAR = /[<>:"/\\|?*\u0000-\u001f]/g

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

/** Null when `name` is acceptable, otherwise why it is not. */
export function invalidFileName(name: string): InvalidFileName | null {
  const chars = [...new Set(name.match(ILLEGAL_CHAR) ?? [])]
  if (chars.length > 0) return { kind: 'chars', chars }
  if (RESERVED_NAME.test(name)) return { kind: 'reserved' }
  if (/[ .]$/.test(name)) return { kind: 'trailing' }
  return null
}

/** How `chars` reads in a message: control characters are shown as their code. */
export function describeIllegalChars(chars: string[]): string {
  return chars
    .map((c) => (c.charCodeAt(0) < 0x20 ? `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
    .join(' ')
}

/**
 * The message to show for `name`, or null when it can be written. Keys live
 * under `fileExplorer`, shared by every place a file or folder gets named.
 */
export function fileNameError(t: TFunction, name: string): string | null {
  const problem = invalidFileName(name)
  if (!problem) return null
  switch (problem.kind) {
    case 'chars':
      return t('fileExplorer.invalidFileNameChars', {
        chars: describeIllegalChars(problem.chars),
        defaultValue: "A name can't contain {{chars}}",
      })
    case 'reserved':
      return t('fileExplorer.invalidFileNameReserved', {
        name,
        defaultValue: '"{{name}}" is a reserved name on Windows',
      })
    case 'trailing':
      return t('fileExplorer.invalidFileNameTrailing', "A name can't end with a space or a period")
  }
}
