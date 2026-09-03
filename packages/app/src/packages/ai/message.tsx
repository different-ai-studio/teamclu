import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useTranslation } from "react-i18next"
import { readFile } from "@tauri-apps/plugin-fs"
import { Download, X, Copy, Check, Maximize2 } from "lucide-react"

import i18n from "@/lib/i18n"
import { cn, isTauri } from "@/lib/utils"
import { bytesToDataUrl } from "@/lib/base64"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1]
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

async function downloadImage(dataUrl: string, filename: string) {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog")
      const { writeFile } = await import("@tauri-apps/plugin-fs")
      const { downloadDir } = await import("@tauri-apps/api/path")

      const ext = filename.split(".").pop()?.toLowerCase() || "png"
      const filterName = ext.toUpperCase() + " Image"
      const downloads = await downloadDir()
      const dest = await save({
        title: i18n.t("chat.imageViewer.saveImage", "保存图片"),
        defaultPath: `${downloads}/${filename}`,
        filters: [{ name: filterName, extensions: [ext] }],
      })
      if (!dest) return

      const bytes = dataUrlToUint8Array(dataUrl)
      await writeFile(dest, bytes)
    } catch (err) {
      console.error("[Image] Failed to save image:", err)
    }
  } else {
    const a = document.createElement("a")
    a.href = dataUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
}

type MessageFrom = "user" | "assistant"
type UserBubbleKind = "self" | "other"

interface MessageContextValue {
  from: MessageFrom
  basePath?: string  // Base path for resolving relative image paths
  userBubble?: UserBubbleKind
}

const MessageContext = React.createContext<MessageContextValue | null>(null)

interface MarkdownRenderBoundaryProps {
  content: string
  children: React.ReactNode
}

interface MarkdownRenderBoundaryState {
  hasError: boolean
  lastContent: string
}

class MarkdownRenderBoundary extends React.Component<
  MarkdownRenderBoundaryProps,
  MarkdownRenderBoundaryState
> {
  constructor(props: MarkdownRenderBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      lastContent: props.content,
    }
  }

  static getDerivedStateFromError(): Partial<MarkdownRenderBoundaryState> {
    return { hasError: true }
  }

  static getDerivedStateFromProps(
    props: MarkdownRenderBoundaryProps,
    state: MarkdownRenderBoundaryState,
  ): Partial<MarkdownRenderBoundaryState> | null {
    if (props.content !== state.lastContent) {
      return {
        hasError: false,
        lastContent: props.content,
      }
    }

    return null
  }

  componentDidCatch(error: Error) {
    console.warn("[MessageResponse] Markdown render failed, falling back to plain text", error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="whitespace-pre-wrap break-words">
          {this.props.content}
        </div>
      )
    }

    return this.props.children
  }
}

function useMessageContext() {
  const context = React.useContext(MessageContext)
  if (!context) {
    throw new Error("Message components must be used within <Message />")
  }
  return context
}

export function Message({
  from,
  basePath,
  userBubble = "other",
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  from: MessageFrom
  basePath?: string
  /** User-message bubble skin only — does not affect layout or routing. */
  userBubble?: UserBubbleKind
}) {
  return (
    <MessageContext.Provider value={{ from, basePath, userBubble }}>
      <div
        className={cn("flex", from === "user" ? "justify-end" : "justify-start", className)}
        {...props}
      >
        {children}
      </div>
    </MessageContext.Provider>
  )
}

const USER_BUBBLE_SELF =
  "user-bubble-self max-w-[85%] overflow-x-hidden rounded-2xl rounded-br-[6px] px-4 py-3 bg-[#e8edf2] text-foreground dark:border dark:border-white/16 dark:bg-white/[0.20] dark:text-foreground dark:backdrop-blur-sm"

/** Dark: solid paper card (not translucent) so it reads clearly against self glass. */
const USER_BUBBLE_OTHER =
  "user-bubble-other max-w-[65%] overflow-x-hidden rounded-2xl rounded-br-[6px] px-[14px] py-[10px] bg-paper border border-border text-ink-2 dark:border-white/20 dark:bg-paper dark:text-ink-2 dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"

