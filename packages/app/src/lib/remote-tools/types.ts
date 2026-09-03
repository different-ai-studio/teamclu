export const TOOL_GET_PAGE_DOM = 'get_page_dom' as const
export const TOOL_SHOW_PAGE_NAV_LINKS = 'show_page_nav_links' as const
export const TOOL_NAVIGATE = 'navigate' as const

export type RemoteToolName = typeof TOOL_GET_PAGE_DOM | typeof TOOL_SHOW_PAGE_NAV_LINKS

export type GetPageDomArgs = {
  mode?: 'outline' | 'text'
  max_chars?: number
}

export type GetPageDomResult = {
  url: string
  title: string
  mode: 'outline' | 'text'
  content: string
  truncated: boolean
}

export type RemoteToolExecutor = (args: Record<string, unknown>) => Promise<unknown>

export const REMOTE_TOOL_ERROR = {
  unsupportedPlatform: 'unsupported_platform',
  unknownTool: 'unknown_tool',
  executorError: 'executor_error',
  forbidden: 'forbidden',
} as const
