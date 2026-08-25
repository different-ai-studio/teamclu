import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { UpdateDialogContainer } from '../UpdateDialog'
import { useUpdaterStore } from '@/stores/updater'

/**
 * The dialog's promise differs by platform, and saying the wrong one is worse
 * than saying nothing: macOS has already written the new bundle by the time
 * this appears, while Windows has only staged an installer that runs on
 * restart. Telling a Windows user "the update has been installed" invites them
 * to click "Restart later" and lose the download.
 */
function setPlatform(value: string) {
  Object.defineProperty(window.navigator, 'platform', {
    value,
    configurable: true,
  })
}

const originalPlatform = window.navigator.platform
const originalUserAgent = window.navigator.userAgent

describe('UpdateDialog restart copy', () => {
  beforeEach(() => {
    useUpdaterStore.setState({
      update: { state: 'ready', version: '1.2.3' },
      pendingUpdate: null,
    })
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    Object.defineProperty(window.navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    })
  })

  it('tells a macOS user the update is already installed', () => {
    setPlatform('MacIntel')
    render(<UpdateDialogContainer />)
    expect(screen.getByText(/更新已安装。请重启以应用更改。/)).toBeInTheDocument()
  })

  // "darwin" contains "win". A substring test on the platform string told every
  // macOS user they were on Windows, which is the more damaging direction: it
  // hides the fact that the bundle is already swapped in.
  it('does not read darwin as Windows', () => {
    setPlatform('')
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (darwin) AppleWebKit/537.36 jsdom/26.0.0',
      configurable: true,
    })
    render(<UpdateDialogContainer />)
    expect(screen.getByText(/更新已安装。请重启以应用更改。/)).toBeInTheDocument()
  })

  it('tells a Windows user the update installs on restart, and that quitting drops it', () => {
    setPlatform('Win32')
    render(<UpdateDialogContainer />)
    expect(screen.getByText(/更新已下载完成。重启即开始安装。/)).toBeInTheDocument()
    expect(screen.getByText(/直接退出则会丢弃这次下载/)).toBeInTheDocument()
    expect(screen.queryByText(/更新已安装。请重启以应用更改。/)).toBeNull()
  })
})
