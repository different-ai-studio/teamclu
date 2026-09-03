import { useEffect, useState } from 'react'
import { isSoloBuild } from '@/lib/config/solo-build'

type LayoutBreakpoint = 'wide' | 'medium' | 'narrow'

const WIDE_MIN_WIDTH = 1024
const SESSION_LIST_MIN_WIDTH = 900

export function getLayoutBreakpointForWidth(width: number): LayoutBreakpoint {
  if (width >= WIDE_MIN_WIDTH) return 'wide'
  if (width >= SESSION_LIST_MIN_WIDTH) return 'medium'
  return 'narrow'
}

/** Solo-agent builds stay locked to narrow (session list as bottom sheet). */
export function resolveLayoutBreakpoint(width: number): LayoutBreakpoint {
  if (isSoloBuild()) return 'narrow'
  return getLayoutBreakpointForWidth(width)
}

function get(): LayoutBreakpoint {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280
  return resolveLayoutBreakpoint(w)
}

export function useLayoutBreakpoint(): LayoutBreakpoint {
  const [bp, setBp] = useState<LayoutBreakpoint>(get)
  useEffect(() => {
    if (isSoloBuild()) {
      setBp('narrow')
      return
    }
    const handler = () => setBp(get())
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return bp
}
