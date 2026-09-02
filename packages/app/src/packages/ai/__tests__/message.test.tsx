import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

let shouldThrowMarkdown = false
const mermaidInitializeMock = vi.fn()
const mermaidRenderMock = vi.fn(async (id: string, code: string) => ({
  svg: `<svg data-testid="mermaid-svg" data-diagram-id="${id}"><text>${code}</text></svg>`,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  isTauri: () => false,
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('not found')),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogContent: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    React.createElement('div', { className, 'data-testid': 'dialog-content' }, children)
  ),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}))

vi.mock('react-markdown', () => ({
  default: ({
    children,
    components,
  }: {
    children: string
    components?: {
      code?: (props: { className?: string; children?: React.ReactNode }) => React.ReactNode
    }
  }) => {
    if (shouldThrowMarkdown) {
      throw new Error('Invalid regular expression: invalid group specifier name')
    }

    const fencedCodeMatch = children.match(/^```([^\n]*)\n([\s\S]*?)\n```$/)
    if (fencedCodeMatch && components?.code) {
      const language = fencedCodeMatch[1].trim()
      return React.createElement(
        'div',
        { 'data-testid': 'markdown' },
        components.code({
          className: language ? `language-${language}` : undefined,
          children: fencedCodeMatch[2],
        }),
      )
    }

    return React.createElement('div', { 'data-testid': 'markdown' }, children)
  },
}))

vi.mock('remark-gfm', () => ({
  default: () => {},
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidInitializeMock,
    render: mermaidRenderMock,
  },
}))

vi.mock('lucide-react', () => ({
  Download: () => React.createElement('span', null, 'Download'),
  X: () => React.createElement('span', null, 'X'),
  Copy: () => React.createElement('span', null, 'Copy'),
  Check: () => React.createElement('span', null, 'Check'),
  Maximize2: () => React.createElement('span', null, 'Maximize2'),
}))

beforeEach(() => {
  vi.clearAllMocks()
  shouldThrowMarkdown = false
  document.documentElement.classList.remove('dark')
  mermaidRenderMock.mockImplementation(async (id: string, code: string) => ({
    svg: `<svg data-testid="mermaid-svg" data-diagram-id="${id}"><text>${code}</text></svg>`,
  }))
})

describe('Message', () => {
  it('renders user message with justify-end', async () => {
    const { Message, MessageContent } = await import('@/packages/ai/message')
    const { container } = render(
      React.createElement(Message, { from: 'user' },
        React.createElement(MessageContent, null, 'Hello')
      )
    )
    const messageDiv = container.firstElementChild
    expect(messageDiv?.className).toContain('justify-end')
  })

  it('renders self user bubble with legacy gray skin', async () => {
    const { Message, MessageContent } = await import('@/packages/ai/message')
    const { container } = render(
      React.createElement(Message, { from: 'user', userBubble: 'self' },
        React.createElement(MessageContent, null, 'Hello')
      )
    )
    const bubble = container.querySelector('[data-user-bubble="self"]')
    expect(bubble?.className).toContain('user-bubble-self')
    expect(bubble?.className).toContain('bg-[#e8edf2]')
  })

  it('renders other user bubble with paper skin', async () => {
    const { Message, MessageContent } = await import('@/packages/ai/message')
    const { container } = render(
      React.createElement(Message, { from: 'user', userBubble: 'other' },
        React.createElement(MessageContent, null, 'Hello')
      )
    )
    const bubble = container.querySelector('[data-user-bubble="other"]')
    expect(bubble?.className).toContain('user-bubble-other')
    expect(bubble?.className).toContain('bg-paper')
  })

  it('renders assistant message with justify-start', async () => {
    const { Message, MessageContent } = await import('@/packages/ai/message')
    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null, 'Hi there')
      )
    )
    const messageDiv = container.firstElementChild
    expect(messageDiv?.className).toContain('justify-start')
  })
})

describe('resolveImagePath', () => {
  it('returns data URLs unchanged', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })

  it('returns http URLs unchanged', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('https://example.com/img.png')).toBe('https://example.com/img.png')
  })

  it('resolves relative paths with basePath', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('img.png', '/workspace')).toBe('/workspace/img.png')
  })

  it('returns absolute paths unchanged', async () => {
    const { resolveImagePath } = await import('@/packages/ai/message')
    expect(resolveImagePath('/absolute/path.png')).toBe('/absolute/path.png')
  })
})

