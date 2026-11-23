//! Where a nav section's item opens while the section replaces the
//! conversation (lib/layout/section-mode.ts): skills / MCP / env show their
//! team-share detail, ideas and contacts their own detail column, and
//! knowledge — whose documents open as column-four tabs — a prompt until one
//! is picked.

import * as React from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Keyboard } from "lucide-react";
import { lazyNamed } from "@/lib/lazy-component";
import { PaneLoading } from "@/components/ui/pane-loading";
import { teamShareSectionForTarget } from "@/lib/tabs/teamshare-target";
import { useTeamShareBrowserStore } from "@/stores/team-share-browser";
import type { SectionMode } from "@/lib/layout/section-mode";

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

/** Knowledge and shortcuts open in column four; until one is, this says so. */
function ContentColumnEmptyState({ section }: { section: "knowledge" | "shortcuts" }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      data-tauri-drag-region
      data-testid={`${section}-empty-state`}
    >
      {section === "knowledge" ? (
        <BookOpen className="h-5 w-5 text-faint" />
      ) : (
        <Keyboard className="h-5 w-5 text-faint" />
      )}
      <p className="text-[12.5px] text-muted-foreground">
        {section === "knowledge"
          ? t("sectionDetail.knowledgeEmpty", "Pick a document on the left to open it here.")
          : t("sectionDetail.shortcutsEmpty", "Pick a shortcut on the left to open it here.")}
      </p>
    </div>
  );
}

export function SectionDetailColumn({ section }: { section: SectionMode }) {
  const teamShareDetail = useTeamShareBrowserStore((s) => s.detailTarget);

  let body: React.ReactNode;
  if (section === "knowledge" || section === "shortcuts") {
    body = <ContentColumnEmptyState section={section} />;
  } else if (section === "ideas") {
    body = <IdeasDetailColumn />;
  } else if (section === "actors") {
    body = <ActorsDetailColumn />;
  } else {
    // A detail left over from another team-share section must not show here.
    const visible =
      teamShareSectionForTarget(teamShareDetail) === section ? teamShareDetail : null;
    body = visible ? <TeamShareDetailContent target={visible} /> : <div className="h-full" data-tauri-drag-region />;
  }

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="section-detail"
      data-section={section}
    >
      <React.Suspense fallback={<PaneLoading />}>{body}</React.Suspense>
    </section>
  );
}
