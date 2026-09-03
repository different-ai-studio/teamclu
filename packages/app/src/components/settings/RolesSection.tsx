import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  AlertCircle,
  ChevronDown,
  Copy,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Plus,
  Trash2,
  UserRound,
  WandSparkles,
} from "lucide-react"
import { useSessionStore } from "@/stores/session-store"
import { useUIStore } from "@/stores/ui"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
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
import { SectionHeader, SettingCard } from "./shared"
import {
  attachSkillToRole,
  createEmptyRoleEditorState,
  deleteRole,
  extractSkillDescription,
  loadAllRoles,
  loadAttachableSkills,
  parseRoleMarkdown,
  serializeRoleMarkdown,
  saveRole,
} from "@/lib/roles/loader"
import type { AttachableSkill, RoleEditorState, RoleRecord } from "@/lib/roles/types"
import { useEffectiveWorkspacePath } from "@/lib/workspace/effective-workspace"

type EditorMode = "structured" | "markdown"

interface RolesSectionProps {
  embeddedConsole?: boolean
  onOpenSkill?: (skillName: string) => void
  focusRoleSlug?: string | null
  onFocusHandled?: () => void
  onDataChange?: () => void
}

export const RolesSection = React.memo(function RolesSection({
  embeddedConsole = false,
  onOpenSkill,
  focusRoleSlug,
  onFocusHandled,
  onDataChange,
}: RolesSectionProps) {
  const { t } = useTranslation()
  const workspacePath = useEffectiveWorkspacePath()
  const [roles, setRoles] = React.useState<RoleRecord[]>([])
  const [attachableSkills, setAttachableSkills] = React.useState<AttachableSkill[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false)
  const [editingRole, setEditingRole] = React.useState<RoleRecord | null>(null)
  const [roleToDelete, setRoleToDelete] = React.useState<RoleRecord | null>(null)
  const [editor, setEditor] = React.useState<RoleEditorState>(createEmptyRoleEditorState())
  const [editorMode, setEditorMode] = React.useState<EditorMode>("structured")
  const [isSaving, setIsSaving] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [isAttaching, setIsAttaching] = React.useState<string | null>(null)

  const filteredRoles = React.useMemo(() => {
    if (!searchQuery.trim()) return roles
    const query = searchQuery.toLowerCase()
    return roles.filter((role) =>
      [role.slug, role.description, role.role, role.whenToUse, role.workingStyle].some((value) =>
        value.toLowerCase().includes(query),
      ),
    )
  }, [roles, searchQuery])

  const sortedRoles = React.useMemo(() => {
    return [...filteredRoles].sort((a, b) => {
      const aDefault = workspacePath ? a.filePath.startsWith(`${workspacePath}/.opencode/roles`) : false
      const bDefault = workspacePath ? b.filePath.startsWith(`${workspacePath}/.opencode/roles`) : false
      if (aDefault !== bDefault) return aDefault ? -1 : 1
      return a.slug.localeCompare(b.slug)
    })
  }, [filteredRoles, workspacePath])

  const availableAttachableSkills = React.useMemo(() => {
    const attached = new Set(editor.roleSkills.map((skill) => skill.name))
    return attachableSkills.filter((skill) => !attached.has(skill.filename))
  }, [attachableSkills, editor.roleSkills])

  const loadData = React.useCallback(async () => {
    if (!workspacePath) return
    setIsLoading(true)
    setError(null)
    try {
      const [loadedRoles, loadedSkills] = await Promise.all([
        loadAllRoles(workspacePath),
        loadAttachableSkills(workspacePath),
      ])
      setRoles(loadedRoles)
      setAttachableSkills(loadedSkills)
    } catch (err) {
      console.error("[RolesSection] Failed to load roles:", err)
      setError(err instanceof Error ? err.message : t("settings.roles.loadFailed", "Failed to load roles"))
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath, t])

  React.useEffect(() => {
    void loadData()
  }, [loadData])

  React.useEffect(() => {
    if (!focusRoleSlug) return
    setSearchQuery(focusRoleSlug)
    onFocusHandled?.()
  }, [focusRoleSlug, onFocusHandled])

  const resetDialog = React.useCallback(() => {
    setEditingRole(null)
    setEditor(createEmptyRoleEditorState())
    setEditorMode("structured")
  }, [])

  const openCreateDialog = () => {
    resetDialog()
    setDialogOpen(true)
  }

  const openCreateRoleInChat = () => {
    useUIStore.getState().startNewChat()
    window.setTimeout(() => {
      useSessionStore.getState().setDraftInput("/{create-role} ")
    }, 0)
  }

  const openEditDialog = (role: RoleRecord) => {
    setEditingRole(role)
    setEditor({
      slug: role.slug,
      name: role.name,
      description: role.description,
      role: role.role,
      whenToUse: role.whenToUse,
      workingStyle: role.workingStyle,
      roleSkills: role.roleSkills,
      rawMarkdown: role.rawMarkdown,
    })
    setEditorMode("structured")
    setDialogOpen(true)
  }

  const updateEditor = (patch: Partial<RoleEditorState>) => {
    setEditor((prev) => ({ ...prev, ...patch }))
  }

  const syncStructuredToMarkdown = React.useCallback(() => {
    try {
      const serialized = serializeRoleMarkdown(editor)
      setEditor((prev) => ({ ...prev, rawMarkdown: serialized }))
      return serialized
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.roles.parseFailed", "Failed to parse role markdown"))
      return null
    }
  }, [editor, t])

  const switchEditorMode = (mode: EditorMode) => {
    if (mode === editorMode) return
    if (mode === "markdown") {
      const serialized = syncStructuredToMarkdown()
      if (!serialized) return
    }
    setEditorMode(mode)
  }

  const normalizeRoleSlug = React.useCallback(
    () => (editor.slug || editor.name).trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    [editor.name, editor.slug],
  )

  const handleSave = async () => {
    if (!workspacePath) return
    const normalizedSlug = normalizeRoleSlug()
    if (roles.some((role) => role.slug === normalizedSlug && role.slug !== editingRole?.slug)) {
      setError(t("settings.roles.roleExists", "A role with this name already exists"))
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const nextEditor =
        editorMode === "markdown"
          ? (() => {
              const parsed = parseRoleMarkdown(editor.rawMarkdown, editor.slug || "role")
              return {
                slug: parsed.slug,
                name: parsed.name,
                description: parsed.description,
                role: parsed.role,
                whenToUse: parsed.whenToUse,
                workingStyle: parsed.workingStyle,
                roleSkills: parsed.roleSkills,
                rawMarkdown: editor.rawMarkdown,
              }
            })()
          : editor

      const targetFilePath =
        editingRole && editingRole.slug === normalizedSlug
          ? editingRole.filePath
          : undefined
      const savedRole = await saveRole(workspacePath, nextEditor, targetFilePath)
      if (editingRole && editingRole.slug !== savedRole.slug) {
        await deleteRole(workspacePath, editingRole.slug, editingRole.filePath)
      }
      await loadData()
      onDataChange?.()
      setDialogOpen(false)
      resetDialog()
    } catch (err) {
      console.error("[RolesSection] Failed to save role:", err)
      setError(err instanceof Error ? err.message : t("settings.roles.saveFailed", "Failed to save role"))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!workspacePath || !roleToDelete) return
    setIsDeleting(true)
    setError(null)
    try {
      await deleteRole(workspacePath, roleToDelete.slug, roleToDelete.filePath)
      await loadData()
      onDataChange?.()
      setDeleteConfirmOpen(false)
      setRoleToDelete(null)
    } catch (err) {
      console.error("[RolesSection] Failed to delete role:", err)
      setError(err instanceof Error ? err.message : t("settings.roles.deleteFailed", "Failed to delete role"))
    } finally {
      setIsDeleting(false)
    }
  }

  const handleAttachSkill = async (skill: AttachableSkill, mode: "copy" | "migrate") => {
    if (!workspacePath) return
    const roleSlug = normalizeRoleSlug()
    if (!roleSlug) {
      setError(t("settings.roles.attachRequiresName", "Set a role name before attaching skills"))
      return
    }
    if (roles.some((role) => role.slug === roleSlug && role.slug !== editingRole?.slug)) {
      setError(t("settings.roles.roleExists", "A role with this name already exists"))
      return
    }

    setIsAttaching(`${skill.filename}:${mode}`)
    setError(null)
    try {
      if (!editingRole) {
        await saveRole(workspacePath, { ...editor, slug: roleSlug })
        setEditingRole(await loadAllRoles(workspacePath).then((items) => items.find((item) => item.slug === roleSlug) ?? null))
      } else if (editingRole.slug !== roleSlug) {
        await saveRole(workspacePath, { ...editor, slug: roleSlug })
        setEditingRole(await loadAllRoles(workspacePath).then((items) => items.find((item) => item.slug === roleSlug) ?? null))
      }

      const updatedRole = await attachSkillToRole({
        workspacePath,
        roleSlug,
        skillSlug: skill.filename,
        mode,
      })
      setEditor({
        slug: updatedRole.slug,
        name: updatedRole.name,
        description: updatedRole.description,
        role: updatedRole.role,
        whenToUse: updatedRole.whenToUse,
        workingStyle: updatedRole.workingStyle,
        roleSkills: updatedRole.roleSkills,
        rawMarkdown: updatedRole.rawMarkdown,
      })
      setEditingRole(updatedRole)
      await loadData()
      onDataChange?.()
    } catch (err) {
      console.error("[RolesSection] Failed to attach skill:", err)
      setError(err instanceof Error ? err.message : t("settings.roles.attachFailed", "Failed to attach skill"))
    } finally {
      setIsAttaching(null)
    }
  }

  if (!workspacePath) {
    return (
      <div className="space-y-6">
        {!embeddedConsole ? (
          <SectionHeader
            icon={UserRound}
            title={t("settings.roles.title", "Roles")}
            description={t("settings.roles.description", "Workspace roles that progressively expose role-specific skills")}
            iconColor="text-sky-500"
          />
        ) : null}
        <SettingCard>
          <div className="flex items-center gap-3 text-muted-foreground">
            <AlertCircle className="h-5 w-5" />
            <span>{t("settings.roles.selectWorkspace", "Please select a workspace directory first")}</span>
          </div>
        </SettingCard>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {!embeddedConsole ? (
        <SectionHeader
          icon={UserRound}
          title={t("settings.roles.title", "Roles")}
          description={t("settings.roles.descriptionDetail", "Workspace roles stored in .opencode/roles and loaded by the role plugin")}
          iconColor="text-sky-500"
        />
      ) : null}

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-[13px] text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("settings.roles.searchPlaceholder", "Search roles...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 border-border/70 bg-background pl-9 shadow-none"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => void loadData()} variant="outline" size="sm" className="gap-2 bg-background shadow-none" disabled={isLoading}>
            <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
            {t("common.refresh", "Refresh")}
          </Button>
          <div className="flex items-center">
            <Button onClick={openCreateDialog} size="sm" className="gap-2 rounded-r-none">
              <Plus className="h-4 w-4" />
              {t("settings.roles.addRole", "Add Role")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="default"
                  size="sm"
                  className="rounded-l-none border-l border-white/15 px-2"
                  aria-label={t("settings.roles.addRoleOptions", "Role creation options")}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={openCreateRoleInChat}>
                  {t("settings.roles.createByAgent", "Create by agent")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className={cn(embeddedConsole ? "grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-4" : "space-y-2")}>
        {isLoading ? (
          <div className={cn("space-y-3", embeddedConsole && "col-span-full")}>
            {Array.from({ length: 3 }).map((_, index) => (
              <SettingCard key={index} className="border-border/60 bg-card/70">
                <div className={cn("space-y-3 p-4", embeddedConsole && "min-h-[236px]")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-44" />
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-5 w-28 rounded-full" />
                        <Skeleton className="h-5 w-20 rounded-full" />
                      </div>
                    </div>
                    <Skeleton className="h-8 w-8 rounded-lg" />
                  </div>
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </SettingCard>
            ))}
          </div>
        ) : roles.length === 0 ? (
          <SettingCard className={cn("border-dashed bg-muted/10 py-1", embeddedConsole && "col-span-full")}>
            <div className="py-8 text-center text-muted-foreground">
              <UserRound className="mx-auto mb-3 h-9 w-9 opacity-45" />
              <p className="font-medium text-foreground/80">{t("settings.roles.noRoles", "No roles yet")}</p>
              <p className="mt-1 text-[13px]">{t("settings.roles.noRolesHint", "Create your first role to group role-specific instructions and skills")}</p>
            </div>
          </SettingCard>
        ) : sortedRoles.length === 0 ? (
          <SettingCard className={cn("border-dashed bg-muted/10 py-1", embeddedConsole && "col-span-full")}>
            <div className="py-8 text-center text-muted-foreground">
              <Search className="mx-auto mb-3 h-9 w-9 opacity-45" />
              <p className="font-medium text-foreground/80">{t("settings.roles.noMatchingRoles", "No matching roles")}</p>
              <p className="mt-1 text-[13px]">{t("settings.roles.noMatchingRolesHint", "Try a different search term")}</p>
            </div>
          </SettingCard>
        ) : (
          sortedRoles.map((role) => (
            <div
              key={role.slug}
              role="button"
              tabIndex={0}
              onClick={() => openEditDialog(role)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  openEditDialog(role)
                }
              }}
              className={cn(
                "relative w-full rounded-xl border bg-card/70 px-4 py-3 text-left transition-[background-color,border-color] duration-200 ease-out hover:bg-muted/40",
                embeddedConsole && "h-full min-h-[236px]",
                focusRoleSlug === role.slug && "border-primary/50 bg-primary/5",
              )}
            >
              <div className={cn("flex items-start gap-3", embeddedConsole && "h-full flex-col gap-0")}>
                <div className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background/80", embeddedConsole && "hidden")}>
                  <UserRound className="h-4 w-4 text-foreground/70" />
                </div>
                <div className="min-w-0 flex-1 w-full">
                  <div className={cn("flex items-start justify-between gap-3", embeddedConsole && "min-h-[44px] gap-2")}>
                    <div className={cn("min-w-0 w-full", embeddedConsole && "pr-20")}>
                      <div className={cn("flex min-w-0 flex-wrap items-center gap-2", embeddedConsole && "min-h-[44px] content-start")}>
                        <span className={cn("min-w-0 break-all text-[13px] font-medium text-foreground", embeddedConsole && "text-[1.05rem] leading-8")}>{role.slug}</span>
                        <span className="inline-flex max-w-full items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                          {t("settings.roles.roleSkillsCount", "role skills {{count}}", { count: role.roleSkills.length })}
                        </span>
                        <span className="inline-flex max-w-full items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                          {role.filePath.startsWith(`${workspacePath}/.opencode/roles`)
                            ? t("settings.roles.sourceWorkspace", "Workspace")
                            : t("settings.roles.sourceExternal", "External path")}
                        </span>
                      </div>
                    </div>
                    <div
                      className={cn(
                        "flex shrink-0 items-center gap-1",
                        embeddedConsole && "absolute right-4 top-3 z-10 h-[44px] items-end pb-1",
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          setRoleToDelete(role)
                          setDeleteConfirmOpen(true)
                        }}
                        className="h-8 w-8 rounded-lg bg-transparent p-0 text-destructive hover:!bg-black/8 hover:text-destructive dark:hover:!bg-white/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className={cn(embeddedConsole && "mt-4 h-[108px] overflow-hidden")}>
                    <p className={cn("text-[13px] text-muted-foreground line-clamp-2", embeddedConsole && "line-clamp-3 leading-7")}>
                      {role.description || extractSkillDescription(role.rawMarkdown, role.slug)}
                    </p>
                  </div>
                  {embeddedConsole ? (
                    <div className="mt-auto border-t border-border/70 pt-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/75">
                          {t("settings.roles.linkedSkills", "Linked skills")}
                        </div>
                      </div>
                      <div className="min-h-[32px]">
                        <div className="flex flex-wrap items-center gap-1.5">
                        {role.roleSkills.length > 0 ? (
                          <>
                            {role.roleSkills.slice(0, 2).map((skill) => (
                              <button
                                key={skill.name}
                                type="button"
                                onClick={() => onOpenSkill?.(skill.name)}
                                aria-label={t("settings.roles.openLinkedSkill", "Open linked skill {{name}}", { name: skill.name })}
                                className="inline-flex max-w-full items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                                title={skill.description}
                              >
                                <span className="max-w-[180px] truncate">{skill.name}</span>
                              </button>
                            ))}
                            {role.roleSkills.length > 2 ? (
                              <span className="inline-flex items-center rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                                +{role.roleSkills.length - 2}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-dashed border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                            {t("settings.roles.noLinkedSkills", "No linked skills")}
                          </span>
                        )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 truncate text-[11px] text-muted-foreground/80">{role.filePath}</p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) resetDialog()
        }}
      >
        <DialogContent className="flex h-[min(90vh,980px)] w-[min(900px,85vw)] max-w-[min(900px,85vw)] sm:max-w-[min(900px,85vw)] flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b px-7 py-5">
            <DialogTitle>
              {editingRole ? t("settings.roles.editRole", "Edit Role") : t("settings.roles.createRole", "Create Role")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.roles.dialogDescription", "Edit ROLE.md with structured fields or raw Markdown. Role skills are exposed only after role_load.")}
            </DialogDescription>
          </DialogHeader>

          <div className="shrink-0 px-7 pt-4">
            <div className="grid w-full max-w-[420px] grid-cols-2 rounded-xl bg-muted p-1">
              <button
                onClick={() => switchEditorMode("structured")}
                className={cn(
                  "rounded-lg px-4 py-2 text-[13px] font-medium transition-colors",
                  editorMode === "structured"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("settings.roles.structured", "Structured")}
              </button>
              <button
                onClick={() => switchEditorMode("markdown")}
                className={cn(
                  "rounded-lg px-4 py-2 text-[13px] font-medium transition-colors",
                  editorMode === "markdown"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("settings.roles.markdown", "Markdown")}
              </button>
            </div>
          </div>

          <div
            className={cn(
              "min-h-0 flex-1 px-7 py-5",
              editorMode === "markdown" ? "overflow-hidden" : "overflow-y-auto",
            )}
          >
            {editorMode === "structured" ? (
              <div className="space-y-4">
                <section className="rounded-2xl border bg-muted/15 p-5">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-background/90">
                      <UserRound className="h-4.5 w-4.5 text-foreground/70" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {t("settings.roles.identity", "Role identity")}
                      </div>
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        {t("settings.roles.identityHint", "Define the role name that will be routed by the model, and the short description exposed during progressive disclosure.")}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 space-y-4">
                    <div className="space-y-2">
                      <label className="text-[13px] font-medium">{t("settings.roles.name", "Role Name")}</label>
                      <Input
                        value={editor.slug}
                        onChange={(e) => updateEditor({ slug: e.target.value, name: e.target.value })}
                        placeholder={t("settings.roles.namePlaceholder", "e.g., java-sort-reviewer")}
                        className="h-12 text-base shadow-none"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.roles.nameHint", "Use a stable slug-style identifier. This becomes the role folder name and routing key.")}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[13px] font-medium">{t("settings.roles.descriptionLabel", "Description")}</label>
                      <textarea
                        value={editor.description}
                        onChange={(e) => updateEditor({ description: e.target.value })}
                        placeholder={t("settings.roles.descriptionPlaceholder", "Short role summary for routing")}
                        className="min-h-[120px] w-full resize-y rounded-xl border border-input bg-background px-3 py-3 text-base leading-6 shadow-none focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.roles.descriptionHint", "This is the short summary shown in available_roles, so make it specific and discriminative.")}
                      </p>
                    </div>
                  </div>
                </section>

                <EditorField
                  title={t("settings.roles.roleSection", "Role")}
                  hint={t("settings.roles.roleSectionHint", "Describe the role’s core mandate, expertise boundary, and what it is responsible for in the workspace.")}
                  value={editor.role}
                  onChange={(value) => updateEditor({ role: value })}
                  placeholder={t("settings.roles.rolePlaceholder", "Describe this role's responsibilities")}
                  minHeight="min-h-[220px]"
                />

                <EditorField
                  title={t("settings.roles.whenToUse", "When to use")}
                  hint={t("settings.roles.whenToUseHint", "List the request patterns, files, or task shapes that should trigger this role instead of another one.")}
                  value={editor.whenToUse}
                  onChange={(value) => updateEditor({ whenToUse: value })}
                  placeholder={t("settings.roles.whenToUsePlaceholder", "List the situations where this role should be selected")}
                  minHeight="min-h-[180px]"
                />

                <EditorField
                  title={t("settings.roles.workingStyle", "Working style")}
                  hint={t("settings.roles.workingStyleHint", "Capture behavioral guidelines, review style, priorities, and how the role should communicate or make tradeoffs.")}
                  value={editor.workingStyle}
                  onChange={(value) => updateEditor({ workingStyle: value })}
                  placeholder={t("settings.roles.workingStylePlaceholder", "Describe how this role should operate")}
                  minHeight="min-h-[220px]"
                />

                <div className="space-y-4 rounded-xl border bg-muted/15 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-medium">{t("settings.roles.availableRoleSkills", "Available role skills")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.roles.availableRoleSkillsHint", "Attach local workspace skills and choose whether to copy or migrate them into .opencode/roles/skills")}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t("settings.roles.roleSkillsCount", "role skills {{count}}", { count: editor.roleSkills.length })}
                    </span>
                  </div>

                  {editor.roleSkills.length > 0 ? (
                    <div className="space-y-2">
                      {editor.roleSkills.map((skill) => (
                        <div key={skill.name} className="flex items-start justify-between gap-3 rounded-lg border bg-background px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium">{skill.name}</div>
                            <div className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 rounded-lg p-0"
                            onClick={() => updateEditor({ roleSkills: editor.roleSkills.filter((item) => item.name !== skill.name) })}
                            title={t("common.remove", "Remove")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
                      {t("settings.roles.noAttachedSkills", "No role skills attached yet")}
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t("settings.roles.attachFromSkills", "Attach from workspace skills")}
                    </div>
                    {availableAttachableSkills.length === 0 ? (
                      <div className="rounded-lg border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
                        {t("settings.roles.noAttachableSkills", "No local workspace skills are available to attach")}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {availableAttachableSkills.map((skill) => (
                          <div key={skill.filename} className="flex items-start justify-between gap-3 rounded-lg border bg-background px-3 py-2.5">
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium">{skill.filename}</div>
                              <div className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5 bg-background shadow-none"
                                disabled={isAttaching !== null}
                                onClick={() => void handleAttachSkill(skill, "copy")}
                              >
                                {isAttaching === `${skill.filename}:copy` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
                                {t("settings.roles.copyToRole", "Copy to role")}
                              </Button>
                              <Button
                                size="sm"
                                className="gap-1.5"
                                disabled={isAttaching !== null}
                                onClick={() => void handleAttachSkill(skill, "migrate")}
                              >
                                {isAttaching === `${skill.filename}:migrate` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
                                {t("settings.roles.migrateToRole", "Migrate to role")}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col space-y-2 pb-1">
                <label className="text-[13px] font-medium">{t("settings.roles.markdownContent", "ROLE.md Content")}</label>
                <div className="min-h-0 flex-1 rounded-lg border border-input bg-background px-4 py-3">
                  <pre className="h-full min-h-0 overflow-y-auto whitespace-pre-wrap break-words pb-8 text-[13px] font-mono leading-6 text-foreground">
                    {editor.rawMarkdown}
                  </pre>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t bg-background px-7 py-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="shadow-none">
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("common.saving", "Saving...")}
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {t("common.save", "Save")}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.roles.deleteTitle", "Delete Role")}</DialogTitle>
            <DialogDescription>
              {t(
                "settings.roles.deleteConfirm",
                {
                  name: roleToDelete?.slug ?? "",
                  defaultValue: `Delete "${roleToDelete?.slug ?? ""}"? Role skills under .opencode/roles/skills are preserved.`,
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} className="shadow-none">
              {t("common.cancel", "Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t("common.delete", "Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})

function EditorField({
  title,
  hint,
  value,
  onChange,
  placeholder,
  minHeight = "min-h-[140px]",
}: {
  title: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  minHeight?: string
}) {
  return (
    <section className="rounded-2xl border bg-muted/15 p-5">
      <div className="space-y-1">
        <label className="text-[13px] font-medium">{title}</label>
        {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      <textarea
        className={cn(
          "mt-3 w-full resize-y rounded-xl border border-input bg-background px-3 py-3 text-[13px] leading-6 shadow-none focus:outline-none focus:ring-2 focus:ring-ring",
          minHeight,
        )}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </section>
  )
}
