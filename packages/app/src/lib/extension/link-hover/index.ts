export {
  LINK_HOVER_CONFIG_KEY,
  DEFAULT_LINK_HOVER_CONFIG,
  normalizeDomainEntry,
  normalizeUrlPattern,
  isHostAllowed,
  matchUrlGlob,
  isLinkUrlAllowed,
  parseLinkHoverConfig,
  isLinkHoverEnabledForHost,
  addDomainToConfig,
  removeDomainFromConfig,
  addUrlPatternToConfig,
  removeUrlPatternFromConfig,
  type LinkHoverConfig,
} from './config'

export {
  readLinkHoverConfig,
  writeLinkHoverConfig,
  watchLinkHoverConfig,
  getBakedLinkHoverConfig,
} from './chrome-storage'