export function MessageContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { from, userBubble } = useMessageContext()
  return (
    <div
      data-user-bubble={from === "user" ? userBubble : undefined}
      className={cn(
        // Chat message base — user bubble + assistant note share 13.5px / 1.5.
        "text-[13.5px] leading-[1.6] break-words [overflow-wrap:anywhere] min-w-0",
        from === "user"
          ? cn(
              userBubble === "self" ? USER_BUBBLE_SELF : USER_BUBBLE_OTHER,
              userBubble === "self" ? "leading-[1.5]" : "leading-[1.6]",
            )
          : "overflow-hidden w-full leading-[1.5]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// Helper to resolve local image path
export function resolveImagePath(src: string, basePath?: string): string {
  // If it's already a data URL or http(s) URL, return as-is
  if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
    return src
  }
  
  // If it's an absolute path starting with /
  if (src.startsWith('/')) {
    return src
  }
  
  // If we have a basePath and this is a relative path
  if (basePath) {
    return `${basePath}/${src}`.replace(/\/+/g, '/')
  }
  
  // Return original src if we can't resolve it
  return src
}

function isRemoteOrInlineImage(src: string): boolean {
  return src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')
}

function isAbsoluteFsPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/**
 * Lexical normalization: forward slashes, `.`/`..` resolved, no duplicate or
 * trailing separators. Keeps a leading `/` or a Windows drive prefix. Purely
 * textual — no symlink resolution, which the fs plugin does at read time.
 */
function normalizeFsPath(p: string): string {
  const unified = p.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? ''
  const rest = drive ? unified.slice(drive.length) : unified
  const absolute = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  const body = out.join('/')
  return `${drive}${absolute ? '/' : ''}${body}`
}

function isPathInside(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return candidate.startsWith(prefix)
}

/**
 * SEC-5: image source for content the AGENT wrote (assistant markdown, inline
 * image lists). Local files are readable only inside the session directory
 * (`basePath`); anything else — an absolute path elsewhere, `..` escaping the
 * root, or a local path with no root to check against — resolves to null and
 * is not rendered.
 *
 * The plain `resolveImagePath` above stays for the user's own attachments,
 * which they picked from anywhere on disk themselves. This one exists because
 * rendering assistant text used to mean `![](/Users/me/.ssh/id_rsa)` was read
 * into a data URL through the whole-disk fs grant the moment it scrolled into
 * view.
 */
export function resolveAgentImagePath(src: string, basePath?: string): string | null {
  if (!src) return null
  if (isRemoteOrInlineImage(src)) return src
  if (!basePath || !isAbsoluteFsPath(basePath.replace(/\\/g, '/'))) return null
  const root = normalizeFsPath(basePath)
  const unified = src.replace(/\\/g, '/')
  const resolved = isAbsoluteFsPath(unified)
    ? normalizeFsPath(unified)
    : normalizeFsPath(`${root}/${unified}`)
  return isPathInside(resolved, root) ? resolved : null
}

// Get MIME type from file extension
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  return mimeTypes[ext] || 'image/png'
}

function isSvgImageSource(src: string): boolean {
  return src.startsWith('data:image/svg+xml') || /\.svg(?:$|[?#])/i.test(src)
}

const boxDrawingPattern = /[┌┐└┘├┤┬┴┼─│╭╮╰╯╔╗╚╝╠╣╦╩╬═║]/
const asciiBoxBorderPattern = /^\s*\+[+=\- ]+\+\s*$/

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line)
}

function isBareDiagramStart(line: string): boolean {
  return boxDrawingPattern.test(line) || asciiBoxBorderPattern.test(line)
}

function isBareDiagramContinuation(line: string): boolean {
  if (!line.trim() || isFenceLine(line)) return false
  return (
    boxDrawingPattern.test(line) ||
    asciiBoxBorderPattern.test(line) ||
    (line.includes('|') && line.indexOf('|') !== line.lastIndexOf('|'))
  )
}

export function normalizeAssistantMarkdownForDisplay(content: string): string {
  const lines = content.split('\n')
  const normalized: string[] = []
  let inFence = false
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (isFenceLine(line)) {
      inFence = !inFence
      normalized.push(line)
      index += 1
      continue
    }

    if (!inFence && isBareDiagramStart(line)) {
      let end = index
      while (end < lines.length && isBareDiagramContinuation(lines[end])) {
        end += 1
      }

      const diagramLines = lines.slice(index, end)
      if (diagramLines.length >= 2) {
        if (normalized.length > 0 && normalized[normalized.length - 1] !== '') {
          normalized.push('')
        }
        normalized.push('```text', ...diagramLines, '```')
        index = end
        continue
      }
    }

    normalized.push(line)
    index += 1
  }

  return normalized.join('\n')
}

