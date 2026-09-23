import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useOnboarding } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import {
  imageOnlyProgressContent,
  useIdeaImageAttachments,
} from "../../src/features/ideas/idea-image-attachments";
import { createLikeSequencer, likeStateOf } from "../../src/features/ideas/idea-likes";
import type { Idea, IdeaActivity, IdeaStatus } from "../../src/features/ideas/idea-types";
import type { IdeaActivityAuthor } from "../../src/features/ideas/components/IdeaActivityTimeline";
import { IdeaDetailScreen } from "../../src/features/ideas/screens/IdeaDetailScreen";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { t } from "../../src/lib/i18n";
import { showToast } from "../../src/ui/Toast";

type BusyAction = "toggleStatus" | "archive" | "save" | null;

export default function IdeaDetailRoute() {
  const { t: tHook } = useTranslation();
  const router = useRouter();
  const { state } = useOnboarding();
  const params = useLocalSearchParams<{ ideaId?: string }>();
  const ideaId = typeof params.ideaId === "string" ? params.ideaId : null;
  const teamId = state.currentTeam?.id ?? "";
  const currentActorId = state.currentMemberActorId;

  const [idea, setIdea] = useState<Idea | null>(null);
  const [creatorName, setCreatorName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [relatedSessions, setRelatedSessions] = useState<
    Array<{ sessionId: string; title: string; lastMessageAt: string }>
  >([]);
  const [activities, setActivities] = useState<IdeaActivity[]>([]);
  const [isLoadingActivities, setIsLoadingActivities] = useState(false);
  const [activityAuthors, setActivityAuthors] = useState<Record<string, IdeaActivityAuthor>>({});
  const [isSubmittingProgress, setIsSubmittingProgress] = useState(false);

  const ideasApi = useMemo(
    () => createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  const onAttachmentError = useCallback((message: string) => showToast("error", message), []);
  const images = useIdeaImageAttachments({
    teamId,
    contextId: ideaId ?? "",
    onError: onAttachmentError,
  });

  const loadActivities = useCallback(async () => {
    if (!ideaId) return;
    setIsLoadingActivities(true);
    try {
      setActivities(await ideasApi.listActivities(ideaId));
    } catch {
      // Soft failure: the rest of the detail screen stays usable.
    } finally {
      setIsLoadingActivities(false);
    }
  }, [ideaId, ideasApi]);

  const refresh = useCallback(async () => {
    if (!teamId || !ideaId) return;
    setIsRefreshing(true);
    try {
      const fresh = await ideasApi.listIdeas(teamId);
      const found = fresh.find((row) => row.ideaId === ideaId) ?? null;
      setIdea(found);
      await loadActivities();
    } finally {
      setIsRefreshing(false);
    }
  }, [ideaId, ideasApi, loadActivities, teamId]);

  useEffect(() => {
    if (!teamId || !ideaId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const actorsApi = createActorsApi({ getAccessToken: supabaseAccessToken(supabase) });
        const [ideas, actors] = await Promise.all([
          ideasApi.listIdeas(teamId),
          actorsApi.listActors(teamId),
        ]);
        if (cancelled) return;
        const found = ideas.find((row) => row.ideaId === ideaId) ?? null;
        setIdea(found);
        if (found?.createdByActorId) {
          const creator = actors.find((row) => row.actorId === found.createdByActorId);
          setCreatorName(creator?.displayName ?? null);
        } else {
          setCreatorName(null);
        }
        // The activity feed only carries actor ids; the directory supplies the
        // name/avatar/kind each row renders (iOS reads the same from CachedActor).
        setActivityAuthors(
          Object.fromEntries(
            actors.map((actor) => [
              actor.actorId,
              {
                actorId: actor.actorId,
                displayName: actor.displayName,
                avatarUrl: actor.avatarUrl,
                isAgent: actor.actorType === "agent",
              },
            ]),
          ),
        );

        const related = await createConfiguredSessionsApi(supabase).listSessionsForIdea(
          teamId,
          ideaId,
          5,
        );
        if (cancelled) return;
        setRelatedSessions(
          related.map((row) => ({
            sessionId: row.sessionId,
            title: row.title ?? "",
            lastMessageAt: row.lastMessageAt ?? "",
          })),
        );
      } catch {
        if (cancelled) return;
        setIdea(null);
        setCreatorName(null);
        setRelatedSessions([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ideaId, ideasApi, teamId]);

  useEffect(() => {
    void loadActivities();
  }, [loadActivities]);

  const handleSubmitProgress = useCallback(
    async (text: string) => {
      if (!ideaId) return;
      if (!currentActorId) {
        showToast("error", tHook("Sign in to a team before posting progress."));
        return;
      }
      const attachmentUrls = images.uploadedUrls;
      const trimmed = text.trim();
      if (!trimmed && attachmentUrls.length === 0) return;
      // Same fallback copy iOS uses for an image-only submission.
      const content = trimmed ? trimmed : imageOnlyProgressContent(attachmentUrls.length);

      setIsSubmittingProgress(true);
      try {
        await ideasApi.createActivity(ideaId, {
          activityType: "progress",
          content,
          actorId: currentActorId,
          attachmentUrls,
        });
        images.reset();
        await loadActivities();
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : tHook("Couldn't post progress."));
      } finally {
        setIsSubmittingProgress(false);
      }
    },
    [currentActorId, ideaId, ideasApi, images, loadActivities, tHook],
  );

  /**
   * Append the `status_change` row iOS writes from `IdeaStore.merge` whenever a
   * status transition lands. The backend doesn't log it, so both clients have
   * to — otherwise the timeline shows only progress notes.
   */
  const logStatusChange = useCallback(
    async (from: IdeaStatus, to: IdeaStatus) => {
      if (!ideaId || !currentActorId || from === to) return;
      try {
        await ideasApi.createActivity(ideaId, {
          activityType: "status_change",
          content: tHook("Changed status from {{from}} to {{to}}", {
            from: statusLabel(from),
            to: statusLabel(to),
          }),
          actorId: currentActorId,
          metadata: { from_status: from, to_status: to },
        });
        await loadActivities();
      } catch {
        // The status itself already saved; the audit row is best-effort.
      }
    },
    [currentActorId, ideaId, ideasApi, loadActivities, tHook],
  );

  const handleToggleStatus = idea
    ? async () => {
        setBusyAction("toggleStatus");
        const previous = idea.status;
        const next: IdeaStatus = idea.status === "done" ? "open" : "done";
        try {
          await ideasApi.updateStatus(idea.ideaId, next);
          setIdea({ ...idea, status: next, updatedAt: new Date().toISOString() });
          await logStatusChange(previous, next);
        } catch {
          // Surface via screen busy state release — keep idea as-is.
        } finally {
          setBusyAction(null);
        }
      }
    : undefined;

  const handleSetStatus = idea
    ? async (next: IdeaStatus) => {
        if (next === idea.status) return;
        setBusyAction("toggleStatus");
        const previous = idea.status;
        try {
          await ideasApi.updateStatus(idea.ideaId, next);
          setIdea({ ...idea, status: next, updatedAt: new Date().toISOString() });
          showToast("success", tHook("Marked {{status}}", { status: next.replace("_", " ") }));
          await logStatusChange(previous, next);
        } catch (err) {
          showToast(
            "error",
            err instanceof Error ? err.message : tHook("Couldn't update status"),
          );
        } finally {
          setBusyAction(null);
        }
      }
    : undefined;

  // Same optimistic like the list does (iOS `IdeaStore.setLiked`): move now,
  // adopt the server's count, roll back on failure. The list refetches on
  // focus, so its row catches up when the user goes back.
  const ideaRef = useRef<Idea | null>(null);
  ideaRef.current = idea;
  const runLikeRef = useRef(createLikeSequencer());
  const handleToggleLike = useCallback(
    async (liked: boolean) => {
      if (!ideaId) return;
      const result = await runLikeRef.current({
        ideaId,
        liked,
        read: () => (ideaRef.current ? likeStateOf(ideaRef.current) : null),
        write: (likeState) => {
          setIdea((prev) => {
            if (!prev) return prev;
            const next = { ...prev, ...likeState };
            ideaRef.current = next;
            return next;
          });
        },
        send: (id, value) => ideasApi.setLike(id, value),
      });
      if (result.ok === false) {
        showToast(
          "error",
          result.error instanceof Error && result.error.message
            ? result.error.message
            : tHook("Couldn't update the like."),
        );
      }
    },
    [ideaId, ideasApi, tHook],
  );

  const handleArchive = idea
    ? async () => {
        setBusyAction("archive");
        try {
          await ideasApi.archive(idea.ideaId);
          showToast("success", tHook("Idea archived"));
          router.back();
        } catch (err) {
          showToast(
            "error",
            err instanceof Error ? err.message : tHook("Couldn't archive"),
          );
          setBusyAction(null);
        }
      }
    : undefined;

  const handleSaveContent = idea
    ? async (patch: { title: string; description: string }) => {
        setBusyAction("save");
        try {
          await ideasApi.updateContent(idea.ideaId, patch);
          setIdea({
            ...idea,
            title: patch.title,
            description: patch.description,
            updatedAt: new Date().toISOString(),
          });
          showToast("success", tHook("Saved"));
        } catch (err) {
          showToast(
            "error",
            err instanceof Error ? err.message : tHook("Couldn't save"),
          );
        } finally {
          setBusyAction(null);
        }
      }
    : undefined;

  return (
    <IdeaDetailScreen
      activities={activities}
      activityAuthorsById={activityAuthors}
      busyAction={busyAction}
      composerAttachments={images.attachments}
      creatorName={creatorName}
      idea={idea}
      isLoading={isLoading}
      isLoadingActivities={isLoadingActivities}
      isRefreshing={isRefreshing}
      isSubmittingProgress={isSubmittingProgress}
      onAddProgressImage={(source) => {
        void images.addImages(source);
      }}
      onArchive={handleArchive}
      onClose={() => router.back()}
      onRefresh={() => {
        void refresh();
      }}
      onRemoveProgressAttachment={images.removeAttachment}
      onSaveContent={handleSaveContent}
      onSelectSession={(sessionId) => router.replace(`/(app)/sessions/${sessionId}`)}
      onSetStatus={handleSetStatus}
      onStartSession={
        idea
          ? () => {
              router.replace(`/(app)/new-session?ideaId=${idea.ideaId}`);
            }
          : undefined
      }
      onSubmitProgress={(text) => {
        void handleSubmitProgress(text);
      }}
      onToggleLike={
        idea
          ? (liked) => {
              void handleToggleLike(liked);
            }
          : undefined
      }
      onToggleStatus={handleToggleStatus}
      relatedSessions={relatedSessions}
    />
  );
}

/** Mirrors iOS `IdeaRecord.statusLabel`, used in status_change activity copy. */
function statusLabel(status: IdeaStatus): string {
  switch (status) {
    case "in_progress":
      return t("In Progress");
    case "done":
      return t("Done");
    default:
      return t("Open");
  }
}
