import { Suspense } from "react"
import { useTranslation } from "react-i18next"
import { FileQuestion } from "lucide-react"
import { lazyNamed } from "@/lib/lazy-component"
import { PaneLoading } from "@/components/ui/pane-loading"
import {
  decodeCloudVersionTarget,
  decodeKnowledgeConflictTarget,
  decodeKnowledgeReviewTarget,
  decodeTeamShareTarget,
  decodeVersionHistoryTarget,
} from "@/lib/tabs/teamshare-target"
import {
  decodeAppAccessTarget,
  decodeAppAuthTarget,
  decodeAppCronTarget,
  decodeAppDataTarget,
  decodeAppEnvTarget,
  decodeAppSettingsTarget,
  decodeAppFilesTarget,
  decodeAppLogsTarget,
  isAppCreateTarget,
  isAppLibraryTarget,
} from "@/lib/tabs/app-tabs"

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
const KnowledgeReviewTab = lazyNamed(
  () => import("@/components/teamshare/KnowledgeReviewTab"),
  "KnowledgeReviewTab",
)
const TeamShareTabContent = lazyNamed(
  () => import("@/components/teamshare/TeamShareTabContent"),
  "TeamShareTabContent",
)
const AppDataTabContent = lazyNamed(
  () => import("@/components/apps/AppDataTabContent"),
  "AppDataTabContent",
)
const AppLogsTabContent = lazyNamed(
  () => import("@/components/apps/AppLogsTabContent"),
  "AppLogsTabContent",
)
const AppAccessTabContent = lazyNamed(
  () => import("@/components/apps/AppAccessTabContent"),
  "AppAccessTabContent",
)
const AppAuthTabContent = lazyNamed(
  () => import("@/components/apps/AppAuthTabContent"),
  "AppAuthTabContent",
)
const AppFilesTabContent = lazyNamed(
  () => import("@/components/apps/AppFilesTabContent"),
  "AppFilesTabContent",
)
const AppCronTabContent = lazyNamed(
  () => import("@/components/apps/AppCronTabContent"),
  "AppCronTabContent",
)
const AppEnvTabContent = lazyNamed(
  () => import("@/components/apps/AppEnvTabContent"),
  "AppEnvTabContent",
)
const AppSettingsTabContent = lazyNamed(
  () => import("@/components/apps/AppSettingsTabContent"),
  "AppSettingsTabContent",
)
const AppLibraryView = lazyNamed(
  () => import("@/components/apps/AppLibraryView"),
  "AppLibraryView",
)
const CreateAppView = lazyNamed(
  () => import("@/components/apps/CreateAppView"),
  "CreateAppView",
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

  const appLogs = decodeAppLogsTarget(target)
  if (appLogs) return <AppLogsTabContent appId={appLogs.appId} />

  const appAccess = decodeAppAccessTarget(target)
  if (appAccess) return <AppAccessTabContent appId={appAccess.appId} />

  const appAuth = decodeAppAuthTarget(target)
  if (appAuth) return <AppAuthTabContent appId={appAuth.appId} />

  const appFiles = decodeAppFilesTarget(target)
  if (appFiles) return <AppFilesTabContent appId={appFiles.appId} />

  const appCron = decodeAppCronTarget(target)
  if (appCron) return <AppCronTabContent appId={appCron.appId} />

  const appEnv = decodeAppEnvTarget(target)
  if (appEnv) return <AppEnvTabContent appId={appEnv.appId} />

  const appSettings = decodeAppSettingsTarget(target)
  if (appSettings) return <AppSettingsTabContent appId={appSettings.appId} />

  if (isAppLibraryTarget(target)) return <AppLibraryView />

  if (isAppCreateTarget(target)) return <CreateAppView />

  const conflictPath = decodeKnowledgeConflictTarget(target)
  if (conflictPath) return <KnowledgeConflictResolver path={conflictPath} />

  const cloudPath = decodeCloudVersionTarget(target)
  if (cloudPath) return <KnowledgeCloudVersion path={cloudPath} />

  const reviewId = decodeKnowledgeReviewTarget(target)
  if (reviewId) return <KnowledgeReviewTab candidateId={reviewId} />

  const versionPath = decodeVersionHistoryTarget(target)
  if (versionPath !== undefined) {
    // A path means "this file's history"; the bare target is the browse-all view.
    return versionPath ? <KnowledgeVersionHistory path={versionPath} /> : <VersionHistoryTab />
  }

  return null
}
