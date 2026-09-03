import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Shapes, Sparkles, UserRound } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingCard } from "./shared"
import { RolesSection } from "./RolesSection"
import { SkillsSection } from "./SkillsSection"
import { loadRolesSkillsWorkspaceState } from "@/lib/roles/loader"
import type { RolesSkillsWorkspaceState } from "@/lib/roles/types"
import { useEffectiveWorkspacePath } from "@/lib/workspace/effective-workspace"

type ResourceTab = "roles" | "skills"

export const RolesSkillsSection = React.memo(function RolesSkillsSection() {
  const { t } = useTranslation()
  const workspacePath = useEffectiveWorkspacePath()
  const [activeTab, setActiveTab] = React.useState<ResourceTab>("roles")
  const [transitionTargetTab, setTransitionTargetTab] = React.useState<ResourceTab | null>(null)
  const rolesTabRef = React.useRef<HTMLButtonElement>(null)
  const skillsTabRef = React.useRef<HTMLButtonElement>(null)
  const [focusedRoleSlug, setFocusedRoleSlug] = React.useState<string | null>(null)
  const [focusedSkillName, setFocusedSkillName] = React.useState<string | null>(null)
  const [embeddedSkillSearch, setEmbeddedSkillSearch] = React.useState("")
  const [workspaceState, setWorkspaceState] = React.useState<RolesSkillsWorkspaceState | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refreshWorkspaceState = React.useCallback(async () => {
    if (!workspacePath) {
      setWorkspaceState(null)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const nextState = await loadRolesSkillsWorkspaceState(workspacePath)
      setWorkspaceState(nextState)
    } catch (err) {
      console.error("[RolesSkillsSection] Failed to load workspace state:", err)
      setError(
        err instanceof Error
          ? err.message
          : t("settings.rolesSkills.loadFailed", "Failed to load roles and skills"),
      )
    } finally {
      setIsLoading(false)
    }
  }, [t, workspacePath])

  React.useEffect(() => {
    void refreshWorkspaceState()
  }, [refreshWorkspaceState])

  const handleOpenSkill = React.useCallback((skillName: string) => {
    setFocusedRoleSlug(null)
    setFocusedSkillName(skillName)
    setEmbeddedSkillSearch(skillName)
    setTransitionTargetTab(null)
    setActiveTab("skills")
  }, [])

  const handleOpenRole = React.useCallback((roleSlug: string) => {
    setFocusedSkillName(null)
    setFocusedRoleSlug(roleSlug)
    setTransitionTargetTab(null)
    setActiveTab("roles")
  }, [])

  const displayedTab = transitionTargetTab ?? activeTab

  const switchTab = React.useCallback((nextTab: ResourceTab) => {
    if (nextTab === displayedTab) {
      return
    }
    setTransitionTargetTab(nextTab)
  }, [displayedTab])

  React.useEffect(() => {
    if (!transitionTargetTab) {
      return
    }

    const timer = window.setTimeout(() => {
      setActiveTab(transitionTargetTab)
      setTransitionTargetTab(null)
    }, 160)

    return () => {
      window.clearTimeout(timer)
    }
  }, [transitionTargetTab])

  React.useEffect(() => {
    const activeTabButton = activeTab === "roles" ? rolesTabRef.current : skillsTabRef.current
    activeTabButton?.focus()
  }, [activeTab])

  const handleTabKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return
    }

    event.preventDefault()
    switchTab(displayedTab === "roles" ? "skills" : "roles")
  }, [displayedTab, switchTab])

  const metrics = workspaceState?.metrics ?? {
    rolesCount: 0,
    skillsCount: 0,
    linkedSkillsCount: 0,
    unlinkedSkillsCount: 0,
  }
  const isSummaryLoading = isLoading && !workspaceState

  const summaryMetrics = [
    {
      key: "roles",
      label: t("settings.rolesSkills.headerRoles", "{{count}} roles", { count: metrics.rolesCount }),
      value: metrics.rolesCount,
      tone: "text-sky-600 dark:text-sky-400",
    },
    {
      key: "skills",
      label: t("settings.rolesSkills.headerSkills", "{{count}} skills", { count: metrics.skillsCount }),
      value: metrics.skillsCount,
      tone: "text-yellow-600 dark:text-yellow-400",
    },
    {
      key: "linked",
      label: t("settings.rolesSkills.headerLinked", "{{count}} linked skills", { count: metrics.linkedSkillsCount }),
      value: metrics.linkedSkillsCount,
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      key: "unlinked",
      label: t("settings.rolesSkills.linkedWithUnlinked", "{{linked}} linked · {{unlinked}} unlinked", {
        linked: metrics.linkedSkillsCount,
        unlinked: metrics.unlinkedSkillsCount,
      }),
      value: metrics.unlinkedSkillsCount,
      tone: "text-muted-foreground",
    },
  ]

  const tabButtonClass = (tab: ResourceTab) =>
    cn(
      "inline-flex h-8 items-center justify-center gap-2 rounded-[10px] px-5 text-[13px] font-medium transition-colors",
      displayedTab === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground",
    )

  const renderTabSwitchSkeleton = () => (
    <SettingCard className="border-border/70 bg-card/80 shadow-sm">
      <div
        id={`${displayedTab}-panel`}
        role="tabpanel"
        aria-labelledby={`${displayedTab}-tab`}
        aria-busy="true"
        data-testid="roles-skills-switch-skeleton"
        className="space-y-5"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-60" />
          </div>
          <Skeleton className="h-10 w-28 rounded-2xl" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-border/70 bg-background/80 px-3 py-2.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-6 w-12" />
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="rounded-xl border border-border/70 bg-background/80 p-4">
                <Skeleton className="h-5 w-36" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-5/6" />
                <Skeleton className="mt-4 h-8 w-24 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </SettingCard>
  )

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border bg-background">
            <Shapes className="h-4.5 w-4.5 text-foreground/80" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">
              {t("settings.rolesSkills.title", "Roles & Skills")}
            </h1>
            <p className="text-[13px] text-muted-foreground">
              {t(
                "settings.rolesSkills.subtitle",
                "Roles define routing and responsibility. Skills provide reusable execution procedures.",
              )}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}

      <SettingCard className="border-border/70 bg-card/80 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-background">
                <Shapes className="h-4.5 w-4.5 text-foreground/80" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  {t("settings.rolesSkills.workspaceSummary", "Workspace summary")}
                </div>
                <div className="mt-1 text-[13px] text-muted-foreground">
                  {t(
                    "settings.rolesSkills.relationHint",
                    "Manage routing roles and reusable skills together in one workspace console.",
                  )}
                </div>
              </div>
            </div>

            {isSummaryLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="rounded-xl border border-border/70 bg-background/80 px-3 py-2.5">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="mt-2 h-6 w-12" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {summaryMetrics.map((metric) => (
                    <div key={metric.key} className="rounded-xl border border-border/70 bg-background/80 px-3 py-2.5">
                      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        {metric.label}
                      </div>
                      <div className={cn("mt-1 text-base font-semibold", metric.tone)}>{metric.value}</div>
                    </div>
                  ))}
                </div>

                <div className="text-[13px] text-foreground/85">
                  {t("settings.rolesSkills.summaryLine", "{{roles}} roles · {{skills}} skills · {{linked}} linked · {{unlinked}} unlinked", {
                    roles: metrics?.rolesCount ?? 0,
                    skills: metrics?.skillsCount ?? 0,
                    linked: metrics?.linkedSkillsCount ?? 0,
                    unlinked: metrics?.unlinkedSkillsCount ?? 0,
                  })}
                </div>
              </>
            )}
          </div>

          <div className="min-w-0 shrink-0">
            <div
              role="tablist"
              aria-label={t("settings.rolesSkills.title", "Roles & Skills")}
              className="relative inline-grid h-11 grid-cols-2 items-center rounded-[14px] border border-border/70 bg-muted/50 p-1"
            >
              <div className="absolute inset-1">
                <div
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-y-0 left-0 w-1/2 rounded-[10px] border border-border/60 bg-background transition-transform duration-200 ease-out",
                    activeTab === "roles" ? "translate-x-0" : "translate-x-full",
                  )}
                />
              </div>
              <button
                type="button"
                role="tab"
                id="roles-tab"
                ref={rolesTabRef}
                aria-selected={displayedTab === "roles"}
                aria-controls="roles-panel"
                tabIndex={displayedTab === "roles" ? 0 : -1}
                onClick={() => switchTab("roles")}
                onKeyDown={handleTabKeyDown}
                className={cn("relative z-10", tabButtonClass("roles"))}
              >
                <UserRound className="h-4 w-4" />
                {t("settings.roles.title", "Roles")}
              </button>
              <button
                type="button"
                role="tab"
                id="skills-tab"
                ref={skillsTabRef}
                aria-selected={displayedTab === "skills"}
                aria-controls="skills-panel"
                tabIndex={displayedTab === "skills" ? 0 : -1}
                onClick={() => switchTab("skills")}
                onKeyDown={handleTabKeyDown}
                className={cn("relative z-10", tabButtonClass("skills"))}
              >
                <Sparkles className="h-4 w-4" />
                {t("settings.skills.title", "Skills")}
              </button>
            </div>
          </div>
        </div>
      </SettingCard>

      <div className="min-h-[40rem] min-w-0">
        {transitionTargetTab ? (
          renderTabSwitchSkeleton()
        ) : activeTab === "roles" ? (
          <div id="roles-panel" role="tabpanel" aria-labelledby="roles-tab">
            <RolesSection
              embeddedConsole
              onOpenSkill={handleOpenSkill}
              focusRoleSlug={focusedRoleSlug}
              onFocusHandled={() => setFocusedRoleSlug(null)}
              onDataChange={() => void refreshWorkspaceState()}
            />
          </div>
        ) : (
          <div id="skills-panel" role="tabpanel" aria-labelledby="skills-tab">
            <SkillsSection
              embeddedConsole
              roleUsageBySkill={workspaceState?.roleUsageBySkill ?? {}}
              onOpenRole={handleOpenRole}
              focusSkillName={focusedSkillName}
              onFocusHandled={() => setFocusedSkillName(null)}
              onDataChange={() => void refreshWorkspaceState()}
              sharedSearchQuery={embeddedSkillSearch}
              onSharedSearchQueryChange={setEmbeddedSkillSearch}
            />
          </div>
        )}
      </div>

    </div>
  )
})
