import { extensionSidePanelDomains } from '@/lib/config/build-config'
/** Patterns baked into the extension web build (empty = ungated). */
export function getConfiguredSidePanelDomainPatterns(): string[] {
  return [...extensionSidePanelDomains]
}

