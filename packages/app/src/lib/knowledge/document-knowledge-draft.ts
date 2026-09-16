import type { KnowledgeSuggestion } from '@/lib/knowledge/inbox-types'
import {
  composeKnowledgeDraft,
  extractSuggestionsFromText,
  slugifyDraftTitle,
  type SessionKnowledgeDraft,
} from '@/lib/knowledge/session-knowledge-draft'

const MAX_TITLE_CHARS = 48
const MAX_SUMMARY_CHARS = 80
const MAX_SUGGESTION_CHARS = 160
const SHORT_NOTE_CHARS = 160

export type DocumentKnowledgeInput = {
  fileName: string
  documentPath: string
  /** UTF-8 text. `null` means binary / unreadable — never dump bytes. */
  content: string | null
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max).trim()}…`
}

function titleFromFileName(fileName: string): string {
  const base = (fileName.trim().split(/[/\\]/).pop() ?? fileName).trim()
  if (!base) return 'untitled'
  const dot = base.lastIndexOf('.')
  if (dot > 0) return base.slice(0, dot).trim() || base
  return base
}

function sourceFact(documentPath: string): string {
  return `来自资料库 ${documentPath}`
}

function withSource(
  suggestions: KnowledgeSuggestion[],
  documentPath: string,
): KnowledgeSuggestion[] {
  if (suggestions.some((item) => item.text.includes(documentPath))) return suggestions
  return [
    ...suggestions,
    {
      id: `fact-source-${slugifyDraftTitle(documentPath).slice(0, 16)}`,
      kind: 'fact',
      text: clip(sourceFact(documentPath), MAX_SUGGESTION_CHARS),
    },
  ]
}

/**
 * Distill a 资料库 file into reviewable suggestions. Long notes are mined for
 * bullets and headings; they are never copied in full. Binaries become a
 * pointer back to the original path — the file itself stays in documents/.
 */
export function distillFromDocument(input: DocumentKnowledgeInput): SessionKnowledgeDraft {
  const title = titleFromFileName(input.fileName)
  const text = input.content?.trim() ?? ''

  let extracted: KnowledgeSuggestion[]
  if (!text) {
    extracted = [
      {
        id: 'followup-fill',
        kind: 'followup',
        text: '如需把原文要点写入知识库，请在审稿页补写',
      },
    ]
  } else if (text.length <= SHORT_NOTE_CHARS) {
    extracted = [{ id: 'fact-note-0', kind: 'fact', text: clip(text, MAX_SUGGESTION_CHARS) }]
  } else {
    extracted = extractSuggestionsFromText(text)
    if (extracted.length === 0) {
      extracted = [{ id: 'fact-clip-0', kind: 'fact', text: clip(text, SHORT_NOTE_CHARS) }]
    }
  }

  const suggestions = withSource(extracted, input.documentPath)
  const summary = clip(
    extracted.find((item) => item.kind === 'decision')?.text ??
      extracted[0]?.text ??
      sourceFact(input.documentPath),
    MAX_SUMMARY_CHARS,
  )
  const body = composeKnowledgeDraft({ summary, suggestions })
  return {
    title: title.slice(0, MAX_TITLE_CHARS) || 'untitled',
    body: body || '（资料里没有可提炼的条目。请勾选或改写建议后再写入。）',
    suggestedPath: `20-domains/${slugifyDraftTitle(title)}.md`,
    summary,
    suggestions,
  }
}

const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'rst',
  'org',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
])

const BINARY_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'svg',
  'zip',
  'gz',
  'dmg',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'mp3',
  'mp4',
  'mov',
  'wav',
])

export function documentFileKind(fileName: string): 'text' | 'binary' | 'unknown' {
  const base = fileName.trim().split(/[/\\]/).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return 'unknown'
  const ext = base.slice(dot + 1).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (BINARY_EXTENSIONS.has(ext)) return 'binary'
  return 'unknown'
}
