import { useTranslation } from "react-i18next"
import { FileQuestion } from "lucide-react"
import { VersionHistoryTab } from "@/components/version/VersionHistoryTab"
import { KnowledgeVersionHistory } from "@/components/teamshare/KnowledgeVersionHistory"
import { KnowledgeConflictResolver } from "@/components/teamshare/KnowledgeConflictResolver"
import { TeamShareTabContent } from "@/components/teamshare/TeamShareTabContent"
import { ActorDetailPane } from "@/components/main-content/ActorDetailPane"
import {
  decodeKnowledgeConflictTarget,
  decodeTeamShareTarget,
  decodeVersionHistoryTarget,
} from "@/lib/tabs/teamshare-target"
import { decodeActorTarget } from "@/lib/tabs/actor-target"

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

  const teamShare = decodeTeamShareTarget(target)
  if (teamShare) return <TeamShareTabContent target={teamShare} />

  const actorId = decodeActorTarget(target)
  if (actorId) return <ActorDetailPane actorId={actorId} />

  const conflictPath = decodeKnowledgeConflictTarget(target)
  if (conflictPath) return <KnowledgeConflictResolver path={conflictPath} />

  const versionPath = decodeVersionHistoryTarget(target)
  if (versionPath !== undefined) {
    // A path means "this file's history"; the bare target is the browse-all view.
    return versionPath ? <KnowledgeVersionHistory path={versionPath} /> : <VersionHistoryTab />
  }

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
