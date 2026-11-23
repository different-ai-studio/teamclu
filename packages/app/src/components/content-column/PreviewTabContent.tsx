import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { previewTabSource } from '@/lib/tabs/preview-tabs'

/**
 * Body of a `preview` tab: a chat markdown file rendered as prose, or an html
 * file in a sandboxed frame. Moved here from the chat's own reading panel,
 * which the content column replaces.
 */
export function PreviewTabContent({ target }: { target: string }) {
  const { t } = useTranslation()
  const source = previewTabSource(target)
  const [body, setBody] = React.useState('')
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!source) {
      setFailed(true)
      return
    }
    if (source.text != null) {
      setBody(source.text)
      setFailed(false)
      return
    }
    if (!source.path) {
      setBody('')
      setFailed(true)
      return
    }
    let cancelled = false
    setFailed(false)
    void import('@tauri-apps/plugin-fs')
      .then(({ readTextFile }) => readTextFile(source.path!))
      .then((text) => {
        if (!cancelled) setBody(text)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  if (failed) {
    return (
      <p className="p-4 text-[13px] text-muted-foreground">
        {t('chat.fileOpen.readFailed', '读不到这个文件')}
      </p>
    )
  }
  if (source?.kind === 'html') {
    return (
      <iframe
        title={source.name}
        className="h-full w-full border-0 bg-white"
        sandbox=""
        srcDoc={body}
      />
    )
  }
  return (
    // data-chat-preview: links inside the file get the chat's link handling
    // and right-click menu (ChatFileMenuHost), as they did in the old panel.
    <div className="h-full overflow-auto" data-chat-preview>
      <article className="mx-auto max-w-[760px] px-6 py-5 text-[13.5px] leading-[1.7] text-ink-2 [&_a]:underline [&_h1]:mb-2 [&_h1]:text-[20px] [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[15px] [&_h2]:font-semibold [&_li]:my-1 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </article>
    </div>
  )
}
