/**
 * The chat send pipeline: everything between "the user pressed enter" and
 * "the message is on its way to a session".
 *
 * Three mutually-recursive functions live here. `sendIntoSession` is the core
 * and takes an explicit session id so it can serve both the normal path and
 * the freshly-created-session path; `handleSubmit` is the composer entry
 * point; `createSessionAndSendFirst` covers the picker-confirm and
 * actor-draft flows and calls back into `sendIntoSession`.
 *
 * Lifted out of `ChatPanel` verbatim. It was ~700 lines — a third of that
 * component — of logic with nothing to do with laying out a chat pane, and it
 * reaches back into the component for only the values in `ChatSendDeps`.
 */
import type { DraftActor } from "@/stores/ui";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useOutboxStore } from "@/stores/outbox-store";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { notePendingAgentReplyTo } from "@/lib/messages/pending-agent-reply-to";
import { useAuthStore } from "@/stores/auth-store";
import { bumpSessionListLastMessage } from "@/lib/session/session-list-preview";
import { useSessionListStore } from "@/stores/session-list-store";
import { useEngagedAgentStore } from "@/stores/engaged-agent-store";
import { useAgentModelPickStore } from "@/stores/agent-model-pick-store";
import { useUIStore } from "@/stores/ui";
import { expandPageLinkTokensInText } from "@/lib/embed/expand-page-link-tokens";
import { create as createMessage } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MessageKind,
} from "@/lib/proto/teamclu_pb";
import {
  mentionsOnlyExternals,
  resolveAgentRuntimeIdsForSend,
  resolveSendTeamId,
  trySyncMentionActorIds,
} from "@/lib/messages/send-path-resolve";
import { resolveCurrentMemberActorId } from "@/lib/actor/current-actor";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import type { PromptInputMessage } from "@/packages/ai/prompt-input";
import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";
import { promoteCreatedSessionToUi } from "@/lib/session/promote-created-session";
import { useEngagedAgentUiStates } from "@/hooks/use-engaged-agent-ui-states";
import { quickChatWelcomeAgent } from "@/hooks/use-quick-chat-readiness";
import { buildPostSendSessionNotice } from "@/lib/session/session-agent-notice-text";
import { useSessionNoticeStore } from "@/stores/session-notice-store";
import { toMentionDeliverySnapshot } from "@/lib/session/session-agent-ui-state";
import { type MessageListHandle } from "./MessageList";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { uploadAttachment } from "@/lib/attachments/attachment-upload";
import {
  collectSessionAttachmentUrlsFromText,
  expandSessionAttachmentTokensInText,
  textHasSessionAttachmentTokens,
} from "@/lib/attachments/session-attachment-token";
import { resolveSessionEstablishedModel } from "@/lib/session/session-established-model";
import { ensureSessionLiveSubscribed } from "@/lib/session/session-live-subscriptions";
import { resolveSessionMentionActorIds } from "@/lib/actor/resolve-session-mention-ids";
import { stripPickerPersonMentionsFromText } from "@/lib/actor/strip-person-mentions";
import {
  expandMemberMentionTokensInText,
  parseMemberMentionsFromText,
  textHasMemberMentionTokens,
} from "@/lib/actor/member-mention-token";
import { buildEnhancedChip, buildStructuredMentionLines } from "@/lib/actor/outgoing-mention-content";
import { resolveAgentSessionModel } from '@/lib/agent/resolve-agent-session-model'
import { resolveAgentBackendType } from '@/lib/agent/agent-backend-type'
import { getKnownLocalDaemonActorId } from "@/lib/daemon/local-daemon-identity";
import {
  sessionFlowError,
  sessionFlowLog,
  summarizeText,
} from "@/lib/session/session-flow-log";
function parseSlashToken(body: string): { type: "role" | "skill" | "command"; name: string } {
  if (body.startsWith("role:")) return { type: "role", name: body.slice("role:".length) };
  if (body.startsWith("skill:")) return { type: "skill", name: body.slice("skill:".length) };
  if (body.startsWith("command:")) return { type: "command", name: body.slice("command:".length) };
  return { type: "skill", name: body };
}