function PreviewImage({
  src,
  alt,
  className,
}: {
  src: string
  alt?: string
  className?: string
}) {
  if (isSvgImageSource(src)) {
    return (
      <iframe
        src={src}
        title={alt || 'SVG preview'}
        sandbox=""
        className={cn("border-0 bg-transparent", className)}
      />
    )
  }

  return (
    <img
      src={src}
      alt={alt || 'Image'}
      referrerPolicy="no-referrer"
      className={className}
    />
  )
}

function PreviewCanvas({
  children,
}: React.PropsWithChildren) {
  return (
    <div
      className="rounded-lg p-2"
      style={{
        backgroundColor: '#ffffff',
        backgroundImage:
          'linear-gradient(45deg, #f1f5f9 25%, transparent 25%), linear-gradient(-45deg, #f1f5f9 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #f1f5f9 75%), linear-gradient(-45deg, transparent 75%, #f1f5f9 75%)',
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
      }}
    >
      {children}
    </div>
  )
}

// Component to load and display local image files with click-to-enlarge
export function LocalImage({ src, alt, className, onError: onErrorCallback, onLoad: onLoadCallback }: { src: string; alt?: string; className?: string; onError?: () => void; onLoad?: () => void }) {
  const { t } = useTranslation()
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [isOpen, setIsOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    
    async function loadImage() {
      // If it's already a data URL or remote URL, use directly
      if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
        setDataUrl(src)
        setLoading(false)
        return
      }
      
      try {
        // Read file as binary and convert to base64
        const data = await readFile(src)
        if (cancelled) return
        
        setDataUrl(bytesToDataUrl(data, getMimeType(src)))
        setLoading(false)
        onLoadCallback?.()
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load image:', src, err)
        setError(true)
        setLoading(false)
        onErrorCallback?.()
      }
    }
    
    loadImage()
    return () => { cancelled = true }
  }, [src, onErrorCallback])

  if (error) return null
  if (loading) {
    return (
      <div className={cn("flex items-center justify-center bg-muted/30 rounded-lg", className)}>
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }
  if (!dataUrl) return null

  return (
    <>
      <img 
        src={dataUrl} 
        alt={alt || 'Image'} 
        className={cn(className, "cursor-pointer hover:opacity-90 transition-opacity")}
        onClick={() => setIsOpen(true)}
        title={t("chat.imageViewer.clickToEnlarge", "点击查看大图")}
      />

      {/* Image preview dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="!max-w-[95vw] max-h-[95vh] w-auto h-auto p-0 overflow-hidden bg-transparent border-0 shadow-none rounded-none gap-0"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{alt || t("chat.imageViewer.imagePreview", "图片预览")}</DialogTitle>
          <div className="absolute right-2 top-2 z-50 flex items-center gap-1.5">
            <button
              onClick={() => {
                const filename = alt || src.split("/").pop() || "image.png"
                downloadImage(dataUrl, filename)
              }}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
              title={t("chat.imageViewer.downloadImage", "下载图片")}
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <PreviewCanvas>
            <PreviewImage
              src={dataUrl}
              alt={alt || 'Image'}
              className="max-w-[95vw] max-h-[95vh] w-[95vw] h-[95vh] object-contain rounded-lg"
            />
          </PreviewCanvas>
          {alt && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1.5 text-center text-xs text-white/90 rounded-b-lg">
              {alt}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Stable identity so the streaming-tail short-circuit does not churn deps. */
const EMPTY_INLINE_IMAGES: string[] = []

// Extract inline image references from text (e.g., "filename.png" mentioned in text)
function extractInlineImageReferences(text: string): string[] {
  // Match filenames that look like images: word characters, dots, ending with image extension
  // Be careful not to match too broadly
  const imagePattern = /\b([\w.-]+\.(?:png|jpg|jpeg|gif|webp|svg))\b/gi
  const matches: string[] = []
  let match
  while ((match = imagePattern.exec(text)) !== null) {
    matches.push(match[1])
  }
  return [...new Set(matches)]  // Deduplicate
}

// Parse message content and extract images and attachments
type MessagePart = { type: 'text' | 'image' | 'attachment'; content: string; name?: string; size?: string }

function parseMessageContent(content: string, isUserMessage: boolean = false): MessagePart[] {
  const parts: MessagePart[] = []
  
  if (isUserMessage) {
    // Combined pattern for images and attachments
    // [Image: filename]\ndata:image/... OR [Attachment: filename] (size) OR [File: filename]\n```...```
    const combinedPattern = /\[Image: ([^\]]+)\]\n(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)|\[Attachment: ([^\]]+)\] \(([^)]+)\)|\[File: ([^\]]+)\]\n```[\s\S]*?```/g
    
    let lastIndex = 0
    let match
    
    while ((match = combinedPattern.exec(content)) !== null) {
      // Add text before this match
      if (match.index > lastIndex) {
        const textBefore = content.slice(lastIndex, match.index).trim()
        if (textBefore) {
          parts.push({ type: 'text', content: textBefore })
        }
      }
      
      if (match[1] && match[2]) {
        // Image match
        parts.push({ type: 'image', content: match[2], name: match[1] })
      } else if (match[3] && match[4]) {
        // Attachment match (binary file)
        parts.push({ type: 'attachment', content: '', name: match[3], size: match[4] })
      } else if (match[5]) {
        // File match (text file with content) - show as attachment thumbnail
        parts.push({ type: 'attachment', content: '', name: match[5], size: '' })
      }
      
      lastIndex = match.index + match[0].length
    }
    
    // Add remaining text
    if (lastIndex < content.length) {
      const remaining = content.slice(lastIndex).trim()
      if (remaining) {
        parts.push({ type: 'text', content: remaining })
      }
    }
  } else {
    // For assistant messages: strip out any base64 data URLs that got echoed
    // This prevents showing raw base64 strings in the response
    let cleanedContent = content
    
    // Remove [Image: filename]\ndata:image/... patterns
    cleanedContent = cleanedContent.replace(/\[Image: [^\]]+\]\n?data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '')
    
    // Remove standalone data:image/... URLs (including those in markdown/text)
    cleanedContent = cleanedContent.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
    
    // Clean up any leftover empty lines or formatting artifacts
    cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n').trim()
    
    if (cleanedContent) {
      parts.push({ type: 'text', content: cleanedContent })
    }
  }
  
  // If no parts found, return the whole content as text
  if (parts.length === 0) {
    parts.push({ type: 'text', content })
  }
  
  return parts
}