describe('resolveAgentImagePath (SEC-5)', () => {
  it('passes data and http(s) URLs through', async () => {
    const { resolveAgentImagePath } = await import('@/packages/ai/message')
    expect(resolveAgentImagePath('data:image/png;base64,abc', '/ws')).toBe('data:image/png;base64,abc')
    expect(resolveAgentImagePath('https://example.com/img.png')).toBe('https://example.com/img.png')
  })

  it('resolves relative paths inside the session directory', async () => {
    const { resolveAgentImagePath } = await import('@/packages/ai/message')
    expect(resolveAgentImagePath('img.png', '/ws')).toBe('/ws/img.png')
    expect(resolveAgentImagePath('./shots//a.png', '/ws/')).toBe('/ws/shots/a.png')
    expect(resolveAgentImagePath('sub/../img.png', '/ws')).toBe('/ws/img.png')
  })

  it('accepts an absolute path only when it stays inside the root', async () => {
    const { resolveAgentImagePath } = await import('@/packages/ai/message')
    expect(resolveAgentImagePath('/ws/out/img.png', '/ws')).toBe('/ws/out/img.png')
    expect(resolveAgentImagePath('/ws', '/ws')).toBe('/ws')
    expect(resolveAgentImagePath('/Users/me/.ssh/id_rsa', '/ws')).toBeNull()
    expect(resolveAgentImagePath('/wsx/img.png', '/ws')).toBeNull()
  })

  it('refuses .. escapes and local paths with no root', async () => {
    const { resolveAgentImagePath } = await import('@/packages/ai/message')
    expect(resolveAgentImagePath('../../etc/passwd', '/ws')).toBeNull()
    expect(resolveAgentImagePath('a/../../b.png', '/ws')).toBeNull()
    expect(resolveAgentImagePath('/absolute/path.png')).toBeNull()
    expect(resolveAgentImagePath('relative.png')).toBeNull()
    expect(resolveAgentImagePath('', '/ws')).toBeNull()
  })

  it('handles Windows drive paths and backslashes', async () => {
    const { resolveAgentImagePath } = await import('@/packages/ai/message')
    expect(resolveAgentImagePath('shots\\a.png', 'C:\\ws')).toBe('C:/ws/shots/a.png')
    expect(resolveAgentImagePath('C:\\Windows\\win.ini', 'C:\\ws')).toBeNull()
  })
})

