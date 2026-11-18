//! Column three: the conversation, or the detail view a nav section owns
//! (team-share items, ideas, contacts) while that section is selected.
//! Files and web tabs no longer cover it — they open in column four
//! (components/content-column/ContentColumn.tsx).

import * as React from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyNamed } from "@/lib/lazy-component";
import { PaneLoading } from "@/components/ui/pane-loading";
import { useUIStore } from "@/stores/ui";
import { teamShareSectionForTarget } from "@/lib/tabs/teamshare-target";
import { useTeamShareBrowserStore } from "@/stores/team-share-browser";

const TeamShareDetailContent = lazyNamed(
  () => import("@/components/teamshare/TeamShareTabContent"),
  "TeamShareDetailContent",
);
const IdeasDetailColumn = lazyNamed(
  () => import("@/components/panel/IdeaDetailPane"),
  "IdeasDetailColumn",
);
const ActorsDetailColumn = lazyNamed(
  () => import("@/components/main-content/ActorDetailPane"),
  "ActorsDetailColumn",
);

// ChatPanel stays mounted underneath a section's detail view so the
// conversation keeps its state (scroll, draft, streaming) while it is covered.
export function MainContent() {
  const sidebarFilter = useUIStore((s) => s.sidebarFilter);
  const teamShareDetail = useTeamShareBrowserStore((s) => s.detailTarget);
  const directTeamShareSection =
    sidebarFilter.kind === "teamShare" && sidebarFilter.section !== "knowledge"
      ? sidebarFilter.section
      : null;
  const visibleTeamShareDetail =
    directTeamShareSection && teamShareSectionForTarget(teamShareDetail) === directTeamShareSection
      ? teamShareDetail
      : null;
  const directIdeasSection = sidebarFilter.kind === "ideas";
  const directActorsSection = sidebarFilter.kind === "actors";
  const sectionOwned = !!directTeamShareSection || directIdeasSection || directActorsSection;

  return (
    <div className="relative h-full flex flex-col">
      {directTeamShareSection ? (
        <div className="absolute inset-0 z-10 bg-background">
          {visibleTeamShareDetail ? (
            <React.Suspense fallback={<PaneLoading />}>
              <TeamShareDetailContent target={visibleTeamShareDetail} />
            </React.Suspense>
          ) : null}
        </div>
      ) : directIdeasSection ? (
        <div className="absolute inset-0 z-10 bg-background">
          <React.Suspense fallback={<PaneLoading />}>
            <IdeasDetailColumn />
          </React.Suspense>
        </div>
      ) : directActorsSection ? (
        <div className="absolute inset-0 z-10 bg-background">
          <React.Suspense fallback={<PaneLoading />}>
            <ActorsDetailColumn />
          </React.Suspense>
        </div>
      ) : null}
      <div className={`absolute inset-0 ${sectionOwned ? "invisible" : "visible"}`}>
        <ErrorBoundary scope="Chat" inline>
          <ChatPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}