// Get file icon based on file extension
function getFileIconName(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const iconMap: Record<string, string> = {
    // Spreadsheets
    xlsx: '📊', xls: '📊', csv: '📊',
    // Documents
    pdf: '📄', doc: '📄', docx: '📄',
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    // Code
    js: '📜', ts: '📜', py: '📜', java: '📜', cpp: '📜', c: '📜',
    // Config
    json: '⚙️', yaml: '⚙️', yml: '⚙️', xml: '⚙️',
    // Text
    txt: '📝', md: '📝', log: '📝',
  }
  return iconMap[ext] || '📎'
}

// Clickable image component with preview dialog (for already loaded images like base64)
export function ClickableImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)

  return (
    <>
      {/* SEC-5: a remote image in content is a tracking pixel — it reports the
          reader's IP and read time to whoever wrote the markdown. Lazy so
          nothing is fetched until it scrolls into view, and never with a
          referrer. */}
      <img
        src={src}
        alt={alt || 'Image'}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn(className, "cursor-pointer hover:opacity-90 transition-opacity")}
        onClick={() => setIsOpen(true)}
        title={t("chat.imageViewer.clickToEnlarge", "点击查看大图")}
      />

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="!max-w-[95vw] max-h-[95vh] w-auto h-auto p-0 overflow-hidden bg-transparent border-0 shadow-none rounded-none gap-0"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{alt || t("chat.imageViewer.imagePreview", "图片预览")}</DialogTitle>
          <div className="absolute right-2 top-2 z-50 flex items-center gap-1.5">
            <button
              onClick={() => {
                const filename = alt || src.split("/").pop() || "image.png"
                downloadImage(src, filename)
              }}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
              title={t("chat.imageViewer.downloadImage", "下载图片")}
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <PreviewCanvas>
            <PreviewImage
              src={src}
              alt={alt || 'Image'}
              className="max-w-[95vw] max-h-[95vh] w-[95vw] h-[95vh] object-contain rounded-lg"
            />
          </PreviewCanvas>
          {alt && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1.5 text-center text-xs text-white/90 rounded-b-lg">
              {alt}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// PERF: true while rendering the still-growing tail block of a streaming
// message. Heavy renderers (Shiki, Mermaid) skip work under this flag and
// render plain text instead; once the block closes it moves into a memoized
// StableBlock (flag = false) and gets highlighted exactly once.
export const StreamingTailContext = React.createContext(false)

function useDocumentDarkMode() {
  const [isDark, setIsDark] = React.useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )

  React.useEffect(() => {
    const root = document.documentElement
    const sync = () => setIsDark(root.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}

// --- Code block with syntax highlighting, language header, and copy button ---
function CodeBlock({ language, children }: { language: string; children: string }) {
  const isStreamingTail = React.useContext(StreamingTailContext)
  const isDark = useDocumentDarkMode()
  const [highlightedHtml, setHighlightedHtml] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const code = String(children).replace(/\n$/, '')

  React.useEffect(() => {
    let cancelled = false
    // While the code block is still streaming in, its content changes every
    // frame — re-highlighting the whole block per delta is O(n²). Render the
    // plain <pre> fallback until the block stabilizes.
    if (isStreamingTail || !language || language === 'text') {
      setHighlightedHtml(null)
      return () => { cancelled = true }
    }
    import('@/components/diff/shiki-renderer').then(
      async ({
        getHighlighter,
        mapLanguage,
        NOTION_DARK_THEME_NAME,
        NOTION_LIGHT_THEME_NAME,
      }) => {
        if (cancelled) return
        try {
          const highlighter = await getHighlighter()
          const theme = isDark ? NOTION_DARK_THEME_NAME : NOTION_LIGHT_THEME_NAME
          const lang = mapLanguage(language)
          const html = highlighter.codeToHtml(code, { lang, theme })
          if (!cancelled) setHighlightedHtml(html)
        } catch {
          // Fallback: no highlighting
        }
      },
    )
    return () => { cancelled = true }
  }, [code, language, isStreamingTail, isDark])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="chat-md-code not-prose my-2.5 w-full overflow-hidden rounded-md [overflow-wrap:normal]">
      <div className="chat-md-code-h flex items-center justify-between px-3 pt-1.5">
        <span className="font-mono text-xs text-muted-foreground">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {highlightedHtml ? (
        <div
          className="overflow-x-auto px-4 pb-3.5 pt-1 text-[13.5px] leading-[1.5] [overflow-wrap:normal] [&_code]:!bg-transparent [&_code]:!p-0 [&_code]:[overflow-wrap:normal] [&_code]:whitespace-pre [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:[overflow-wrap:normal] [&_pre]:whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="overflow-x-auto whitespace-pre px-4 pb-3.5 pt-1 [overflow-wrap:normal]">
          <code className="font-mono text-[13.5px] leading-[1.5] text-foreground [overflow-wrap:normal]">{code}</code>
        </pre>
      )}
    </div>
  )
}

function MermaidBlock({ children }: { children: string }) {
  const { t } = useTranslation()
  const isStreamingTail = React.useContext(StreamingTailContext)
  const [svg, setSvg] = React.useState<string | null>(null)
  const [hasError, setHasError] = React.useState(false)
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const diagramId = React.useId().replace(/:/g, '')
  const source = React.useMemo(() => String(children).trim(), [children])

  React.useEffect(() => {
    let cancelled = false
    setSvg(null)
    setHasError(false)

    // Mid-stream the diagram source grows every frame — rendering Mermaid per
    // delta is wasted work. Render as a plain code block until it stabilizes.
    if (isStreamingTail) return () => { cancelled = true }

    async function renderDiagram() {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
        })

        const rendered = await mermaid.render(`mermaid-${diagramId}`, source)
        if (cancelled) return

        setSvg(rendered.svg)

        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return
          rendered.bindFunctions?.(containerRef.current)
        })
      } catch (error) {
        if (cancelled) return
        console.warn('[MessageResponse] Mermaid render failed, falling back to code block', error)
        setHasError(true)
      }
    }

    void renderDiagram()

    return () => {
      cancelled = true
    }
  }, [diagramId, source, isStreamingTail])

  if (hasError || isStreamingTail) {
    return <CodeBlock language="mermaid">{source}</CodeBlock>
  }

  return (
    <>
      <div
        data-testid="mermaid-block"
        className="relative my-2 overflow-x-auto rounded-lg border border-border bg-background px-3 py-3"
      >
        {svg ? (
          <>
            <button
              type="button"
              aria-label={t("chat.imageViewer.enlargeDiagram", "放大流程图")}
              title={t("chat.imageViewer.enlargeDiagram", "放大流程图")}
              onClick={() => setIsPreviewOpen(true)}
              className="absolute right-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/80 bg-background/90 text-muted-foreground opacity-80 shadow-sm backdrop-blur transition hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <div
              ref={containerRef}
              className="[&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>Rendering Mermaid diagram...</span>
          </div>
        )}
      </div>
      {isPreviewOpen && svg ? (
        <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
          <DialogContent className="max-h-[82vh] w-[92vw] !max-w-[92vw] overflow-hidden p-0">
            <DialogTitle className="sr-only">{t("chat.imageViewer.enlargeDiagram", "放大流程图")}</DialogTitle>
            <div className="max-h-[82vh] overflow-auto bg-background p-4">
              <div
                className="w-max min-w-full [&_svg]:block [&_svg]:h-auto [&_svg]:min-w-[960px] [&_svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

// --- Stable ReactMarkdown components (no closure over basePath) ---
// Hoisted to module level so the object reference never changes between renders.
// The `img` component needs basePath, so it's added per-render via useMemo.
const markdownComponentsBase = {
  // Notion-inspired scale (chat-tuned: slightly smaller than full Notion page 16px).
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mt-[1.15em] mb-[0.3em] text-[1.5em] font-bold leading-[1.25] tracking-[-0.015em] text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mt-[1.1em] mb-[0.25em] text-[1.25em] font-semibold leading-[1.3] tracking-[-0.01em] text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-[1em] mb-[0.2em] text-[1.1em] font-semibold leading-[1.35] text-foreground first:mt-0">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-[0.4em] min-w-0 leading-[1.5] text-foreground">{children}</p>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[0.92em]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead>{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-foreground/[0.09] px-2.5 py-1.5 text-left font-semibold text-foreground dark:border-white/[0.12]">{children}</th>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="hover:bg-foreground/[0.03] dark:hover:bg-white/[0.04]">{children}</tr>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-foreground/[0.09] px-2.5 py-1.5 align-top text-foreground dark:border-white/[0.12]">{children}</td>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2.5 border-l-[3px] border-current py-0 pl-3.5 text-muted-foreground not-italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-foreground/[0.09] dark:border-white/[0.12]" />,
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: ({ className, children, ...codeProps }: { className?: string; children?: React.ReactNode }) => {
    const codeText = String(children)
    const isInline = !className && !codeText.includes('\n')
    if (isInline) {
      return (
        <code
          className="chat-md-inline-code rounded-[3px] px-[0.3em] py-[0.08em] font-mono text-[0.86em] leading-normal break-words [overflow-wrap:anywhere]"
          {...codeProps}
        >
          {children}
        </code>
      )
    }
    const language = className?.replace('language-', '') || 'text'
    if (language === 'mermaid') {
      return <MermaidBlock>{codeText}</MermaidBlock>
    }
    return <CodeBlock language={language}>{codeText}</CodeBlock>
  },
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-[2px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:bg-foreground/[0.06] dark:decoration-white/30 dark:hover:bg-white/[0.08]"
    >
      {children}
    </a>
  ),
  ul: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <ul className={cn('my-2 space-y-0.5 pl-6', className?.includes('contains-task-list') ? 'list-none pl-0' : 'list-disc', className)}>
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-2 list-decimal space-y-0.5 pl-6">{children}</ol>
  ),
  li: ({ children, className, ...liProps }: { children?: React.ReactNode; className?: string }) => {
    const isTask = className?.includes('task-list-item')
    return (
      <li
        className={cn(
          'min-w-0 leading-[1.5]',
          isTask && 'chat-md-task flex items-start gap-2',
          className,
        )}
        {...liProps}
      >
        {children}
      </li>
    )
  },
  input: (props: React.ComponentProps<'input'>) => {
    if (props.type === 'checkbox') {
      return (
        <input
          {...props}
          className={cn('chat-md-checkbox mt-1 shrink-0', props.className)}
          disabled
        />
      )
    }
    return <input {...props} />
  },
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic">{children}</em>
  ),
  del: ({ children }: { children?: React.ReactNode }) => (
    <del className="text-muted-foreground line-through">{children}</del>
  ),
} as const;

// Stable remarkPlugins array — avoids re-creating on every render
const remarkPluginsStable = [remarkGfm];

export function MessageResponse({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { from, basePath } = useMessageContext()
  const isUserMessage = from === "user"
  // PERF-13: inside the growing tail the content changes every frame, so a
  // memo keyed on it is no memo at all. The two cosmetic passes below are
  // skipped while that is true and run once the block closes into a
  // `StableBlock` (or when the message finalises) — which is the only point at
  // which their answers are meaningful anyway: a half-arrived ASCII diagram
  // has no closing border to fence, and a half-arrived image path resolves to
  // nothing.
  const isStreamingTail = React.useContext(StreamingTailContext)

  // Parse content to detect/clean images and attachments
  // PERF: memoized to avoid re-running regex every render during streaming
  const content = typeof children === "string" ? children : ""
  const parsedParts = React.useMemo(
    () => parseMessageContent(content, isUserMessage),
    [content, isUserMessage],
  )
  const hasMediaParts = parsedParts.some(p => p.type === 'image' || p.type === 'attachment')
  const inlineImages = React.useMemo(() => {
    if (isStreamingTail) return EMPTY_INLINE_IMAGES
    const allText = parsedParts.filter(p => p.type === 'text').map(p => p.content).join(' ')
    return extractInlineImageReferences(allText)
  }, [parsedParts, isStreamingTail])

  // PERF: the line-by-line normalization scan is O(content) — memoize so it
  // runs once per content change, not on every re-render during streaming.
  const normalizedTextByIndex = React.useMemo(
    () =>
      isStreamingTail
        ? parsedParts.map(() => null)
        : parsedParts.map(p =>
            p.type === 'text' ? normalizeAssistantMarkdownForDisplay(p.content) : null,
          ),
    [parsedParts, isStreamingTail],
  )

  // PERF: Merge base components with basePath-dependent `img` handler.
  // Only re-creates when basePath changes (rare), not every render.
  const markdownComponents = React.useMemo(() => ({
    ...markdownComponentsBase,
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      // SEC-5: assistant-authored image references may only read files inside
      // the session directory; anything else renders nothing.
      const resolvedSrc = resolveAgentImagePath(src || '', basePath)
      if (!resolvedSrc) return null
      if (!isRemoteOrInlineImage(resolvedSrc)) {
        return (
          <LocalImage
            src={resolvedSrc}
            alt={alt || 'Image'}
            className="max-w-full max-h-80 object-contain rounded-lg border my-2"
          />
        )
      }
      return (
        <ClickableImage
          src={resolvedSrc}
          alt={alt || 'Image'}
          className="max-w-full max-h-80 object-contain rounded-lg border my-2"
        />
      )
    },
  }), [basePath])

  if (from === "user") {
    // For user messages with images or attachments, render them properly
    if (hasMediaParts) {
      return (
        <div className={cn("space-y-2", className)} {...props}>
          {parsedParts.map((part, index) => {
            if (part.type === 'image') {
              return (
                <div key={index} className="inline-block align-middle mx-0.5 my-0.5">
                  <ClickableImage 
                    src={part.content} 
                    alt={part.name || 'Attached image'} 
                    className="size-12 shrink-0 rounded object-cover border border-white/20"
                  />
                </div>
              )
            } else if (part.type === 'attachment') {
              return (
                <div 
                  key={index} 
                  className="inline-flex items-center gap-2 rounded-lg bg-white/20 px-3 py-2 text-sm"
                >
                  <span className="text-lg">{getFileIconName(part.name || '')}</span>
                  <div className="flex flex-col">
                    <span className="font-medium">{part.name}</span>
                    {part.size && <span className="text-xs opacity-80">{part.size}</span>}
                  </div>
                </div>
              )
            } else {
              return (
                <div key={index} className="whitespace-pre-wrap break-words">
                  {part.content}
                </div>
              )
            }
          })}
        </div>
      )
    }
    
    return (
      <div className={cn("whitespace-pre-wrap break-words", className)} {...props}>
        {children}
      </div>
    )
  }

  // For assistant messages, render images and text separately
  return (
    <div className={cn("space-y-2", className)} {...props}>
      {parsedParts.map((part, index) => (
        part.type === 'image' ? (
          <div key={index} className="rounded-lg overflow-hidden">
            <ClickableImage 
              src={part.content} 
              alt={part.name || 'Image'} 
              className="max-w-full max-h-80 object-contain rounded-lg border"
            />
          </div>
        ) : (
          <div key={index} className="chat-md max-w-none min-w-0 break-words text-foreground [overflow-wrap:anywhere]">
            <MarkdownRenderBoundary content={part.content}>
              <ReactMarkdown
                remarkPlugins={remarkPluginsStable}
                components={markdownComponents}
              >
                {normalizedTextByIndex[index] ?? part.content}
              </ReactMarkdown>
            </MarkdownRenderBoundary>
          </div>
        )
      ))}
      
      {/* Render inline image references found in text */}
      {inlineImages.length > 0 && basePath && (
        <div className="flex flex-wrap gap-2 mt-3">
          {inlineImages.map((imageName, index) => (
            <InlineImageCard
              key={index}
              imageName={imageName}
              basePath={basePath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function InlineImageCard({ imageName, basePath }: { imageName: string; basePath: string }) {
  const { t } = useTranslation()
  const [failed, setFailed] = React.useState(false)
  const [imageDataUrl, setImageDataUrl] = React.useState<string | null>(null)
  // SEC-5: same root check as the markdown `img` handler — these names come
  // from the assistant's text.
  const imageSrc = resolveAgentImagePath(imageName, basePath)

  if (failed || !imageSrc) return null

  return (
    <div className="w-28 rounded-lg overflow-hidden border bg-muted/30 flex flex-col group relative">
      <div className="w-28 h-20 flex items-center justify-center overflow-hidden bg-muted/20 relative">
        <LocalImage
          src={imageSrc}
          alt={imageName}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
          onLoad={() => {
            // Arrow, not a hoisted declaration: the null-check above only
            // narrows `imageSrc` for closures created after it.
            const loadForDownload = async () => {
              try {
                if (isRemoteOrInlineImage(imageSrc)) {
                  setImageDataUrl(imageSrc)
                  return
                }
                const data = await readFile(imageSrc)
                setImageDataUrl(bytesToDataUrl(data, getMimeType(imageSrc)))
              } catch { /* ignore */ }
            }
            void loadForDownload()
          }}
        />
        {imageDataUrl && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              downloadImage(imageDataUrl, imageName)
            }}
            className="absolute bottom-1 right-1 rounded-full bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
            title={t("chat.imageViewer.downloadImage", "下载图片")}
          >
            <Download className="h-3 w-3" />
          </button>
        )}
      </div>
      {!failed && (
        <div className="px-1.5 py-1 text-[10px] text-muted-foreground truncate">
          {imageName}
        </div>
      )}
    </div>
  )
}