describe('image preview rendering', () => {
  it('renders SVG previews with an iframe canvas', async () => {
    const { ClickableImage } = await import('@/packages/ai/message')
    const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'

    const { container } = render(
      React.createElement(ClickableImage, {
        src: svgDataUrl,
        alt: 'diagram.svg',
      })
    )

    const iframe = container.querySelector('iframe[title="diagram.svg"]')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('src')).toBe(svgDataUrl)
  })

  it('renders bitmap previews with img tags', async () => {
    const { ClickableImage } = await import('@/packages/ai/message')
    const pngDataUrl = 'data:image/png;base64,abc'

    render(
      React.createElement(ClickableImage, {
        src: pngDataUrl,
        alt: 'photo.png',
      })
    )

    const images = screen.getAllByAltText('photo.png')
    expect(images.length).toBeGreaterThan(0)
    expect(images[0].getAttribute('src')).toBe(pngDataUrl)
  })

  it('loads content images lazily and without a referrer (SEC-5)', async () => {
    const { ClickableImage } = await import('@/packages/ai/message')
    render(
      React.createElement(ClickableImage, {
        src: 'https://tracker.example.test/pixel.png',
        alt: 'remote.png',
      })
    )
    const img = screen.getAllByAltText('remote.png')[0]
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})

describe('MessageResponse', () => {
  it('normalizes bare unicode box diagrams into text code fences', async () => {
    const { normalizeAssistantMarkdownForDisplay } = await import('@/packages/ai/message')

    const source = [
      '4.2 数据流：从管理后台到存储',
      '┌─────────────────────────────┐',
      '│ ACCOUNTING_ADMIN_PORTAL      │',
      '├─────────────────────────────┤',
      '│ /adminv2/api/grpc-proxy      │',
      '└─────────────────────────────┘',
      '',
      '下一段内容',
    ].join('\n')

    expect(normalizeAssistantMarkdownForDisplay(source)).toBe([
      '4.2 数据流：从管理后台到存储',
      '',
      '```text',
      '┌─────────────────────────────┐',
      '│ ACCOUNTING_ADMIN_PORTAL      │',
      '├─────────────────────────────┤',
      '│ /adminv2/api/grpc-proxy      │',
      '└─────────────────────────────┘',
      '```',
      '',
      '下一段内容',
    ].join('\n'))
  })

  it('normalizes bare ascii box diagrams without changing markdown tables', async () => {
    const { normalizeAssistantMarkdownForDisplay } = await import('@/packages/ai/message')

    const source = [
      '+----------------------+',
      '| service | database   |',
      '+----------------------+',
      '',
      '| col | value |',
      '| --- | ----- |',
      '| a   | b     |',
    ].join('\n')

    expect(normalizeAssistantMarkdownForDisplay(source)).toBe([
      '```text',
      '+----------------------+',
      '| service | database   |',
      '+----------------------+',
      '```',
      '',
      '| col | value |',
      '| --- | ----- |',
      '| a   | b     |',
    ].join('\n'))
  })

  it('falls back to plain text when markdown rendering throws', async () => {
    shouldThrowMarkdown = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, 'hello **world**')
        )
      )
    )

    expect(screen.getByText('hello **world**')).toBeDefined()
    expect(screen.queryByTestId('markdown')).toBeNull()

    warnSpy.mockRestore()
  })

  it('renders mermaid fenced code with a diagram container instead of a plain code block', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const mermaidSource = [
      '```mermaid',
      'flowchart LR',
      '  A[Start] --> B[Done]',
      '```',
    ].join('\n')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, mermaidSource)
        )
      )
    )

    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="mermaid-svg"]')).toBeTruthy()
    })
    expect(container.querySelector('pre')).toBeNull()
  })

  it('opens a larger mermaid preview without rendering the diagram again', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const mermaidSource = [
      '```mermaid',
      'flowchart LR',
      '  A[Start] --> B[Done]',
      '```',
    ].join('\n')

    render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, mermaidSource)
        )
      )
    )

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeTruthy()
      expect(screen.getByTestId('mermaid-svg')).toBeTruthy()
    })

    expect(mermaidRenderMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '放大流程图' }))

    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(mermaidRenderMock).toHaveBeenCalledTimes(1)
  })

  it('uses a compact mermaid preview button and content-sized dialog', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, '```mermaid\nflowchart LR\nA --> B\n```')
        )
      )
    )

    const expandButton = await screen.findByRole('button', { name: '放大流程图' })
    expect(expandButton.className).toContain('h-6 w-6')

    fireEvent.click(expandButton)

    const dialogContent = await screen.findByTestId('dialog-content')
    expect(dialogContent.className).toContain('max-h-[82vh]')
    expect(dialogContent.className).not.toContain('h-[86vh]')
  })

  it('falls back to a normal mermaid code block when diagram rendering fails', async () => {
    mermaidRenderMock.mockRejectedValueOnce(new Error('render failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const mermaidSource = [
      '```mermaid',
      'flowchart LR',
      '  A[Broken] --> B[Fallback]',
      '```',
    ].join('\n')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, mermaidSource)
        )
      )
    )

    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull()
      expect(container.querySelector('pre')).toBeTruthy()
      expect(container.querySelector('code')?.textContent).toContain('flowchart LR')
    })
    expect(warnSpy).toHaveBeenCalledWith(
      '[MessageResponse] Mermaid render failed, falling back to code block',
      expect.any(Error),
    )

    warnSpy.mockRestore()
  })

  it('uses the dark mermaid theme when the document is in dark mode', async () => {
    document.documentElement.classList.add('dark')
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, '```mermaid\nflowchart LR\nA --> B\n```')
        )
      )
    )

    await waitFor(() => {
      expect(mermaidInitializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
    })
  })

  it('keeps non-mermaid fenced code on the normal code block path', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, '```typescript\nconst answer = 42\n```')
        )
      )
    )

    expect(container.querySelector('[data-testid="mermaid-block"]')).toBeNull()
    expect(container.querySelector('pre')).toBeTruthy()
    expect(container.querySelector('pre')?.className).toContain('[overflow-wrap:normal]')
    expect(screen.getByText('const answer = 42')).toBeTruthy()
    expect(mermaidRenderMock).not.toHaveBeenCalled()
  })

  it('renders fenced code without a language as a block', async () => {
    const { Message, MessageContent, MessageResponse } = await import('@/packages/ai/message')

    const { container } = render(
      React.createElement(Message, { from: 'assistant' },
        React.createElement(MessageContent, null,
          React.createElement(MessageResponse, null, '```\n┌────┐\n│ UI │\n└────┘\n```')
        )
      )
    )

    expect(container.querySelector('pre')).toBeTruthy()
    expect(container.querySelector('pre')?.textContent).toContain('┌────┐')
    expect(container.querySelector('code')?.className).not.toContain('[overflow-wrap:anywhere]')
  })
})
