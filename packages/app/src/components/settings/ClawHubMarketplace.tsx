import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Search,
  Loader2,
  Download,
  Star,
  ArrowUpCircle,
  Check,
  ExternalLink,
  ShieldAlert,
  Ban,
  Clock,
  ChevronDown,
  AlertCircle,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { ensureAgentsSkillsPaths } from "@/lib/skills/ensure-agents-paths"
import { openExternalUrl } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingCard } from "./shared"
import type {
  ClawHubSearchResults,
  ClawHubExploreResults,
  ClawHubSkillListItem,
  ClawHubSearchResultEntry,
  ClawHubSkillDetail,
  ClawHubLockfile,
} from "@/lib/clawhub/types"
import { clawhubInstalledSlugs, parseStats } from "@/lib/clawhub/types"
import { useEffectiveWorkspacePath } from "@/lib/effective-workspace"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface ClawHubMarketplaceProps {
  onInstalled?: () => void | Promise<void>
  sharedSearchQuery?: string
  onSharedSearchQueryChange?: (value: string) => void
  externalSearch?: boolean
  externalRefreshSignal?: number
}

export const ClawHubMarketplace = React.memo(function ClawHubMarketplace({
  onInstalled,
  sharedSearchQuery,
  onSharedSearchQueryChange,
  externalSearch = false,
  externalRefreshSignal = 0,
}: ClawHubMarketplaceProps) {
  const { t } = useTranslation()
  const workspacePath = useEffectiveWorkspacePath()

  const [searchQuery, setSearchQuery] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Explore mode (browse) vs search mode
  const [exploreItems, setExploreItems] = React.useState<ClawHubSkillListItem[]>([])
  const [searchResults, setSearchResults] = React.useState<ClawHubSearchResultEntry[]>([])
  const [isSearchMode, setIsSearchMode] = React.useState(false)
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)

  // Installed skills tracking
  const [installedSlugs, setInstalledSlugs] = React.useState<Set<string>>(new Set())
  const [installingSlugs, setInstallingSlugs] = React.useState<Set<string>>(new Set())

  // Detail dialog
  const [detailSlug, setDetailSlug] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<ClawHubSkillDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = React.useState(false)
  const effectiveSearchQuery = externalSearch ? (sharedSearchQuery ?? "") : searchQuery

  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasLoadedExploreRef = React.useRef(false)
  const installedLoadGenRef = React.useRef(0)

  const loadInstalled = React.useCallback(async () => {
    if (!workspacePath) return
    const loadGen = ++installedLoadGenRef.current
    try {
      const lock = await invoke<ClawHubLockfile>("clawhub_list_installed", { workspacePath })
      if (loadGen !== installedLoadGenRef.current) return
      // Lockfile is shared with the team registry. Only ClawHub rows (and
      // legacy rows with no source) belong in this marketplace's Installed set;
      // a team pack looking installed here makes Uninstall error.
      setInstalledSlugs(new Set(clawhubInstalledSlugs(lock)))
    } catch {
      if (loadGen !== installedLoadGenRef.current) return
      setInstalledSlugs(new Set())
    }
  }, [workspacePath])

  const loadExplore = React.useCallback(
    async (append?: boolean, cursor?: string) => {
      if (append === true) {
        setIsLoadingMore(true)
      } else {
        setIsLoading(true)
      }
      setError(null)

      try {
        const result = await invoke<ClawHubExploreResults>("clawhub_explore", {
          limit: 25,
          sort: null,
          cursor: cursor ?? null,
        })
        if (append === true) {
          setExploreItems((prev) => [...prev, ...result.items])
        } else {
          setExploreItems(result.items)
        }
        setNextCursor(result.nextCursor)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    },
    []
  )

  const doSearch = React.useCallback(async (query: string) => {
    if (!query.trim()) {
      setIsSearchMode(false)
      return
    }
    setIsSearchMode(true)
    setIsLoading(true)
    setError(null)

    try {
      const result = await invoke<ClawHubSearchResults>("clawhub_search", {
        query: query.trim(),
        limit: 30,
      })
      setSearchResults(result.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadInstalled()
    if (!hasLoadedExploreRef.current) {
      hasLoadedExploreRef.current = true
      loadExplore()
    }
    return () => {
      // Invalidate in-flight installed scans so unmount cannot setState
      // after the jsdom window is torn down (vitest teardown race).
      installedLoadGenRef.current += 1
    }
  }, [loadInstalled, loadExplore])

  // Debounced search
  const handleSearchChange = React.useCallback(
    (value: string) => {
      if (externalSearch) {
        onSharedSearchQueryChange?.(value)
      } else {
        setSearchQuery(value)
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      if (!value.trim()) {
        setIsSearchMode(false)
        return
      }
      searchTimerRef.current = setTimeout(() => {
        doSearch(value)
      }, 400)
    },
    [doSearch, externalSearch, onSharedSearchQueryChange]
  )

  React.useEffect(() => {
    if (!externalSearch) return
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }
    if (!effectiveSearchQuery.trim()) {
      setIsSearchMode(false)
      return
    }
    searchTimerRef.current = setTimeout(() => {
      void doSearch(effectiveSearchQuery)
    }, 300)
  }, [doSearch, effectiveSearchQuery, externalSearch])

  React.useEffect(() => {
    if (!externalRefreshSignal) return
    hasLoadedExploreRef.current = false
    if (effectiveSearchQuery.trim()) {
      void doSearch(effectiveSearchQuery)
      return
    }
    setIsSearchMode(false)
    void loadExplore()
    void loadInstalled()
  }, [doSearch, effectiveSearchQuery, externalRefreshSignal, loadExplore, loadInstalled])

  const handleInstall = React.useCallback(
    async (slug: string) => {
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("clawhub_install", {
          workspacePath: workspacePath ?? null,
          slug,
          version: null,
          force: false,
          isGlobal: true,
        })
        await ensureAgentsSkillsPaths(workspacePath)
        setInstalledSlugs((prev) => new Set(prev).add(slug))
        await onInstalled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    },
    [workspacePath, onInstalled]
  )

  const openInstallDialog = React.useCallback(
    (slug: string) => {
      void handleInstall(slug)
    },
    [handleInstall],
  )

  const handleUninstall = React.useCallback(
    async (slug: string) => {
      if (!workspacePath) return
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("clawhub_uninstall", {
          workspacePath,
          slug,
        })
        setInstalledSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
        await onInstalled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    },
    [workspacePath, onInstalled]
  )

  const handleUpdate = React.useCallback(
    async (slug: string) => {
      if (!workspacePath) return
      setInstallingSlugs((prev) => new Set(prev).add(slug))
      try {
        await invoke<string>("clawhub_update", {
          workspacePath,
          slug,
          version: null,
        })
        await onInstalled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlugs((prev) => {
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
      }
    },
    [workspacePath, onInstalled]
  )

  const openDetail = React.useCallback(async (slug: string) => {
    setDetailSlug(slug)
    setIsLoadingDetail(true)
    setDetail(null)
    try {
      const d = await invoke<ClawHubSkillDetail>("clawhub_get_skill", { slug })
      setDetail(d)
    } catch {
      // leave detail null
    } finally {
      setIsLoadingDetail(false)
    }
  }, [])

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString()
  }

  const hasVisibleResults = isSearchMode ? searchResults.length > 0 : exploreItems.length > 0
  const showInitialSkeleton = isLoading && !hasVisibleResults
  const showLoadingHint = isLoading && hasVisibleResults

  const renderSkillCard = (slug: string, name: string, summary?: string | null, version?: string | null, stats?: unknown, updatedAt?: number) => {
    const isInstalled = installedSlugs.has(slug)
    const isInstalling = installingSlugs.has(slug)
    const parsed = parseStats(stats)

    return (
      <SettingCard key={slug} className="cursor-pointer transition-colors hover:border-primary/30">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="flex-1 min-w-0" onClick={() => openDetail(slug)}>
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{name}</span>
              {version && (
                <span className="text-xs text-muted-foreground shrink-0">v{version}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{slug}</p>
            {summary && (
              <p className="text-[13px] text-muted-foreground mt-2 line-clamp-2">{summary}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {parsed.stars != null && parsed.stars > 0 && (
                <span className="flex items-center gap-1">
                  <Star className="h-3 w-3" />
                  {parsed.stars}
                </span>
              )}
              {parsed.downloads != null && parsed.downloads > 0 && (
                <span className="flex items-center gap-1">
                  <Download className="h-3 w-3" />
                  {parsed.downloads.toLocaleString()}
                </span>
              )}
              {parsed.installsCurrent != null && parsed.installsCurrent > 0 && (
                <span className="flex items-center gap-1">
                  <ArrowUpCircle className="h-3 w-3" />
                  {parsed.installsCurrent.toLocaleString()}
                </span>
              )}
              {updatedAt && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatTime(updatedAt)}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 self-start" onClick={(e) => e.stopPropagation()}>
            {isInstalled ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                    disabled={isInstalling}
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    {t("clawhub.installed", "Installed")}
                    <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => handleUpdate(slug)}
                    disabled={isInstalling}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-2" />
                    {t("clawhub.update", "Update")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleUninstall(slug)}
                    disabled={isInstalling}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    {t("clawhub.uninstall", "Uninstall")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={isInstalling}
                onClick={() => openInstallDialog(slug)}
              >
                {isInstalling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {t("clawhub.install", "Install")}
              </Button>
            )}
          </div>
        </div>
      </SettingCard>
    )
  }

  return (
    <div className="min-w-0 space-y-4">
      {!externalSearch ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="relative min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("clawhub.searchPlaceholder", "Search ClawHub skills...")}
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9 h-8"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={isLoading}
            onClick={() => {
              hasLoadedExploreRef.current = false
              if (effectiveSearchQuery.trim()) {
                void doSearch(effectiveSearchQuery)
              } else {
                setIsSearchMode(false)
                void loadExplore()
              }
              loadInstalled()
            }}
            title={t("clawhub.refresh", "Refresh")}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      ) : null}

      {/* Error */}
      {error && (
        <SettingCard className="bg-destructive/10 border-destructive/50">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-destructive">{t("common.error", "Error")}</p>
              <p className="text-[13px] text-destructive/80 mt-1">{error}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null)
                loadExplore()
              }}
              disabled={isLoading}
              className="gap-1.5 shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              {t("common.retry", "Retry")}
            </Button>
          </div>
        </SettingCard>
      )}

      {showLoadingHint && (
        <div className="flex items-center justify-end gap-2 px-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("common.loading", "Loading...")}
        </div>
      )}

      {/* Results */}
      {showInitialSkeleton ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <SettingCard key={index} className="border-border/60 bg-card/80">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                <div className="space-y-3">
                  <Skeleton className="h-5 w-44" />
                  <Skeleton className="h-3.5 w-32" />
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-12" />
                  </div>
                </div>
                <Skeleton className="h-8 w-24 rounded-lg" />
              </div>
            </SettingCard>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {isSearchMode ? (
            searchResults.length === 0 ? (
              <SettingCard>
                <div className="text-center py-6 text-muted-foreground">
                  <Search className="h-8 w-8 mx-auto mb-3 opacity-50" />
                  <p className="font-medium">{t("clawhub.noResults", "No skills found")}</p>
                  <p className="text-[13px] mt-1">{t("clawhub.noResultsHint", "Try different search terms")}</p>
                </div>
              </SettingCard>
            ) : (
              searchResults.map((r) =>
                renderSkillCard(
                  r.slug ?? "unknown",
                  r.displayName ?? r.slug ?? "Unknown",
                  r.summary,
                  r.version,
                  undefined,
                  r.updatedAt
                )
              )
            )
          ) : exploreItems.length === 0 ? (
            <SettingCard>
              <div className="text-center py-6 text-muted-foreground">
                <Search className="h-8 w-8 mx-auto mb-3 opacity-50" />
                <p className="font-medium">{t("clawhub.empty", "No skills available")}</p>
                <p className="text-[13px] mt-1">{t("clawhub.emptyHint", "Check back later for new skills")}</p>
              </div>
            </SettingCard>
          ) : (
            <>
              {exploreItems.map((item) =>
                renderSkillCard(
                  item.slug,
                  item.displayName,
                  item.summary,
                  item.latestVersion?.version,
                  item.stats,
                  item.updatedAt
                )
              )}
              {nextCursor && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={isLoadingMore}
                    onClick={() => loadExplore(true, nextCursor)}
                  >
                    {isLoadingMore ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    {t("clawhub.loadMore", "Load More")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!detailSlug} onOpenChange={(open) => { if (!open) setDetailSlug(null) }}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{detail?.skill?.displayName ?? detailSlug}</DialogTitle>
            <DialogDescription>{detail?.skill?.slug}</DialogDescription>
          </DialogHeader>

          {isLoadingDetail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : detail ? (
            <div className="flex-1 overflow-y-auto space-y-4 py-2">
              {/* Moderation warnings */}
              {detail.moderation?.isMalwareBlocked && (
                <div className="flex items-center gap-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-[13px] text-red-700 dark:text-red-300">
                  <Ban className="h-4 w-4 shrink-0" />
                  {t("clawhub.malwareBlocked", "This skill is flagged as malware and cannot be installed.")}
                </div>
              )}
              {detail.moderation?.isSuspicious && !detail.moderation?.isMalwareBlocked && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-[13px] text-amber-700 dark:text-amber-300">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  {t("clawhub.suspicious", "This skill is flagged as suspicious. Review carefully before installing.")}
                </div>
              )}

              {/* Summary */}
              {detail.skill?.summary && (
                <p className="text-[13px] text-muted-foreground">{detail.skill.summary}</p>
              )}

              {/* Meta */}
              <div className="grid grid-cols-2 gap-3 text-[13px]">
                {detail.owner?.handle && (
                  <div>
                    <span className="text-muted-foreground">{t("clawhub.author", "Author")}: </span>
                    <span className="font-medium">{detail.owner.displayName ?? detail.owner.handle}</span>
                  </div>
                )}
                {detail.latestVersion && (
                  <div>
                    <span className="text-muted-foreground">{t("clawhub.version", "Version")}: </span>
                    <span className="font-medium">v{detail.latestVersion.version}</span>
                  </div>
                )}
                {detail.skill && (() => {
                  const s = parseStats(detail.skill.stats)
                  return (
                    <>
                      {s.stars != null && s.stars > 0 && (
                        <div className="flex items-center gap-1">
                          <Star className="h-3.5 w-3.5 text-amber-500" />
                          <span>{s.stars} {t("clawhub.stars", "stars")}</span>
                        </div>
                      )}
                      {s.downloads != null && s.downloads > 0 && (
                        <div className="flex items-center gap-1">
                          <Download className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{s.downloads.toLocaleString()} {t("clawhub.downloads", "downloads")}</span>
                        </div>
                      )}
                    </>
                  )
                })()}
                {detail.skill?.updatedAt && (
                  <div>
                    <span className="text-muted-foreground">{t("clawhub.updated", "Updated")}: </span>
                    <span>{formatTime(detail.skill.updatedAt)}</span>
                  </div>
                )}
              </div>

              {/* Changelog */}
              {detail.latestVersion?.changelog && (
                <div>
                  <h4 className="text-[13px] font-medium mb-1">{t("clawhub.changelog", "Changelog")}</h4>
                  <p className="text-[13px] text-muted-foreground whitespace-pre-wrap">
                    {detail.latestVersion.changelog}
                  </p>
                </div>
              )}

              {/* ClawHub link */}
              <button
                onClick={() => openExternalUrl(`https://cn.clawhub-mirror.com/${detail?.owner?.handle ?? ''}/${detailSlug}`)}
                className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("clawhub.viewOnClawHub", "View on ClawHub")}
              </button>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailSlug(null)}>
              {t("common.close", "Close")}
            </Button>
            {detailSlug && !detail?.moderation?.isMalwareBlocked && (
              installedSlugs.has(detailSlug) ? (
                <Button
                  variant="outline"
                  className="gap-1.5 text-destructive"
                  disabled={installingSlugs.has(detailSlug)}
                  onClick={() => {
                    handleUninstall(detailSlug)
                    setDetailSlug(null)
                  }}
                >
                  {t("clawhub.uninstall", "Uninstall")}
                </Button>
              ) : (
                <Button
                  className="gap-1.5"
                  disabled={installingSlugs.has(detailSlug)}
                  onClick={() => {
                    openInstallDialog(detailSlug)
                    setDetailSlug(null)
                  }}
                >
                  {installingSlugs.has(detailSlug) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t("clawhub.install", "Install")}
                </Button>
              )
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
