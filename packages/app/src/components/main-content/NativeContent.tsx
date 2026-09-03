import { Suspense } from "react"
import { useTranslation } from "react-i18next"
import { FileQuestion } from "lucide-react"
import { lazyNamed } from "@/lib/lazy-component"
import { PaneLoading } from "@/components/ui/pane-loading"
import {
  decodeCloudVersionTarget,
  decodeKnowledgeConflictTarget,
  decodeTeamShareTarget,
  decodeVersionHistoryTarget,
} from "@/lib/tabs/teamshare-target"
import { decodeAppDataTarget } from "@/lib/tabs/app-tabs"

// Every native tab body is a large, rarely opened subtree (team share, apps,
// knowledge versioning). They load on first render so the tab bar itself
// costs nothing at startup.
const VersionHistoryTab = lazyNamed(
  () => import("@/components/version/VersionHistoryTab"),
  "VersionHistoryTab",
)
const KnowledgeVersionHistory = lazyNamed(
  () => import("@/components/teamshare/KnowledgeVersionHistory"),
  "KnowledgeVersionHistory",
)
const KnowledgeConflictResolver = lazyNamed(
  () => import("@/components/teamshare/KnowledgeConflictResolver"),
  "KnowledgeConflictResolver",
)
const KnowledgeCloudVersion = lazyNamed(
  () => import("@/components/teamshare/KnowledgeCloudVersion"),
  "KnowledgeCloudVersion",
)
const TeamShareTabContent = lazyNamed(
  () => import("@/components/teamshare/TeamShareTabContent"),
  "TeamShareTabContent",
)
const AppDataTabContent = lazyNamed(
  () => import("@/components/apps/AppDataTabContent"),
  "AppDataTabContent",
)

interface NativeContentProps {
  target: string
}

/**
 * Native tabs are addressed by a target string, and the string is parsed rather
 * than looked up in a table: team-share views and version history carry an id or
 * a path inside the target, so a flat `Record<string, Component>` cannot express
 * them.
 */
export function NativeContent({ target }: NativeContentProps) {
  const { t } = useTranslation()

  const body = resolveNativeBody(target)
  if (body) return <Suspense fallback={<PaneLoading />}>{body}</Suspense>

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center text-muted-foreground">
        <FileQuestion className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p className="text-sm">
          {t("nativeContent.notFound", "组件未找到")}
        </p>
        <p className="text-xs mt-1 opacity-70">{target}</p>
      </div>
    </div>
  )
}

function resolveNativeBody(target: string) {
  const teamShare = decodeTeamShareTarget(target)
  if (teamShare) return <TeamShareTabContent target={teamShare} />

  const appData = decodeAppDataTarget(target)
  if (appData) return <AppDataTabContent target={target} />

  const conflictPath = decodeKnowledgeConflictTarget(target)
  if (conflictPath) return <KnowledgeConflictResolver path={conflictPath} />

  const cloudPath = decodeCloudVersionTarget(target)
  if (cloudPath) return <KnowledgeCloudVersion path={cloudPath} />

  const versionPath = decodeVersionHistoryTarget(target)
  if (versionPath !== undefined) {
    // A path means "this file's history"; the bare target is the browse-all view.
    return versionPath ? <KnowledgeVersionHistory path={versionPath} /> : <VersionHistoryTab />
  }

  return null
}