interface ChatSendDeps {
  t: ReturnType<typeof useTranslation>["t"];
  activeSessionId: string | null;
  displaySessionId: string | null;
  setDisplaySessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionFadeOpacity: React.Dispatch<React.SetStateAction<number>>;
  draftPreselectedActor: DraftActor | null;
  clearSessionError: () => void;
  pendingFiles: File[];
  setPendingFiles: React.Dispatch<React.SetStateAction<File[]>>;
  engagedAgents: AttachedAgent[];
  engagedUiEntries: ReturnType<typeof useEngagedAgentUiStates>;
  sheetTeamId: string | null;
  welcomeQuickChatAgent: ReturnType<typeof quickChatWelcomeAgent>["agent"];
  setWelcomeSessionStarting: React.Dispatch<React.SetStateAction<boolean>>;
  messageListRef: React.RefObject<MessageListHandle | null>;
  /** When false, sendIntoSession does not touch the global session-store draft. */
  clearGlobalDraft?: boolean;
}

export function useChatSend({
  t,
  activeSessionId,
  displaySessionId,
  setDisplaySessionId,
  setSessionFadeOpacity,
  draftPreselectedActor,
  clearSessionError,
  pendingFiles,
  setPendingFiles,
  engagedAgents,
  engagedUiEntries,
  sheetTeamId,
  welcomeQuickChatAgent,
  setWelcomeSessionStarting,
  messageListRef,
  clearGlobalDraft = true,
}: ChatSendDeps) {

  /**
   * Core send logic — takes an EXPLICIT sid so it can be called both from
   * the normal handleSubmit path (activeSessionId) and from the picker-confirm
   * path (freshly-created sessionId).  Must NOT close over activeSessionId.
   */
  const sendIntoSession = async (
    sid: string,
    message: PromptInputMessage,
    extraMentionAgents: AttachedAgent[] = [],
  ) => {
    // v2: workspace-ready gate removed — the legacy sidecar flag is gone.
    // Single-window scope sends via MQTT + Supabase regardless.
    const text = message.text?.trim() || "";
    const humanMentions = parseMemberMentionsFromText(text);
    const mentions = humanMentions.length > 0 ? humanMentions : (message.mentions || []);
    sessionFlowLog("send.begin", {
      sessionId: sid,
      hasText: text.length > 0,
      mentionCount: mentions.length,
      engagedAgentCount: engagedAgents.length,
      extraMentionAgentCount: extraMentionAgents.length,
      attachedFileCount: pendingFiles.length,
      sessionAttachmentTokenCount: collectSessionAttachmentUrlsFromText(text).length,
      ...summarizeText(text),
    });

    if (
      !text &&
      pendingFiles.length === 0 &&
      !textHasSessionAttachmentTokens(text) &&
      mentions.length === 0 &&
      !textHasMemberMentionTokens(text) &&
      engagedAgents.length === 0
    ) {
      return;
    }

    if (
      !text.trim() &&
      pendingFiles.length === 0 &&
      !textHasSessionAttachmentTokens(text) &&
      engagedAgents.length > 0
    ) {
      sessionFlowLog("send.rejected_empty_with_engaged_agent", {
        sessionId: sid,
        engagedAgentIds: engagedAgents.map((a) => a.id),
      }, "warn");
      return;
    }

    // Snapshot file state immediately so the UI clears at once, before any
    // async work. This prevents stale images from leaking into later sends
    // if the user types and submits again while the upload is in flight.
    const currentPendingFiles = pendingFiles;
    const draftSnapshot = clearGlobalDraft
      ? useSessionStore.getState().draftInput
      : "";
    setPendingFiles([]);
    if (clearGlobalDraft) {
      useSessionStore.getState().setDraftInput("");
    }

    const restoreComposer = () => {
      setPendingFiles(currentPendingFiles);
      if (clearGlobalDraft) {
        useSessionStore.getState().setDraftInput(draftSnapshot);
      }
    };

    // WYSIWYG: pill in footer, typed @, or explicit extra on first send.
    const engagedFromStore = useEngagedAgentStore.getState().get(sid);
    const memberIds = mentions.map((m) => m.id);
    // A message addressed only to a channel contact goes to them alone.
    //
    // An auto-engaged pill does not object: gateway chats are solo sessions,
    // where the composer re-engages the agent as fast as it is cleared, so the
    // pill is a default rather than a decision. A pill the user engaged
    // themselves does object, and keeps the agent on the message.
    const pillCandidate =
      extraMentionAgents[0] ?? engagedAgents[0] ?? engagedFromStore ?? null;
    const externalOnly =
      extraMentionAgents.length === 0 &&
      (pillCandidate === null || pillCandidate.auto === true) &&
      mentionsOnlyExternals(
        memberIds,
        useSessionParticipantStore.getState().participantsBySession[sid] ?? [],
        text,
      );
    const agentForSend = externalOnly ? null : pillCandidate;
    const agentIds = agentForSend ? [agentForSend.id] : [];
    const displayMentionActorIds = Array.from(new Set(agentIds.filter(Boolean)));

    // ── Resolve team / mentions / sender with local-agent latency in mind ──
    // Prefer sync store reads; parallelize any remaining awaits; skip a second
    // listParticipants when the composer pill already names the agent.
    const authSession = useAuthStore.getState().session;
    const teamIdFromSessionList =
      useSessionListStore.getState().rows.find((r) => r.id === sid)?.team_id ??
      sheetTeamId ??
      null;
    let teamIdForSend: string | null = teamIdFromSessionList;

    const teamIdPromise = Promise.resolve(
      resolveSendTeamId({
        teamIdFromSessionList,
        currentTeamId: () => useCurrentTeamStore.getState().team?.id ?? null,
      }),
    );

    const syncMentions = externalOnly
      ? memberIds
      : trySyncMentionActorIds(memberIds, agentIds, text);
    const mentionsPromise: Promise<string[]> = syncMentions
      ? Promise.resolve(syncMentions)
      : resolveSessionMentionActorIds(sid, memberIds, agentIds, text, {
          skipSoloAgentFallback: externalOnly,
        });

    // Build outgoing text while network resolves — only needs agentForSend (sync).
    let processedText = expandMemberMentionTokensInText(text, {
      humanMentionInstruction: (name) =>
        t("chat.outgoing.humanMentionInstruction", { name }),
    });
    processedText = stripPickerPersonMentionsFromText(processedText, mentions);
    processedText = expandPageLinkTokensInText(processedText);
    processedText = expandSessionAttachmentTokensInText(processedText);
    processedText = processedText.replace(/@\{([^}]+)\}/g, '[File: $1]');
    // Skill/role invocation wording depends on which backend runs the agent
    // (opencode plugin tools vs Claude Code's native Skill tool).
    // Runtime-first, then the team directory. On a cold start no runtime has
    // attached yet, and a bare runtime read returns `undefined` — which the
    // MRU lookup below cannot key on, so it reported "never picked a model"
    // and the first send after launch stopped for a model pick.
    const backendTypeForSend = resolveAgentBackendType({
      agentId: agentForSend?.id ?? "",
      teamId: sheetTeamId,
      byRuntimeId: useRuntimeStateStore.getState().byRuntimeId,
    });
    processedText = processedText.replace(/\/\{([^}]+)\}/g, (_full, body) => {
      const token = parseSlashToken(body);
      if (token.type === "role") return buildEnhancedChip("role", token.name, backendTypeForSend);
      if (token.type === "command") return `[Command: ${token.name}]`;
      return buildEnhancedChip("skill", token.name, backendTypeForSend);
    });
    processedText = processedText.replace(/\/<([a-z0-9]+(?:-[a-z0-9]+)*)>/g, (_full, roleName) =>
      buildEnhancedChip("role", roleName, backendTypeForSend),
    );
    processedText = processedText.replace(/\/\[([^\]]+)\]/g, '[Command: $1]');

    const parts: string[] = [];
    const structuredMentions = buildStructuredMentionLines(agentForSend);
    if (structuredMentions.length > 0) {
      parts.push(...structuredMentions);
    }
    const bodyText = processedText.trim();
    if (bodyText) {
      parts.push(bodyText);
    }
    let finalContent = parts.join("\n\n");

    teamIdForSend = await teamIdPromise;
    sessionFlowLog("send.team_resolved", {
      sessionId: sid,
      teamId: teamIdForSend,
      source: teamIdFromSessionList ? "session-list-store" : "backend",
      hasAuthSession: !!authSession,
    });

    const senderPromise =
      authSession && teamIdForSend
        ? resolveCurrentMemberActorId(teamIdForSend, authSession.user.id, {
            currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
            currentMemberId:
              useCurrentTeamStore.getState().currentMember?.id ?? null,
          })
        : Promise.resolve<string | null>(null);

    const uploadPromise = (async (): Promise<string[]> => {
      const urls: string[] = collectSessionAttachmentUrlsFromText(text);
      if (currentPendingFiles.length === 0 || !teamIdForSend) return urls;
      try {
        sessionFlowLog("send.attachments_upload.begin", {
          sessionId: sid,
          teamId: teamIdForSend,
          pendingFileCount: currentPendingFiles.length,
          pendingFileNames: currentPendingFiles.map((file) => file.name),
        });
        const uploaded = await Promise.all(
          currentPendingFiles.map((file) =>
            uploadAttachment(file, { teamId: teamIdForSend!, sessionId: sid }),
          ),
        );
        for (const att of uploaded) {
          const tokenIsImage =
            att.mimeType.startsWith("image/") ||
            /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(att.fileName);
          if (tokenIsImage) {
            parts.push(`[Image: ${att.fileName}] (url: ${att.signedUrl})`);
          } else {
            parts.push(`[Attachment: ${att.fileName}] (url: ${att.signedUrl})`);
          }
          urls.push(att.signedUrl);
        }
        finalContent = parts.join("\n\n");
        sessionFlowLog("send.attachments_upload.ok", {
          sessionId: sid,
          teamId: teamIdForSend,
          uploadedCount: uploaded.length,
        });
      } catch (e) {
        sessionFlowError("send.attachments_upload.failed", e, {
          sessionId: sid,
          teamId: teamIdForSend,
          pendingFileCount: currentPendingFiles.length,
        });
        console.error("[ChatPanel] attachment upload failed:", e);
        const { toast } = await import("sonner");
        toast.error("Failed to upload attachment — message not sent");
        throw e;
      }
      return urls;
    })();

    let mentionActorIds: string[];
    let senderActorId: string | null;
    let attachmentUrls: string[];
    try {
      sessionFlowLog("send.resolve_sender.begin", {
        sessionId: sid,
        teamId: teamIdForSend,
        userId: authSession?.user.id ?? null,
      });
      [mentionActorIds, senderActorId, attachmentUrls] = await Promise.all([
        mentionsPromise,
        senderPromise,
        uploadPromise,
      ]);
    } catch {
      restoreComposer();
      return;
    }

    sessionFlowLog("send.mentions_resolved", {
      sessionId: sid,
      memberMentionCount: memberIds.length,
      agentMentionCount: agentIds.length,
      mentionActorIds,
      syncFastPath: syncMentions != null,
    });

    const agentRuntimeIdsForSend = resolveAgentRuntimeIdsForSend(
      sid,
      agentForSend?.id ?? null,
      mentionActorIds,
    );

    // Diagnostic: when the user has agents engaged in the pill but the
    // resolved mention list is empty (or contains no agent actors), no
    // daemon will pick the message up — the daemon's
    // `route_session_message` silent-queues every message whose
    // `mention_actor_ids` does not include its own actor. Surface a
    // visible warning so the "send → no reply" UX hangs less.
    if (engagedAgents.length > 0 && agentRuntimeIdsForSend.length === 0) {
      sessionFlowLog("send.no_agent_mentions_despite_engagement", {
        sessionId: sid,
        engagedAgentIds: engagedAgents.map((a) => a.id),
        resolvedMentionActorIds: mentionActorIds,
      }, "warn");
      void import("sonner").then(({ toast }) => {
        toast.warning(t("chat.toast.mentionRouteFailedTitle", "已 @Agent 但无法路由消息"), {
          description: t(
            "chat.toast.mentionRouteFailedBody",
            "消息未包含可解析的 Agent @-mention，daemon 不会回复。请确认 Agent 已加入此会话。",
          ),
        });
      });
    }

    // Optimistic v2 send: synthesize the proto Message and append to the
    // session store immediately so the bubble renders instantly. The actual
    // Supabase insert + MQTT publish are handled asynchronously by
    // `outbox-sender` which retries with exponential backoff on failure.
    // The bubble shows a leading status dot (pending/inFlight/delivered/
    // failed) bound to the matching outbox entry, mirroring iOS.
    const outgoing = finalContent;
    if (outgoing && outgoing.trim()) {
      if (sid && authSession && teamIdForSend) {
        try {
          if (!senderActorId)
            throw new Error(`No actor found for user in team ${teamIdForSend}`);

          const messageId = crypto.randomUUID();
          const createdAt = BigInt(Math.floor(Date.now() / 1000));
          // Must resolve identically to the AgentSelectorDock pill — what the
          // user SEES is what the prompt runs on. That means passing the
          // session's transcript-established model here too; without it the
          // send path fell through to the agent-level runtime retain, which
          // can belong to another session (显示 A 实跑 B).
          const establishedForSend = resolveSessionEstablishedModel(
            useSessionMessageStore.getState().messages[sid],
            agentRuntimeIdsForSend[0] ?? "",
          );
          const sendAgentId = agentRuntimeIdsForSend[0] ?? "";
          const localDaemonActorIdForSend = getKnownLocalDaemonActorId();
          // No agent means no model: there is nothing to run the prompt on, so
          // stamping the message with a workspace-global default only recorded
          // a model that was never used. `selectAgentModel` owns every other
          // case — including the fallback, which must be the same device MRU
          // the pill shows.
          // Same resolver `startAgentRuntimes` uses to start the runtime this
          // message runs on, so the model stamped here and the model it runs on
          // cannot come out different. `teamIdForSend` is the team this send
          // already resolved (session list first); letting the MRU re-derive it
          // from `current-team` read empty during cold start and turned a
          // remembered model into "never picked".
          const resolvedForSend = sendAgentId
            ? resolveAgentSessionModel({
                sessionId: sid,
                agentId: sendAgentId,
                teamId: teamIdForSend,
                backendType: backendTypeForSend,
                localDaemonActorId: localDaemonActorIdForSend,
                sessionEstablishedModel: establishedForSend,
              })
            : null;
          const selectedForSend = resolvedForSend?.selected ?? null;
          const outgoingModel = selectedForSend?.modelId || "";
          const mentionDeliverySnapshot: Record<string, "offline" | "stale"> = {};
          for (const entry of engagedUiEntries) {
            if (!agentForSend || entry.agent.id !== agentForSend.id) continue;
            const snap = toMentionDeliverySnapshot(entry.uiState);
            if (snap === "offline" || snap === "stale") {
              mentionDeliverySnapshot[entry.agent.id] = snap;
            }
          }
          const outgoingMetadata = {
            mention_actor_ids: mentionActorIds,
            ...(displayMentionActorIds.length > 0
              ? { display_mention_actor_ids: displayMentionActorIds }
              : {}),
            ...(Object.keys(mentionDeliverySnapshot).length > 0
              ? { mention_delivery_snapshot: mentionDeliverySnapshot }
              : {}),
            ...(attachmentUrls.length > 0
              ? { attachment_urls: attachmentUrls }
              : {}),
          };
          sessionFlowLog("send.proto_created", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
            senderActorId,
            mentionActorCount: mentionActorIds.length,
            attachmentUrlCount: attachmentUrls.length,
            model: outgoingModel || null,
            ...summarizeText(outgoing),
          });

          const msg = createMessage(MessageSchema, {
            messageId,
            sessionId: sid,
            senderActorId,
            kind: MessageKind.TEXT,
            content: outgoing,
            metadataJson: JSON.stringify(outgoingMetadata),
            createdAt,
            model: outgoingModel,
          });

          // 1. Optimistic UI append.
          //    dedup-by-id in session-message-store means the eventual live
          //    echo (same messageId) is a no-op.
          useSessionMessageStore.getState().appendMessage(sid, msg);
          useV2StreamingStore.getState().clearStaleStreamErrors(sid);
          // A new prompt supersedes any lingering turn-failure alert.
          if (useSessionStore.getState().errorSessionId === sid) {
            clearSessionError();
          }
          if (displaySessionId !== sid) {
            setDisplaySessionId(sid);
            setSessionFadeOpacity(1);
          }
          // Scroll so afterMessages separator aligns with viewport bottom:
          // new user bubble is fully visible, agent stream UI stays below the fold.
          // isAtBottom is force-enabled so ResizeObserver follows agent replies.
          messageListRef.current?.scrollToLatestMessage();
          sessionFlowLog("send.optimistic_append.ok", {
            sessionId: sid,
            messageId,
            currentMessageCount:
              useSessionMessageStore.getState().messages[sid]?.length ?? 0,
          });

          // MQTT live subscribe is for hearing OTHER members — not delivery.
          // Local agent gets the message via outbox loopback ingest. Do not
          // block the optimistic bubble (or outbox kick) on broker RTT.
          sessionFlowLog("send.subscribe_live.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
          });
          void ensureSessionLiveSubscribed(teamIdForSend, sid)
            .then(() => {
              sessionFlowLog("send.subscribe_live.ok", {
                sessionId: sid,
                teamId: teamIdForSend,
              });
            })
            .catch((subscribeError) => {
              sessionFlowError("send.subscribe_live.best_effort_failed", subscribeError, {
                sessionId: sid,
                teamId: teamIdForSend,
              });
            });

          // 2. Enqueue to outbox immediately — status dot beside the bubble
          //    tracks pending/inFlight/delivered. Do NOT await workspace-hint
          //    Cloud lookups here: on a slow API that was 7–8s of dead air
          //    between bubble and spinner. The outbox sender resolves
          //    workspaceIdHint itself before runtimeStart (after MQTT wake).
          //    notePendingAgentReplyTo only after enqueue succeeds so a failed
          //    send cannot leave stale FIFO ids for a later agent turn.
          sessionFlowLog("send.outbox_enqueue.begin", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
            workspaceIdHint: null,
          });
          await useOutboxStore.getState().enqueue({
            messageId,
            teamId: teamIdForSend,
            sessionId: sid,
            senderActorId,
            content: outgoing,
            model: outgoingModel || null,
            mentionActorIds,
            displayMentionActorIds,
            attachmentUrls,
            workspaceIdHint: null,
          });
          sessionFlowLog("send.outbox_enqueue.ok", {
            sessionId: sid,
            teamId: teamIdForSend,
            messageId,
          });
          if (agentRuntimeIdsForSend.length > 0) {
            notePendingAgentReplyTo(sid, agentRuntimeIdsForSend, messageId);
          }

          bumpSessionListLastMessage(sid, outgoing, {
            at: new Date().toISOString(),
            markUnread: false,
          });

          const noticeText = buildPostSendSessionNotice(engagedUiEntries, t);
          if (noticeText) {
            useSessionNoticeStore.getState().append(sid, noticeText);
          }

          // Runtime ensure + MQTT publish happen inside the outbox sender
          // (insert → runtimeStart/catchup → mqtt). Do not fire a parallel
          // ensure here — it races ahead of persistence and triggers catchup
          // before the @-mentioned row exists in the backend.
        } catch (e) {
          sessionFlowError("send.failed_before_outbox", e, {
            sessionId: sid,
            teamId: teamIdForSend,
          });
          console.error("[ChatPanel] send enqueue failed:", e);
        }
      } else {
        sessionFlowLog("send.skipped_missing_context", {
          sessionId: sid,
          hasAuthSession: !!authSession,
          teamId: teamIdForSend,
          hasOutgoing: outgoing.trim().length > 0,
        }, "warn");
      }
    }

  };

  const handleSubmit = async (message: PromptInputMessage) => {
    sessionFlowLog("submit.received", {
      activeSessionId,
      hasDraftPreselectedActor: !!draftPreselectedActor,
      mentionCount: message.mentions?.length ?? 0,
      ...summarizeText(message.text ?? ""),
    });
    if (!activeSessionId) {
      // No session yet.
      //   1. Actor-draft mode (user tapped an actor row → draftPreselectedActor
      //      is set): create the session with that one actor and send straight
      //      away — bypasses the new-session dialog by design.
      //   2. Otherwise: redirect into the new-session dialog so the user can
      //      pick participants. The typed text is preserved as the opening
      //      message rather than dropped.
      if (draftPreselectedActor) {
        const picks =
          draftPreselectedActor.kind === 'agent'
            ? {
                agents: [{ id: draftPreselectedActor.id, displayName: draftPreselectedActor.displayName }],
                members: [],
              }
            : {
                agents: [],
                members: [{ id: draftPreselectedActor.id, displayName: draftPreselectedActor.displayName }],
              };
        const draftActorId = draftPreselectedActor.id;
        // Keep draftPreselectedActor until the new session is active —
        // clearing it first flashes LocalAgentWelcomeEmptyState ("… is
        // waiting on this device") for the duration of createSessionShell.
        setWelcomeSessionStarting(true);
        try {
          const created = await createSessionAndSendFirst(message, picks);
          if (created) {
            try {
              localStorage.removeItem(`teamclu-actor-draft:${draftActorId}`);
            } catch {
              /* localStorage disabled */
            }
            useUIStore.getState().clearActorDraft();
          }
        } finally {
          setWelcomeSessionStarting(false);
        }
        return;
      }
      if (welcomeQuickChatAgent) {
        setWelcomeSessionStarting(true);
        try {
          await createSessionAndSendFirst(message, {
            agents: [{ id: welcomeQuickChatAgent.id, displayName: welcomeQuickChatAgent.displayName }],
            members: [],
          });
        } finally {
          setWelcomeSessionStarting(false);
        }
        return;
      }
      useUIStore.getState().openNewSessionDialog(message.text ?? null);
      sessionFlowLog("submit.open_new_session_dialog", {
        ...summarizeText(message.text ?? ""),
      });
      return;
    }
    await sendIntoSession(activeSessionId, message);
  };

  // ── New-session creation: shared by the picker confirm path and the
  //    actor-draft (preselected actor) path ───────────────────────────────
  const createSessionAndSendFirst = async (
    firstMessage: PromptInputMessage,
    picks: {
      members: { id: string; displayName: string }[]
      agents: { id: string; displayName: string }[]
    },
  ): Promise<boolean> => {
    const teamIdForSend = sheetTeamId;
    sessionFlowLog("session_create.begin", {
      teamId: teamIdForSend,
      pickedMemberCount: picks.members.length,
      pickedAgentCount: picks.agents.length,
      ...summarizeText(firstMessage.text ?? ""),
    });
    if (!teamIdForSend) {
      sessionFlowLog("session_create.missing_team", {}, "warn");
      console.error('[ChatPanel] no team_id available; cannot create session');
      return false;
    }

    const authSession = useAuthStore.getState().session;
    if (!authSession?.user?.id) {
      sessionFlowLog("session_create.missing_auth", {
        teamId: teamIdForSend,
      }, "warn");
      console.error('[ChatPanel] no auth session');
      return false;
    }
    const myActorId = await resolveCurrentMemberActorId(
      teamIdForSend,
      authSession.user.id,
      {
        currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
        currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
      },
    );
    if (!myActorId) {
      sessionFlowLog("session_create.missing_actor", {
        teamId: teamIdForSend,
        userId: authSession.user.id,
      }, "warn");
      console.error('[ChatPanel] no actor record for user in team', teamIdForSend);
      const { toast } = await import('sonner');
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
      return false;
    }

    // Initial title: "ActorName (HH:mm)" when we have exactly one
    // preselected actor (so multiple sessions to the same actor stay
    // distinguishable until the first user message auto-titles the session).
    // Otherwise fall back to the message text or a generic placeholder.
    const soloActor =
      picks.members.length + picks.agents.length === 1
        ? picks.members[0] ?? picks.agents[0]
        : null;
    const pad = (n: number) => n.toString().padStart(2, '0');
    const now = new Date();
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const titleSource = soloActor
      ? `${soloActor.displayName} (${hhmm})`
      : (firstMessage.text ?? '').trim() || 'New chat';

    try {
      const { createSessionShell } = await import('@/lib/session/session-create');
      const memberIds = picks.members.map((m) => m.id);
      const agentIds = picks.agents.map((a) => a.id);
      const allAdditional = Array.from(new Set([...memberIds, ...agentIds]));
      const draftIdeaId = useUIStore.getState().draftIdeaId;
      sessionFlowLog("session_create.shell.begin", {
        teamId: teamIdForSend,
        creatorActorId: myActorId,
        additionalActorCount: allAdditional.length,
        agentActorCount: agentIds.length,
        hasIdeaId: !!draftIdeaId,
        title: titleSource,
      });
      const { sessionId } = await createSessionShell({
        teamId: teamIdForSend,
        creatorActorId: myActorId,
        title: titleSource,
        additionalActorIds: allAdditional,
        ideaId: draftIdeaId,
      });
      if (soloActor) {
        const { markSessionNeedsAutoTitle } = await import("@/lib/session/session-auto-title");
        markSessionNeedsAutoTitle(sessionId);
      }
      sessionFlowLog("session_create.shell.ok", {
        teamId: teamIdForSend,
        sessionId,
      });
      if (draftIdeaId) {
        useUIStore.getState().clearDraftIdeaId();
      }

      // Optimistic list row + switch — do not await a full session-list
      // refetch before the user can see the new chat / send completes.
      sessionFlowLog("session_create.promote.begin", {
        teamId: teamIdForSend,
        sessionId,
      });
      await promoteCreatedSessionToUi({
        sessionId,
        teamId: teamIdForSend,
        title: titleSource,
        ideaId: draftIdeaId,
        lastMessagePreview: (firstMessage.text ?? '').trim().slice(0, 120) || null,
      });
      sessionFlowLog("session_create.promote.ok", {
        teamId: teamIdForSend,
        sessionId,
      });

      // Carry any model chosen on the draft pill onto the real session, before
      // the first send resolves a model. Without this the pick is stranded in
      // the draft scope and the send falls through to retain/MRU.
      useAgentModelPickStore.getState().promoteDraftPicks(sessionId);

      // Solo create: mount the pill before send so mention is WYSIWYG.
      const soleAgent =
        picks.members.length === 0 && picks.agents.length === 1
          ? picks.agents[0]
          : null;
      if (soleAgent) {
        useEngagedAgentStore.getState().setAgents(sessionId, [soleAgent]);
      }
      await sendIntoSession(sessionId, firstMessage);

      const autoMentioned = soleAgent ? new Set([soleAgent.id]) : new Set<string>();
      const agentsNeedingCreateEnsure = agentIds.filter((id) => !autoMentioned.has(id));
      if (agentsNeedingCreateEnsure.length > 0) {
        sessionFlowLog("session_create.runtime_start.begin", {
          teamId: teamIdForSend,
          sessionId,
          agentActorIds: agentsNeedingCreateEnsure,
          skippedAutoMentioned: agentIds.filter((id) => autoMentioned.has(id)),
        });
        void import("@/lib/teamclu/ensure-agent-runtime").then(({ ensureAgentRuntimesForSession }) => {
          void ensureAgentRuntimesForSession({
            sessionId,
            teamId: teamIdForSend,
            agentActorIds: agentsNeedingCreateEnsure,
            // No modelId: `ensureAgentRuntimesForSession` feeds this to
            // `selectAgentModel` as a providerFallback, and that resolver
            // already reaches the retain and the device MRU on its own.
            reason: "session_create",
          });
        });
      } else if (agentIds.length > 0) {
        sessionFlowLog("session_create.runtime_start.delegated_to_outbox", {
          teamId: teamIdForSend,
          sessionId,
          agentActorIds: agentIds,
        });
      }
      return true;
    } catch (e) {
      sessionFlowError("session_create.failed", e, {
        teamId: teamIdForSend,
      });
      console.error('[ChatPanel] session creation failed:', e);
      const { toast } = await import('sonner');
      toast.error(t('chat.newSessionPicker.createError', 'Failed to create session'));
      return false;
    }
  };
  return { handleSubmit, createSessionAndSendFirst, sendIntoSession };
}
