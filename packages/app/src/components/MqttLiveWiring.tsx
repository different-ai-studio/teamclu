/**
 * MQTT live-envelope wiring for the signed-in user's active team.
 *
 * This is the receiver half of the v2 streaming path: it holds the MQTT
 * connection lease, decodes every incoming LiveEventEnvelope, and writes the
 * result straight into the stores the UI reads from. It renders nothing.
 *
 * It lives in its own component rather than inside `AppContent` for two
 * reasons. It is ~1500 lines of pure wiring that had no business sharing a
 * function body with the app's layout. And it subscribes to state that churns
 * constantly — the access token, the reconnect nonce, the active session, the
 * recent-session digest — which, from the root component, re-rendered the
 * entire tree on traffic that changes nothing visible.
 */
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { markStartup } from "@/lib/startup-perf";
import { classifyAgentTurnErrorName, formatAgentTurnErrorDisplayMessage, isAgentTurnAbortError, localizeAgentTurnErrorMessage } from "@/lib/agent-turn-error";
import { useSessionStore } from "@/stores/session-store";
import type { Question, QuestionOption } from "@/stores/session-types";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useAuthStore } from "@/stores/auth-store";
import { listenForEnvelopes } from "@/lib/mqtt-bridge";
import { connectMqttWithFreshAuth } from "@/lib/mqtt-connect-with-fresh-auth";
import { mqttConnectionKey } from "@/lib/mqtt-connection-key";
import { describeJwt, recordMqttDiag } from "@/lib/mqtt-diagnostics";
import { useMqttReconnectStore } from "@/stores/mqtt-reconnect";
import { getEffectiveServerConfig } from "@/lib/server-config";
import { acquireTeamcluRpcBroker, acquireTeamcluRpcIdentity } from "@/lib/teamclu-rpc";
import { acquireRemoteToolsRpcServer, registerPlatformExecutors } from "@/lib/remote-tools";
import { acquireMqttModuleLeaseGroup, type MqttModuleLeaseGroup } from "@/lib/mqtt-module-wiring";
import { decodeLiveEvent, sessionIdFromLiveEvent, streamActorIdFromLiveEvent } from "@/lib/teamclu-events";
import { handleAcpPermissionRequest } from "@/lib/teamclu/handle-acp-permission-request";
import { handleSessionEventPermissionResolved } from "@/lib/teamclu/handle-session-event-permission-resolved";
import { tryBindChildFromPermission } from "@/lib/teamclu/subagent-acp-binding";
import { routeSubagentAcpEvent } from "@/lib/teamclu/subagent-acp-route";
import { resolveOrphanSubagentParentToolId, shouldBufferUnboundChildAcpEvent, shouldRouteOrphanSubagentEvent } from "@/lib/teamclu/subagent-acp-routing";
import { scheduleMarkActiveSessionRead } from "@/lib/active-session-read";
import {
  ensureInboxSubscribed,
  handleInboxEnvelope,
  resetInboxSubscriptionState,
  scheduleSessionListRefresh,
} from "@/lib/inbox-handler";
import { bumpSessionListLastMessage, messageKindUpdatesSessionPreview } from "@/lib/session-list-preview";
import { executeAgentTurnFlush } from "@/lib/agent-turn-flush";
import { unixTimestampSecondsToIso } from "@/lib/message-timestamp";
import { resolveInterruptedPlaceholdersToDrop } from "@/lib/interrupted-stream-placeholder";
import { removePendingAgentReplyTo, resolvePendingAgentReplyTo } from "@/lib/pending-agent-reply-to";
import { bufferStreamDelta, flushStreamDeltasFor, flushAllStreamDeltas } from "@/lib/stream-delta-buffer";
import { recordLatencyProbe } from "@/lib/latency-probe";
import { bumpLiveDuplicateDropped } from "@/lib/live-dedup-stats";
import { cloneStreamEntrySnapshot, patchPersistedToolResult, patchPersistedToolUse, resolveStreamEntryForPersist, syncStreamingToolOutputsFromLocalCache } from "@/lib/streaming-persist";
import { getFlushedTurn } from "@/lib/flushed-turn-registry";
import { logInterruptMsgDiag, summarizeFlushDecision, summarizePendingReplies, summarizeStreamEntry } from "@/lib/interrupt-msg-diag";
import { logExtMsgDiag, summarizeProtoForExtDiag, summarizeProtosForExtDiag } from "@/lib/extension-msg-diag";
import { logStreamToolDiag } from "@/lib/stream-tool-diag";
import { useAcpDebugStore } from "@/stores/acp-debug-store";
import { isStreamInterruptible, useV2StreamingStore } from "@/stores/v2-streaming-store";
import { acquireRuntimeStateStore, useRuntimeStateStore } from "@/stores/runtime-state-store";
import { findStaleLiveStreams, STALE_STREAM_SWEEP_MS } from "@/lib/stale-stream-recovery";
import { acquireActorPresenceStore } from "@/stores/actor-presence-store";
import { MessageKind, type Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import { agentStreamKey, isTerminalAgentStatus, isToolOnlyTurnAnchor, isTurnOpeningStatusChange, mergePendingAgentReplies, normalizeToolResultEvent, normalizeToolUseEvent, registerDiscardPendingStreamReply, rememberLiveEventId, shouldPatchFlushedToolEvent, streamEntryHasVisibleContent } from "@/lib/live-agent-stream";
import { mapAcpPlanEntries, syncPlanFromTodoTool, syncPlanFromTodoToolResult } from "@/lib/sync-plan-from-todowrite";
import { reportSkillUsage } from "@/lib/telemetry/skill-usage";
import { upsertMessagesBatch, softDeleteMessage, type MessageRow } from "@/lib/local-cache";
import { syncActorsForTeam } from "@/lib/sync/actor-sync";
import { syncIdeasForTeam } from "@/lib/sync/idea-sync";
import { syncSessionsForTeam } from "@/lib/sync/session-sync";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionLiveInterestStore } from "@/stores/session-live-interest-store";
import { resolveCurrentMemberActorId } from "@/lib/current-actor";
import { isV2E2EControlActive } from "@/lib/e2e/v2-control-active";
import {
  collectSessionsNeedingLiveInterest,
  isSessionLiveInterest,
  mergeSessionLiveInterestIds,
  noteInboxOpenedSession,
  pruneIdleInboxSessions,
  resetInboxIdleInterestState,
  resetSessionLiveSubscriptionState,
  resubscribeSessionLiveInterest,
  startInboxIdleSweep,
  stopInboxIdleSweep,
  syncSessionLiveInterest,
  touchLiveEventActivity,
} from "@/lib/session-live-subscriptions";

interface MqttLiveWiringProps {
  /** Signed-in user id, or null while auth is still resolving. */
  userId: string | null;
  /** Active team id — the MQTT ACL scope. Null until current-team lands. */
  teamId: string | null;
  /** Called once the current member's actor id is resolved for this team. */
  onMyActorId: (actorId: string | null) => void;
}

export function MqttLiveWiring({ userId, teamId, onMyActorId }: MqttLiveWiringProps) {
  const { t } = useTranslation();
  const mqttTeamId = teamId;
  const mqttAccessToken = useAuthStore((s) => s.session?.access_token ?? null);
  const mqttReconnectNonce = useMqttReconnectStore((s) => s.nonce);
  const mqttAuthKey = mqttConnectionKey({
    userId,
    teamId: mqttTeamId,
    accessToken: mqttAccessToken,
  });
  const pendingStreamRepliesRef = useRef<Record<string, TeamcluMessage[]>>({});
  /** Set on terminal statusChange; late message.created triggers flush. */
  const terminalFlushPendingRef = useRef<Record<string, boolean>>({});
  /** Set on follow-up ACTIVE (mid-turn user message); reopen turn2 dock after flush. */
  const followUpActiveRef = useRef<Record<string, boolean>>({});
  /** Timeout while waiting for daemon AGENT_REPLY after terminal (no interrupt-*). */
  const terminalAwaitTimeoutRef = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );
  const seenLiveEventIdsRef = useRef<Set<string>>(new Set());
  const [inboxIdleRevision, setInboxIdleRevision] = useState(0);
  const liveInterestSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onInboxMessagePingRef = useRef<(sessionId: string) => void>(() => {});

  const scheduleLiveInterestSync = () => {
    if (liveInterestSyncTimerRef.current) clearTimeout(liveInterestSyncTimerRef.current);
    liveInterestSyncTimerRef.current = setTimeout(() => {
      liveInterestSyncTimerRef.current = null;
      setInboxIdleRevision((n) => n + 1);
    }, 100);
  };
  const scheduleLiveInterestSyncRef = useRef(scheduleLiveInterestSync);
  scheduleLiveInterestSyncRef.current = scheduleLiveInterestSync;

  onInboxMessagePingRef.current = (sessionId: string) => {
    noteInboxOpenedSession(sessionId);
    scheduleLiveInterestSync();
  };

  function clearTurnAgentReplyParking(streamKey: string) {
    delete pendingStreamRepliesRef.current[streamKey];
  }

  function clearTerminalAwaitTimeout(streamKey: string) {
    const timer = terminalAwaitTimeoutRef.current[streamKey];
    if (timer) {
      clearTimeout(timer);
      delete terminalAwaitTimeoutRef.current[streamKey];
    }
  }

  function clearTerminalFlushPending(streamKey: string) {
    clearTerminalAwaitTimeout(streamKey);
    delete terminalFlushPendingRef.current[streamKey];
  }

  function clearFollowUpActive(streamKey: string) {
    delete followUpActiveRef.current[streamKey];
  }

  function ensureFollowUpLiveStream(sessionId: string, actorId: string) {
    const streamKey = agentStreamKey(sessionId, actorId);
    if (!followUpActiveRef.current[streamKey]) return;
    const liveEntry = useV2StreamingStore.getState().byKey[streamKey];
    if (liveEntry && isStreamInterruptible(liveEntry)) return;
    useV2StreamingStore.getState().beginPlanningPlaceholder(sessionId, actorId);
  }

  function scheduleTerminalDaemonReplyTimeout(
    sessionId: string,
    actorId: string,
  ) {
    const streamKey = agentStreamKey(sessionId, actorId);
    clearTerminalAwaitTimeout(streamKey);
    // MQTT QoS0 / stalled daemon must not leave the live dock spinning forever.
    terminalAwaitTimeoutRef.current[streamKey] = setTimeout(() => {
      delete terminalAwaitTimeoutRef.current[streamKey];
      if (!terminalFlushPendingRef.current[streamKey]) return;
      const flushed = flushTurnAgentReply(
        sessionId,
        actorId,
        "mqtt.statusChange.terminal.timeout",
      );
      logInterruptMsgDiag("mqtt.statusChange.terminal.timeout", {
        sessionId,
        actorId,
        flushed,
        ...summarizePendingReplies(pendingStreamRepliesRef.current[streamKey]),
      });
      if (flushed) {
        clearTerminalFlushPending(streamKey);
        return;
      }
      // No daemon reply arrived — release the live dock; stream parts stay in
      // archive via finishSessionActor so Process cards are not lost.
      clearTerminalFlushPending(streamKey);
      useV2StreamingStore.getState().finishSessionActor(sessionId, actorId, {
        reason: "statusChange.terminal.timeout",
      });
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
    }, 8_000);
  }

  const flushTurnAgentReplyInFlightRef = useRef<Record<string, boolean>>({});
  /** Eager client flush when terminal arrives before daemon agent_reply (interrupt + tool). */
  const interruptedStreamFlushRef = useRef<
    Record<string, { streamId: string; messageId: string }>
  >({});
  /** Real AGENT_REPLY won the race — in-flight eager flush must not commit. */
  const interruptedFlushSupersededRef = useRef<Record<string, boolean>>({});
  /** streamId that was superseded; blocks re-flush of the same interrupted turn. */
  const interruptedFlushSupersededStreamIdRef = useRef<Record<string, string>>({});

  // Drop the synthetic interrupt-<streamId> anchor from BOTH the in-memory
  // message store AND the libsql cache, so it never survives a reload as a
  // duplicate bubble alongside the real reply.
  function dropInterruptedPlaceholderRow(sessionId: string, messageId: string) {
    logExtMsgDiag("interrupt.drop", {
      sessionId,
      messageId,
      isInterrupt: messageId.startsWith("interrupt-"),
    });
    useSessionMessageStore.getState().removeMessageById(sessionId, messageId);
    void softDeleteMessage(messageId, new Date().toISOString()).catch((e) => {
      console.warn(
        "[interrupt] cache removal of synthetic placeholder failed",
        e,
      );
      logExtMsgDiag("interrupt.drop.cacheFail", {
        sessionId,
        messageId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  function removeInterruptedStreamPlaceholder(
    sessionId: string,
    actorId: string,
    streamId: string | undefined,
  ) {
    const streamKey = agentStreamKey(sessionId, actorId);
    const placeholder = interruptedStreamFlushRef.current[streamKey];
    if (!placeholder || !streamId || placeholder.streamId !== streamId) {
      logExtMsgDiag("interrupt.removeByStream.miss", {
        sessionId,
        actorId,
        streamId: streamId ?? null,
        hasPlaceholder: Boolean(placeholder),
        placeholderStreamId: placeholder?.streamId ?? null,
        placeholderMessageId: placeholder?.messageId ?? null,
      });
      return;
    }
    dropInterruptedPlaceholderRow(sessionId, placeholder.messageId);
    delete interruptedStreamFlushRef.current[streamKey];
  }

  // When the daemon's REAL agent_reply for a turn arrives after the live stream
  // was already detached (mid-stream interrupt eager-flush), the parking branch
  // no longer finds a live streamEntry and falls through to plain appendMessage.
  // Drop every synthetic interrupt-* for this actor (tracked ref + store rows)
  // and mark the in-flight eager flush superseded so it cannot re-insert.
  function removeInterruptedStreamPlaceholderForRealReply(
    sessionId: string,
    actorId: string,
  ) {
    const streamKey = agentStreamKey(sessionId, actorId);
    interruptedFlushSupersededRef.current[streamKey] = true;
    const tracked = interruptedStreamFlushRef.current[streamKey];
    const liveStreamId =
      useV2StreamingStore.getState().byKey[streamKey]?.streamId?.trim() || "";
    const supersededStreamId = (tracked?.streamId || liveStreamId).trim();
    if (supersededStreamId) {
      interruptedFlushSupersededStreamIdRef.current[streamKey] = supersededStreamId;
    }
    const { messageIds } = resolveInterruptedPlaceholdersToDrop({
      tracked,
      messages: useSessionMessageStore.getState().messages[sessionId] ?? [],
      actorId,
    });
    if (messageIds.length === 0 && !tracked) {
      logExtMsgDiag("interrupt.removeForRealReply.miss", {
        sessionId,
        actorId,
        note: "no tracked placeholder and no interrupt-* rows — ok if eager flush never ran",
      });
      return;
    }
    logExtMsgDiag("interrupt.removeForRealReply.hit", {
      sessionId,
      actorId,
      placeholderMessageId: tracked?.messageId ?? null,
      placeholderStreamId: tracked?.streamId ?? null,
      droppedIds: messageIds,
      superseded: true,
      supersededStreamId: supersededStreamId || null,
    });
    for (const messageId of messageIds) {
      dropInterruptedPlaceholderRow(sessionId, messageId);
    }
    delete interruptedStreamFlushRef.current[streamKey];
  }

  function teamIdForSession(sessionId: string): string {
    return (
      useSessionListStore.getState().rows.find((r) => r.id === sessionId)
        ?.team_id ?? ""
    );
  }

  function flushTurnAgentReply(
    sessionId: string,
    actorId: string,
    trigger = "unknown",
  ): boolean {
    // Reads live byKey stream state below — drain buffered text deltas so the
    // persisted reply includes every arrived chunk (guards the interrupt race).
    flushStreamDeltasFor(sessionId, actorId);
    const streamKey = agentStreamKey(sessionId, actorId);
    if (flushTurnAgentReplyInFlightRef.current[streamKey]) {
      logInterruptMsgDiag("flush.skip.inFlight", { sessionId, actorId, trigger });
      return false;
    }

    const allPendingReplies = pendingStreamRepliesRef.current[streamKey];
    if (!allPendingReplies?.length) {
      logInterruptMsgDiag("flush.skip.noPending", {
        sessionId,
        actorId,
        trigger,
        terminalFlushPending: Boolean(terminalFlushPendingRef.current[streamKey]),
        ...summarizeStreamEntry(
          useV2StreamingStore.getState().byKey[streamKey],
          "live",
        ),
        archivedCount: useV2StreamingStore.getState().archived.filter(
          (entry) => entry.sessionId === sessionId && entry.actorId === actorId,
        ).length,
      });
      return false;
    }

    // Parking is keyed by session::actor only, so a late reply from a PRIOR
    // turn can land in the same bucket as the current turn's slices. Flush only
    // the triggering turn (the most recently parked reply) and leave any other
    // turn's entries parked, so turn A's text is never stitched into turn B's
    // persisted message.
    const triggerTurnId =
      allPendingReplies[allPendingReplies.length - 1]?.turnId ?? "";
    const pendingReplies = allPendingReplies.filter(
      (m) => (m.turnId ?? "") === triggerTurnId,
    );
    const otherTurnReplies = allPendingReplies.filter(
      (m) => (m.turnId ?? "") !== triggerTurnId,
    );

    const liveStreamEntry = useV2StreamingStore.getState().byKey[streamKey];
    const streamEntryForPersist = resolveStreamEntryForPersist(
      sessionId,
      actorId,
      liveStreamEntry,
    );
    const flushDecision = summarizeFlushDecision({
      pending: pendingReplies,
      liveStream: liveStreamEntry,
      resolvedStream: streamEntryForPersist,
    });
    const mergedReply = mergePendingAgentReplies(
      pendingReplies,
      streamEntryForPersist,
    );
    if (!mergedReply) {
      logInterruptMsgDiag("flush.skip.mergeNull", {
        sessionId,
        actorId,
        trigger,
        ...flushDecision,
      });
      return false;
    }

    const pendingReplyTo = resolvePendingAgentReplyTo(
      sessionId,
      actorId,
      mergedReply.replyToMessageId,
    );
    if (pendingReplyTo) {
      mergedReply.replyToMessageId = pendingReplyTo;
    }

    logInterruptMsgDiag("flush.start", {
      sessionId,
      actorId,
      trigger,
      ...flushDecision,
    });
    flushTurnAgentReplyInFlightRef.current[streamKey] = true;
    const pendingSnapshot = [...pendingReplies];
    const streamEntrySnapshot = streamEntryForPersist
      ? cloneStreamEntrySnapshot(streamEntryForPersist)
      : undefined;
    // Retain any other-turn replies so they can flush under their own turn
    // instead of being stitched into this one.
    if (otherTurnReplies.length > 0) {
      pendingStreamRepliesRef.current[streamKey] = otherTurnReplies;
    } else {
      clearTurnAgentReplyParking(streamKey);
    }

    void executeAgentTurnFlush({
      sessionId,
      actorId,
      trigger,
      teamId: teamIdForSession(sessionId),
      reply: mergedReply,
      pendingReplies: pendingSnapshot,
      streamEntrySnapshot,
      beforePersist: () => {
        useV2StreamingStore.getState().finalize(sessionId, actorId);
      },
      afterEnriched: () => {
        removeInterruptedStreamPlaceholder(
          sessionId,
          actorId,
          streamEntrySnapshot?.streamId,
        );
      },
      persistedStage: "flush.persisted",
    }).finally(() => {
      delete flushTurnAgentReplyInFlightRef.current[streamKey];
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
      ensureFollowUpLiveStream(sessionId, actorId);
      // A late interrupted AGENT_REPLY may have parked while this flush was
      // in-flight — drain it now so scheme-A UI is not stuck until next Active.
      if (
        terminalFlushPendingRef.current[streamKey] &&
        (pendingStreamRepliesRef.current[streamKey]?.length ?? 0) > 0
      ) {
        const drained = flushTurnAgentReply(
          sessionId,
          actorId,
          "flush.drainAfterInFlight",
        );
        if (drained) {
          clearTerminalFlushPending(streamKey);
        }
      }
    });

    return true;
  }

  /** Close live docks whose terminal statusChange never arrived. */
  function recoverStaleLiveStreams(trigger: string) {
    const stale = findStaleLiveStreams({
      byKey: useV2StreamingStore.getState().byKey,
      byRuntimeId: useRuntimeStateStore.getState().byRuntimeId,
      now: Date.now(),
    });
    for (const { sessionId, actorId, reason } of stale) {
      const streamKey = agentStreamKey(sessionId, actorId);
      const flushed = flushTurnAgentReply(sessionId, actorId, trigger);
      logInterruptMsgDiag(trigger, {
        sessionId,
        actorId,
        reason,
        flushed,
        ...summarizePendingReplies(pendingStreamRepliesRef.current[streamKey]),
        ...summarizeStreamEntry(
          useV2StreamingStore.getState().byKey[streamKey],
          "live",
        ),
      });
      clearTerminalFlushPending(streamKey);
      if (flushed) continue;
      useV2StreamingStore.getState().finishSessionActor(sessionId, actorId, {
        reason: trigger,
      });
      useV2StreamingStore
        .getState()
        .clearInterruptedFlushPending(sessionId, actorId);
    }
  }

  useEffect(() => {
    registerDiscardPendingStreamReply((sessionId, actorId) => {
      const streamKey = agentStreamKey(sessionId, actorId);
      logInterruptMsgDiag("flush.discardPending", {
        sessionId,
        actorId,
        ...summarizePendingReplies(pendingStreamRepliesRef.current[streamKey]),
      });
      clearTurnAgentReplyParking(streamKey);
      clearTerminalFlushPending(streamKey);
    });
    return () => {
      registerDiscardPendingStreamReply(null);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      recoverStaleLiveStreams("stream.staleRecovery.sweep");
    }, STALE_STREAM_SWEEP_MS);
    // Retains re-flush right after a reconnect; react to them instead of
    // waiting out the sweep interval.
    const unsubscribe = useRuntimeStateStore.subscribe(() => {
      recoverStaleLiveStreams("stream.staleRecovery.runtimeState");
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mqttAuthKey || !userId || !mqttTeamId || !mqttAccessToken) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let identityLease: ReturnType<typeof acquireTeamcluRpcIdentity> | null = null;
    let moduleLeaseGroup: MqttModuleLeaseGroup | null = null;
    const wiringId = crypto.randomUUID();
    recordMqttDiag("app-mqtt", "wiring:effect-start", {
      wiringId,
      userId,
      teamId: mqttTeamId,
      mqttAuthKey,
      accessToken: describeJwt(mqttAccessToken),
      reconnectNonce: mqttReconnectNonce,
    });

    void (async () => {
      try {
        markStartup("mqtt:start");
        recordMqttDiag("app-mqtt", "wiring:start", { wiringId });
        // amuxd convention: MQTT username = actor_id, password = JWT
        // (see amux/daemon/src/mqtt/client.rs + daemon/server.rs).
        // EMQX validates the JWT and uses actor_id for topic ACL.
        const actorId = await resolveCurrentMemberActorId(mqttTeamId, userId, {
          currentTeamId: useCurrentTeamStore.getState().team?.id ?? null,
          currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
        });
        recordMqttDiag("app-mqtt", "actor:resolved", { wiringId, actorId, userId, teamId: mqttTeamId });
        if (!actorId) {
          console.warn("[MQTT] no actor for user in team", mqttTeamId, "— skipping connect");
          recordMqttDiag("app-mqtt", "actor:missing", { wiringId, userId, teamId: mqttTeamId });
          return;
        }
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-actor", { wiringId });
          return;
        }
        onMyActorId(actorId);
        // Publish the RPC identity BEFORE anything transport-related. Every
        // return below this point is a broker problem (no host configured,
        // connect failed), and none of them should cost us the loopback path
        // to this machine's own daemon — which needs only who we are, not a
        // broker. The broker lease further down still adds the MQTT response
        // subscription for remote agents.
        identityLease = acquireTeamcluRpcIdentity(mqttTeamId, actorId, wiringId);
        const serverConfig = await getEffectiveServerConfig();
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-server-config", { wiringId });
          return;
        }
        const brokerHost = serverConfig.mqttHost;
        const brokerPort = serverConfig.mqttPort ?? 1883;
        const useTls = serverConfig.mqttUseTls ?? false;
        const brokerUrl = serverConfig.mqttUrl
          ?? `${useTls ? "mqtts" : "mqtt"}://${brokerHost ?? ""}:${brokerPort}`;
        recordMqttDiag("app-mqtt", "server-config:effective", {
          wiringId,
          brokerHost,
          brokerPort,
          useTls,
          brokerUrl,
          hasConfiguredMqttUsername: Boolean(serverConfig.mqttUsername?.trim()),
          hasConfiguredMqttPassword: Boolean(serverConfig.mqttPassword?.trim()),
          cloudApiUrl: serverConfig.cloudApiUrl,
        });
        // A missing/unreachable broker must NOT abort this wiring. Everything
        // below the envelope listener is broker-specific, but the listener
        // itself is transport-agnostic: the desktop also forwards the local
        // daemon's `/v1/live/events` SSE into the very same `mqtt:envelopes`
        // channel. Returning here meant those local frames arrived at the
        // webview with nobody listening — a local agent's reply was persisted
        // but never streamed, appearing only after switching sessions.
        let brokerUsable = true;
        if (!brokerHost) {
          console.warn("[MQTT] missing broker host — configure it in Settings > Server");
          recordMqttDiag("app-mqtt", "server-config:missing-broker-host", { wiringId });
          brokerUsable = false;
        }
        console.info("[MQTT] connecting", {
          brokerHost,
          brokerPort,
          useTls,
          brokerUrl,
          teamId: mqttTeamId,
          actorId,
        });

        const configuredMqttUsername = serverConfig.mqttUsername?.trim();
        const configuredMqttPassword = serverConfig.mqttPassword?.trim();
        const useConfiguredMqttCredentials = Boolean(configuredMqttUsername && configuredMqttPassword);
        const clientId = `teamclu-${actorId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
        recordMqttDiag("app-mqtt", "connect:before", {
          wiringId,
          clientId,
          username: useConfiguredMqttCredentials ? configuredMqttUsername : actorId,
          usingConfiguredCredentials: useConfiguredMqttCredentials,
          password: useConfiguredMqttCredentials ? "[configured-password]" : describeJwt(mqttAccessToken),
        });

        if (brokerUsable && brokerHost) {
          try {
            await connectMqttWithFreshAuth({
              brokerUrl,
              brokerHost,
              brokerPort,
              username: useConfiguredMqttCredentials ? configuredMqttUsername! : actorId,
              clientId,
              teamId: mqttTeamId,
              useTls,
              configuredPassword: useConfiguredMqttCredentials ? configuredMqttPassword! : undefined,
            });
            recordMqttDiag("app-mqtt", "connect:after", { wiringId, clientId });
            markStartup("mqtt:connected");
            resetSessionLiveSubscriptionState();
            resetInboxSubscriptionState();
            await resubscribeSessionLiveInterest();
            await ensureInboxSubscribed(userId);
          } catch (e) {
            // Keep going: the local SSE path below does not need the broker.
            brokerUsable = false;
            console.warn("[MQTT] connect failed — continuing with local live events only", e);
            recordMqttDiag("app-mqtt", "connect:failed-continuing-local", {
              wiringId,
              error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
            });
          }
        }
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-connect", { wiringId });
          return;
        }

        // Start the four broker-backed state modules before any unrelated
        // subscription/listener await. Browser MQTT subscriptions have no
        // timeout, so putting these later could prevent presence/RPC wiring
        // from ever starting even though the broker connection is healthy.
        if (brokerUsable) {
          recordMqttDiag("app-mqtt", "rpc:init-before", {
            wiringId,
            topic: `amux/${mqttTeamId}/+/rpc/res`,
          });
          registerPlatformExecutors();
          moduleLeaseGroup = acquireMqttModuleLeaseGroup([
            {
              name: 'teamclu-rpc',
              acquire: () => acquireTeamcluRpcBroker(mqttTeamId, actorId, wiringId),
            },
            {
              name: 'remote-tools-rpc',
              acquire: () => acquireRemoteToolsRpcServer({ teamId: mqttTeamId, actorId }, wiringId),
            },
            {
              name: 'runtime-state',
              acquire: () => acquireRuntimeStateStore(mqttTeamId, wiringId),
            },
            {
              name: 'actor-presence',
              acquire: () => acquireActorPresenceStore(mqttTeamId, wiringId),
            },
          ]);
        }

        // FC fans out to inbox/<auth.user_id> (see push-dispatch.ts), not actor_id.
        if (brokerUsable) {
          try {
            recordMqttDiag("app-mqtt", "inbox:subscribe-before", { wiringId, topic: `inbox/${userId}` });
            await ensureInboxSubscribed(userId);
            recordMqttDiag("app-mqtt", "inbox:subscribe-ok", { wiringId, topic: `inbox/${userId}` });
          } catch (e) {
            console.warn("[inbox] subscribe failed", e);
            recordMqttDiag("app-mqtt", "inbox:subscribe-error", {
              wiringId,
              topic: `inbox/${userId}`,
              error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
            });
          }
        }
        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-inbox", { wiringId });
          return;
        }

        recordMqttDiag("app-mqtt", "listen:before", { wiringId });
        unlisten = await listenForEnvelopes((env) => {
          if (env.topic.startsWith("inbox/")) {
            handleInboxEnvelope(env, userId, useSessionListStore.getState(), console, {
              onMessagePing: (sessionId) => onInboxMessagePingRef.current(sessionId),
            });
            return;
          }
          const decoded = decodeLiveEvent(new Uint8Array(env.bytes));
          if (!decoded) return;
          const sid = sessionIdFromLiveEvent(decoded, env.topic) ?? "";

          if (
            sid &&
            env.topic.includes("/session/") &&
            env.topic.endsWith("/live")
          ) {
            touchLiveEventActivity(sid);
          }

          if (
            sid &&
            env.topic.includes("/session/") &&
            !rememberLiveEventId(
              seenLiveEventIdsRef.current,
              sid,
              decoded.envelope.eventId,
            )
          ) {
            // Second copy of a dual-path event (local daemon SSE fast-path +
            // MQTT deliver the same eventId) or an MQTT redelivery.
            bumpLiveDuplicateDropped();
            return;
          }

          if (
            sid &&
            env.topic.includes("/session/") &&
            env.topic.endsWith("/live") &&
            !isSessionLiveInterest(sid)
          ) {
            // Background list maintenance only — inbox is the primary path, but
            // still pull unknown sessions when a message.created slips through.
            if (
              decoded.envelope.eventType === "message.created" &&
              decoded.message &&
              messageKindUpdatesSessionPreview(decoded.message.kind)
            ) {
              const listStore = useSessionListStore.getState();
              const row = listStore.rows.find((r) => r.id === sid);
              if (!row) {
                scheduleSessionListRefresh(() => listStore.loadFirstPage());
              } else {
                const createdAtSec = decoded.message.createdAt;
                bumpSessionListLastMessage(sid, decoded.message.content, {
                  at: createdAtSec > 0n
                    ? unixTimestampSecondsToIso(createdAtSec)
                    : undefined,
                });
                scheduleMarkActiveSessionRead(sid, decoded.message.messageId);
              }
            }
            return;
          }

          if (env.topic.includes("/session/") && env.topic.endsWith("/live")) {
            const mentionActorIds =
              decoded.envelope.eventType === "message.created"
                ? decoded.sessionMessage?.mentionActorIds ?? []
                : undefined;
            useAcpDebugStore.getState().append({
              sessionId: sid,
              topic: env.topic,
              actorId: decoded.envelope.actorId,
              eventCase: `live:${decoded.envelope.eventType || "unknown"}`,
              envelopeMeta: {
                eventId: decoded.envelope.eventId,
                eventType: decoded.envelope.eventType,
                sentAt: decoded.envelope.sentAt?.toString?.() ?? "",
                actorId: decoded.envelope.actorId,
                sessionId: decoded.envelope.sessionId,
                hasAcpEvent: Boolean(decoded.acpEvent),
                acpCase: decoded.acpEvent?.event?.case ?? null,
                ...(mentionActorIds !== undefined
                  ? {
                      mentionActorIds,
                      contentPreview: decoded.sessionMessage?.message?.content?.slice(0, 80) ?? "",
                    }
                  : {}),
              },
              acpEvent: decoded.acpEvent,
            });
          }

          if (!sid) return;

          if (decoded.envelope.eventType === "session.title_updated") {
            // Daemon adopted an opencode-generated title over a default one —
            // update the session list in place (body is the UTF-8 title).
            const title = new TextDecoder().decode(decoded.envelope.body).trim();
            if (title) {
              useSessionListStore.getState().patchRow(sid, { title });
            }
            return;
          }

          if (
            decoded.envelope.eventType === "session_participant.created" ||
            decoded.envelope.eventType === "session_participant.updated" ||
            decoded.envelope.eventType === "session_participant.deleted" ||
            decoded.envelope.eventType === "participant.added" ||
            decoded.envelope.eventType === "participant.removed" ||
            decoded.envelope.eventType === "session.participant.added" ||
            decoded.envelope.eventType === "session.participant.removed"
          ) {
            const teamId =
              useSessionListStore.getState().rows.find((r) => r.id === sid)
                ?.team_id ?? mqttTeamId;
            void useSessionParticipantStore
              .getState()
              .refreshSession(sid, teamId)
              .catch((e) => {
                console.warn("[participants] refresh failed:", e);
              });
            return;
          }

          // Case 1: final message.created
          if (decoded.message) {
            // This branch reads/finalizes ordered stream state below — drain
            // any buffered text deltas so finalize/persist see all arrived text.
            flushAllStreamDeltas();
            const msg = decoded.message;
            const senderActorId = msg.senderActorId;
            const streamingStore = useV2StreamingStore.getState();
            const streamKey = senderActorId ? agentStreamKey(sid, senderActorId) : "";
            const streamEntry = streamKey
              ? streamingStore.byKey[streamKey]
              : undefined;
            let parkedAgentReply = false;
            if (
              streamEntry &&
              senderActorId &&
              msg.kind === MessageKind.AGENT_REPLY
            ) {
              // Mid-turn daemon AgentReply slices stay parked until terminal
              // statusChange (or a late message.created after terminal).
              parkedAgentReply = true;
              const pendingReplies =
                pendingStreamRepliesRef.current[streamKey] ?? [];
              const nextPendingReplies = pendingReplies.some(
                (message) => message.messageId === msg.messageId,
              )
                ? pendingReplies
                : [...pendingReplies, msg];
              if (nextPendingReplies !== pendingReplies) {
                pendingStreamRepliesRef.current[streamKey] = nextPendingReplies;
              }
              const resolvedStreamEntry = resolveStreamEntryForPersist(
                sid,
                senderActorId,
                streamEntry,
              );
              const terminalPending = Boolean(
                terminalFlushPendingRef.current[streamKey],
              );
              const toolOnlyAnchor = isToolOnlyTurnAnchor(
                nextPendingReplies,
                resolvedStreamEntry,
              );
              const shouldFlush =
                terminalPending || toolOnlyAnchor;
              logInterruptMsgDiag("mqtt.agentReply.parked", {
                sessionId: sid,
                actorId: senderActorId,
                messageId: msg.messageId,
                turnId: msg.turnId,
                contentLength: (msg.content ?? "").trim().length,
                terminalPending,
                toolOnlyAnchor,
                shouldFlush,
                ...summarizeFlushDecision({
                  pending: nextPendingReplies,
                  liveStream: streamEntry,
                  resolvedStream: resolvedStreamEntry,
                }),
              });
              if (shouldFlush) {
                const flushed = flushTurnAgentReply(
                  sid,
                  senderActorId,
                  terminalPending
                    ? "mqtt.message.created.terminalPending"
                    : "mqtt.message.created.toolOnlyAnchor",
                );
                if (flushed && terminalPending) {
                  clearTerminalFlushPending(streamKey);
                }
              }
            } else if (streamEntry && senderActorId) {
              streamingStore.finalize(
                sid,
                senderActorId,
                decoded.message.content,
              );
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
            } else {
              // Late REAL agent_reply after the live stream was detached by an
              // eager interrupt-flush: purge the synthetic anchor first so the
              // real reply doesn't duplicate it (survives reload otherwise).
              if (senderActorId && msg.kind === MessageKind.AGENT_REPLY) {
                removeInterruptedStreamPlaceholderForRealReply(sid, senderActorId);
                // Direct-append skips flushTurnAgentReply — still drop the
                // stamped parent from the local FIFO so a later flush cannot
                // reuse a stale user message id.
                const stampedReplyTo = msg.replyToMessageId?.trim();
                if (stampedReplyTo) {
                  removePendingAgentReplyTo(sid, senderActorId, stampedReplyTo);
                }
                logExtMsgDiag("mqtt.agentReply.lateAppend.noPartsPersist", {
                  sessionId: sid,
                  actorId: senderActorId,
                  note: "late AGENT_REPLY after stream detach — append without persistStreamingPartsForReply",
                  ...summarizeProtoForExtDiag(msg),
                });
              }
              useSessionMessageStore.getState().appendMessage(sid, decoded.message);
              if (senderActorId && msg.kind === MessageKind.AGENT_REPLY) {
                logExtMsgDiag("mqtt.agentReply.lateAppend.storeSnapshot", {
                  sessionId: sid,
                  ...summarizeProtosForExtDiag(
                    useSessionMessageStore.getState().messages[sid] ?? [],
                  ),
                });
              }
            }

            if (
              msg.kind === MessageKind.TEXT ||
              (msg.kind === MessageKind.AGENT_REPLY && !parkedAgentReply)
            ) {
              useV2StreamingStore.getState().clearStaleStreamErrors(
                sid,
                msg.kind === MessageKind.AGENT_REPLY ? senderActorId : undefined,
              );
            }

            if (
              !parkedAgentReply &&
              messageKindUpdatesSessionPreview(decoded.message.kind)
            ) {
              const listStore = useSessionListStore.getState();
              const sessionInList = listStore.rows.some((r) => r.id === sid);
              if (sessionInList) {
                const createdAtSec = decoded.message.createdAt;
                bumpSessionListLastMessage(sid, decoded.message.content, {
                  at: createdAtSec > 0n
                    ? unixTimestampSecondsToIso(createdAtSec)
                    : undefined,
                });
                scheduleMarkActiveSessionRead(sid, decoded.message.messageId);
              } else {
                // Invited to a new session: bump is a no-op until the row exists.
                scheduleSessionListRefresh(() => listStore.loadFirstPage());
              }
            }

            // Write ALL incoming messages into the unified `message` table
            // (origin="mqtt-live"). This replaces the old agent_runtime_event
            // writes for tool-call/result/thinking kinds.
            // The insertAgentRuntimeEvent table stays alive for backwards compat
            // but is no longer the primary read path.
            // TODO(cleanup): remove insertAgentRuntimeEvent writes once all
            //   clients have upgraded past this version and the old read path
            //   in history loader above is cleaned up.
            if (!parkedAgentReply) {
              const m = decoded.message;
              const kindStr =
                m.kind === MessageKind.AGENT_TOOL_CALL
                  ? "agent_tool_call"
                  : m.kind === MessageKind.AGENT_TOOL_RESULT
                    ? "agent_tool_result"
                    : m.kind === MessageKind.AGENT_THINKING
                      ? "agent_thinking"
                      : m.kind === MessageKind.AGENT_REPLY
                        ? "agent_reply"
                        : m.kind === MessageKind.SYSTEM
                          ? "system"
                          : "text";
              const teamId =
                useSessionListStore.getState().rows.find(
                  (r) => r.id === sid,
                )?.team_id ?? "";
              const now = new Date().toISOString();
              const msgRow: MessageRow = {
                id: m.messageId,
                teamId,
                sessionId: m.sessionId,
                turnId: m.turnId || null,
                senderActorId: m.senderActorId || null,
                replyToMessageId: m.replyToMessageId?.trim() || null,
                kind: kindStr,
                content: m.content,
                metadataJson: m.metadataJson || null,
                model: m.model || null,
                mentionsJson: null,
                origin: "mqtt-live",
                createdAt: unixTimestampSecondsToIso(m.createdAt),
                updatedAt: now,
                deletedAt: null,
                syncedAt: now,
                partsJson: (m as unknown as { partsJson?: string | null }).partsJson ?? null,
              };
              upsertMessagesBatch([msgRow]).catch((e) => {
                console.warn("[cache] message upsert failed:", e);
              });
            }
            return;
          }

          // Case 2a: SessionEvent (e.g. PermissionResolved) arrives as
          // LiveEventEnvelope event_type=acp.event with Amux payload.sessionEvent.
          // Must run outside `if (decoded.acpEvent)` — that field is only set for
          // payload.case === "acpEvent".
          if (decoded.amuxEnvelope?.payload?.case === "sessionEvent") {
            const se = decoded.amuxEnvelope.payload.value?.event;
            if (se?.case === "permissionResolved") {
              const requestId = (se.value as { requestId?: string })?.requestId ?? "";
              handleSessionEventPermissionResolved({
                requestId,
                sessionIdHint: sid,
              });
            }
            return;
          }

          // Case 2: streaming acp.event
          if (decoded.acpEvent) {
            // Dev-only one-way latency probe (no-op unless the local daemon
            // runs with AMUX_LATENCY_PROBE=1). See lib/latency-probe.ts.
            recordLatencyProbe(decoded.amuxEnvelope?.sourcePeerId);
            const actorId = streamActorIdFromLiveEvent(decoded);
            if (!actorId) return;
            const acpSid = decoded.amuxEnvelope?.acpSessionId?.trim() ?? "";
            if (acpSid) {
              const streamStore = useV2StreamingStore.getState();
              const eventCase = decoded.acpEvent.event?.case;
              const parentToolId = streamStore.childAcpSessionToToolId[acpSid];
              if (eventCase === "permissionRequest") {
                // Subagent permission must surface on the parent actor immediately.
                // Do NOT buffer waiting for task→child bind: opencode often asks
                // before task rawOutput carries sessionId, and a buffered ask
                // never renders a card (agent hangs forever).
                // Do NOT bind via params.toolCallId — that is the child tool
                // (e.g. bash), not the parent task tool id.
                const pr2 = decoded.acpEvent.event?.value as {
                  requestId?: string;
                  toolName?: string;
                  description?: string;
                  params?: Record<string, string>;
                  options?: Array<{ optionId?: string; kind?: string; name?: string }>;
                };
                const childSid =
                  pr2.params?.childSessionId?.trim() || acpSid;
                const bindTo =
                  parentToolId ??
                  resolveOrphanSubagentParentToolId(sid, actorId, streamStore);
                if (bindTo && childSid) {
                  tryBindChildFromPermission(sid, actorId, childSid, bindTo);
                }
                void handleAcpPermissionRequest({
                  sessionId: sid,
                  agentActorId: actorId,
                  request: {
                    requestId: pr2.requestId ?? "",
                    toolName: pr2.toolName ?? "",
                    description: pr2.description ?? "",
                    params: {
                      ...(pr2.params ?? {}),
                      childSessionId: childSid,
                      ...(bindTo ? {} : { _subagent_unbound_task: "1" }),
                    },
                    requesterActorId:
                      pr2.params?.requester_actor_id?.trim() || undefined,
                    options: (pr2.options ?? []).map((o) => ({
                      optionId: o.optionId ?? "",
                      kind: o.kind ?? "",
                      name: o.name ?? "",
                    })),
                  },
                });
                return;
              } else {
                if (parentToolId) {
                  routeSubagentAcpEvent(sid, actorId, parentToolId, decoded.acpEvent);
                  return;
                }
                if (shouldBufferUnboundChildAcpEvent(sid, actorId, acpSid, streamStore)) {
                  streamStore.bufferPendingSubagentEvent(acpSid, decoded.acpEvent);
                  return;
                }
              }
            } else {
              const streamStoreForOrphan = useV2StreamingStore.getState();
              const orphanTaskToolId = resolveOrphanSubagentParentToolId(
                sid,
                actorId,
                streamStoreForOrphan,
              );
              if (orphanTaskToolId) {
                const orphanEventCase = decoded.acpEvent.event?.case;
                if (orphanEventCase === "permissionRequest") {
                  // Orphan subagent permission (no acpSid on envelope): route
                  // to the single unbound calling task tool.
                  const prO = decoded.acpEvent.event?.value as {
                    requestId?: string;
                    toolName?: string;
                    description?: string;
                    params?: Record<string, string>;
                    options?: Array<{ optionId?: string; kind?: string; name?: string }>;
                  };
                  const childSid = prO.params?.childSessionId?.trim() ?? "";
                  if (childSid) {
                    tryBindChildFromPermission(
                      sid,
                      actorId,
                      childSid,
                      orphanTaskToolId,
                    );
                  }
                  void handleAcpPermissionRequest({
                    sessionId: sid,
                    agentActorId: actorId,
                    request: {
                      requestId: prO.requestId ?? "",
                      toolName: prO.toolName ?? "",
                      description: prO.description ?? "",
                      params: prO.params ?? {},
                      requesterActorId:
                        prO.params?.requester_actor_id?.trim() || undefined,
                      options: (prO.options ?? []).map((o) => ({
                        optionId: o.optionId ?? "",
                        kind: o.kind ?? "",
                        name: o.name ?? "",
                      })),
                    },
                  });
                  return;
                }
                if (shouldRouteOrphanSubagentEvent(decoded.acpEvent, orphanTaskToolId)) {
                  routeSubagentAcpEvent(
                    sid,
                    actorId,
                    orphanTaskToolId,
                    decoded.acpEvent,
                  );
                  return;
                }
              }
            }

            const event = decoded.acpEvent.event;

            // Non-text events read/mutate ordered stream state — drain any
            // buffered text deltas for this stream first so parts ordering
            // matches arrival order.
            if (event?.case !== "output" && event?.case !== "thinking") {
              flushStreamDeltasFor(sid, actorId);
            }

            // acp.event detail already logged in the live:* line above.
            if (event?.case === "output") {
              const text = (event.value as { text?: string })?.text ?? "";
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              if (
                !(
                  getFlushedTurn(sid, actorId) &&
                  (!liveEntry || !isStreamInterruptible(liveEntry))
                )
              ) {
                bufferStreamDelta("output", sid, actorId, text);
              }
            } else if (event?.case === "thinking") {
              const text = (event.value as { text?: string })?.text ?? "";
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              if (
                !(
                  getFlushedTurn(sid, actorId) &&
                  (!liveEntry || !isStreamInterruptible(liveEntry))
                )
              ) {
                bufferStreamDelta("thinking", sid, actorId, text);
              }
            } else if (event?.case === "toolUse") {
              const tu = normalizeToolUseEvent(event.value);
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              if (shouldPatchFlushedToolEvent(sid, actorId, tu.toolId, liveEntry)) {
                logStreamToolDiag("mqtt.toolUse.skipAfterFlush", {
                  sessionId: sid,
                  actorId,
                  toolId: tu.toolId,
                });
                void patchPersistedToolUse({
                  sessionId: sid,
                  actorId,
                  toolId: tu.toolId,
                  toolName: tu.toolName,
                  description: tu.description,
                  params: tu.params,
                  toolKind: tu.toolKind,
                  content: tu.content,
                  locations: tu.locations,
                  acpStatus: tu.acpStatus,
                  rawInput: tu.rawInput,
                });
              } else {
                useV2StreamingStore.getState().pushToolUse(sid, actorId, {
                  toolId: tu.toolId,
                  toolName: tu.toolName,
                  description: tu.description,
                  params: tu.params,
                  toolKind: tu.toolKind,
                  content: tu.content,
                  locations: tu.locations,
                  acpStatus: tu.acpStatus,
                  rawInput: tu.rawInput,
                  rawOutput: tu.rawOutput,
                });
                // Capture skill invocations for the cloud leaderboard's skill
                // dimension. tu.toolName is "skill" for Skill tool calls;
                // tu.params.name is the skill slug (e.g. "sentry-fix").
                if (
                  (tu.toolName === "skill" || tu.params?.description === "skill") &&
                  tu.params?.name
                ) {
                  void reportSkillUsage(tu.params.name);
                }
                syncPlanFromTodoTool(sid, actorId, {
                  toolName: tu.toolName,
                  params: tu.params,
                  description: tu.description,
                });
              }
            } else if (event?.case === "toolResult") {
              const tr = normalizeToolResultEvent(event.value);
              const liveEntry =
                useV2StreamingStore.getState().byKey[agentStreamKey(sid, actorId)];
              logStreamToolDiag("mqtt.toolResult", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                toolId: tr.toolId,
                success: tr.success,
              });
              if (shouldPatchFlushedToolEvent(sid, actorId, tr.toolId, liveEntry)) {
                void patchPersistedToolResult({
                  sessionId: sid,
                  actorId,
                  toolId: tr.toolId,
                  success: tr.success,
                  summary: tr.summary,
                  content: tr.content,
                  rawOutput: tr.rawOutput,
                });
              } else {
                useV2StreamingStore.getState().completeToolUse(sid, actorId, {
                  toolId: tr.toolId,
                  success: tr.success,
                  summary: tr.summary,
                  content: tr.content,
                  rawOutput: tr.rawOutput,
                });
                void patchPersistedToolResult({
                  sessionId: sid,
                  actorId,
                  toolId: tr.toolId,
                  success: tr.success,
                  summary: tr.summary,
                  content: tr.content,
                  rawOutput: tr.rawOutput,
                });
                void syncStreamingToolOutputsFromLocalCache(sid, actorId);
                window.setTimeout(() => {
                  void syncStreamingToolOutputsFromLocalCache(sid, actorId);
                }, 500);
              }
              syncPlanFromTodoToolResult(sid, actorId, {
                toolId: tr.toolId,
                success: tr.success,
                summary: tr.summary,
              });
            } else if (event?.case === "statusChange") {
              const sc = event.value as { oldStatus?: number; newStatus?: number };
              logStreamToolDiag("mqtt.statusChange", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                oldStatus: sc.oldStatus,
                newStatus: sc.newStatus,
              });
              if (isTurnOpeningStatusChange(sc.oldStatus, sc.newStatus)) {
                const streamKey = agentStreamKey(sid, actorId);
                followUpActiveRef.current[streamKey] = true;
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.active",
                );
                logInterruptMsgDiag("mqtt.statusChange.active", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushedPreviousTurn: flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[agentStreamKey(sid, actorId)],
                  ),
                });
                clearTerminalFlushPending(agentStreamKey(sid, actorId));
                useV2StreamingStore.getState().beginPlanningPlaceholder(sid, actorId);
              } else if (isTerminalAgentStatus(sc.newStatus)) {
                const streamKey = agentStreamKey(sid, actorId);
                clearFollowUpActive(streamKey);
                terminalFlushPendingRef.current[streamKey] = true;
                const flushed = flushTurnAgentReply(
                  sid,
                  actorId,
                  "mqtt.statusChange.terminal",
                );
                logInterruptMsgDiag("mqtt.statusChange.terminal", {
                  sessionId: sid,
                  actorId,
                  oldStatus: sc.oldStatus,
                  newStatus: sc.newStatus,
                  flushed,
                  ...summarizePendingReplies(
                    pendingStreamRepliesRef.current[streamKey],
                  ),
                  ...summarizeStreamEntry(
                    useV2StreamingStore.getState().byKey[streamKey],
                    "live",
                  ),
                });
                if (flushed) {
                  clearTerminalFlushPending(streamKey);
                } else {
                  const streamEntry =
                    useV2StreamingStore.getState().byKey[streamKey];
                  if (streamEntryHasVisibleContent(streamEntry)) {
                    // Wait for daemon AGENT_REPLY (incl. interrupted). Do not
                    // invent interrupt-* placeholders — those bypass cloud
                    // persist and break catchup after restart.
                    logInterruptMsgDiag(
                      "mqtt.statusChange.terminal.awaitDaemonReply",
                      {
                        sessionId: sid,
                        actorId,
                        ...summarizeStreamEntry(streamEntry, "live"),
                      },
                    );
                    scheduleTerminalDaemonReplyTimeout(sid, actorId);
                  } else {
                    useV2StreamingStore.getState().setError(
                      sid,
                      actorId,
                      t(
                        "daemon.agentRuntime.emptyReply",
                        "Agent returned no output. The selected model may be unavailable or misconfigured.",
                      ),
                      "",
                    );
                  }
                }
              }
            } else if (event?.case === "error") {
              const er = event.value as { message?: string; details?: string };
              // User interrupt (opencode MessageAbortedError) is not a fault.
              // SSE turn order: tool cleanup → session.error → session.idle.
              // Defer flush/detach until statusChange.terminal (idle) so late
              // tool results land on the live stream instead of spawning a
              // phantom active entry (Unknown tool / stuck running card).
              // Stop UI comes from daemon interrupted AGENT_REPLY, not SessionErrorAlert.
              if (isAgentTurnAbortError(er.message, er.details)) {
                // Interrupted AGENT_REPLY (daemon metadata.turn_status) owns
                // the user-facing stop UI — do not also raise SessionErrorAlert.
                const streamKey = agentStreamKey(sid, actorId);
                terminalFlushPendingRef.current[streamKey] = true;
                logInterruptMsgDiag("mqtt.error.abort.deferToIdle", {
                  sessionId: sid,
                  actorId,
                  ...summarizeStreamEntry(
                    useV2StreamingStore.getState().byKey[streamKey],
                    "live",
                  ),
                });
              } else {
                terminalFlushPendingRef.current[agentStreamKey(sid, actorId)] = true;
                flushTurnAgentReply(sid, actorId, "mqtt.error");
                // Localize known daemon-emitted errors (the daemon is
                // locale-agnostic and emits English for iOS/logs). Keep the raw
                // message for anything we don't recognize.
                const localizedMessage = localizeAgentTurnErrorMessage(er.message, t);
                useV2StreamingStore.getState().setError(
                  sid,
                  actorId,
                  localizedMessage,
                  er.details ?? "",
                );
                // The live dock unmounts as soon as a turn errors
                // (isStreamInterruptible excludes errored entries), so the dock's
                // ErrorCard is never seen. Surface every turn error as a durable
                // SessionErrorAlert bubble in the thread instead.
                {
                  const detail = (er.details ?? "").trim();
                  const errorName = classifyAgentTurnErrorName(er.message);
                  useSessionStore.getState().setSessionErrorEvent({
                    sessionId: sid,
                    error: {
                      name: errorName,
                      data: {
                        message: formatAgentTurnErrorDisplayMessage(localizedMessage, detail),
                      },
                    },
                  });
                }
              }
            } else if (event?.case === "raw") {
              const raw = event.value as { method?: string; jsonPayload?: Uint8Array };
              const method = raw.method ?? "";
              if (
                method === "question_asked" ||
                method === "question_replied" ||
                method === "question_rejected"
              ) {
                try {
                  const payload = JSON.parse(
                    new TextDecoder().decode(raw.jsonPayload ?? new Uint8Array()),
                  ) as Record<string, unknown>;
                  const store = useSessionStore.getState();
                  if (method === "question_asked") {
                    const tool = (payload.tool ?? {}) as { messageID?: string; callID?: string };
                    const questions: Question[] = Array.isArray(payload.questions)
                      ? (payload.questions as Array<Record<string, unknown>>).map((q, i) => ({
                          id: String(i),
                          header: typeof q.header === "string" ? q.header : "",
                          question: typeof q.question === "string" ? q.question : "",
                          options: Array.isArray(q.options) ? (q.options as QuestionOption[]) : [],
                          multiple: !!q.multiple,
                        }))
                      : [];
                    store.addPendingQuestion({
                      questionId: String(payload.id ?? ""),
                      toolCallId: tool.callID ?? "",
                      messageId: tool.messageID ?? "",
                      questions,
                      sessionId: sid,
                      agentActorId: actorId,
                      source: "agent",
                    });
                  } else {
                    store.resolveQuestion(String(payload.requestID ?? payload.id ?? ""));
                  }
                } catch (e) {
                  console.warn("[question] raw event parse failed", e);
                }
              }
            } else if (event?.case === "permissionRequest") {
              const pr = event.value as {
                requestId?: string;
                toolName?: string;
                description?: string;
                params?: Record<string, string>;
                options?: Array<{ optionId?: string; kind?: string; name?: string }>;
              };
              logStreamToolDiag("mqtt.permissionRequest", {
                sessionId: sid,
                actorId,
                eventId: decoded.envelope.eventId,
                requestId: pr.requestId,
                toolName: pr.toolName,
                description: pr.description,
                isDoomLoop: pr.toolName === "doom_loop",
              });
              // params.toolCallId is the tool that asked (bash/…), not the parent
              // task tool — only bind when we can resolve the parent task id.
              const childSid = pr.params?.childSessionId?.trim() ?? "";
              if (childSid) {
                const orphanTask = resolveOrphanSubagentParentToolId(
                  sid,
                  actorId,
                  useV2StreamingStore.getState(),
                );
                if (orphanTask) {
                  tryBindChildFromPermission(sid, actorId, childSid, orphanTask);
                }
              }
              void handleAcpPermissionRequest({
                sessionId: sid,
                agentActorId: actorId,
                request: {
                  requestId: pr.requestId ?? "",
                  toolName: pr.toolName ?? "",
                  description: pr.description ?? "",
                  params: pr.params ?? {},
                  requesterActorId:
                    pr.params?.requester_actor_id?.trim() || undefined,
                  options: (pr.options ?? []).map((o) => ({
                    optionId: o.optionId ?? "",
                    kind: o.kind ?? "",
                    name: o.name ?? "",
                  })),
                },
              });
            } else if (event?.case === "planUpdate") {
              const pu = event.value as { entries?: Array<{ content?: string; priority?: string; status?: string }> };
              useV2StreamingStore.getState().setPlan(
                sid,
                actorId,
                mapAcpPlanEntries(pu.entries ?? []),
              );
            }
            // statusChange / availableCommands / raw: MVP no-op (RuntimeInfo retain
            // already surfaces agent status; commands TBD; raw is catch-all).
          }
        });
        recordMqttDiag("app-mqtt", "listen:after", { wiringId });
        if (cancelled) {
          unlisten?.();
          recordMqttDiag("app-mqtt", "wiring:cancelled-after-listen", { wiringId });
          return;
        }

        // Prefer the member ACL's team-wide session/live subscription so
        // desktop receives replies for sessions that another logged-in client
        // created or moved. Fall back to the old recent-session slice if a
        // broker still has older ACL claims.
        // Broker-only from here: subscriptions and the RPC response topic.
        // With no broker the envelope listener above still runs, fed by the
        // local daemon's SSE tee.
        if (!brokerUsable) {
          recordMqttDiag("app-mqtt", "wiring:local-only", { wiringId });
          console.info("[MQTT] no broker — local live events only");
          return;
        }

        if (cancelled) {
          recordMqttDiag("app-mqtt", "wiring:cancelled-before-modules", { wiringId });
          return;
        }

        const moduleResults = await moduleLeaseGroup!.ready;
        moduleResults.forEach((result) => {
          if (result.status === 'fulfilled') {
            recordMqttDiag("app-mqtt", `${result.name}:init-ok`, { wiringId });
            return;
          }
          console.error(`[MQTT] ${result.name} initialization failed`, result.reason);
          recordMqttDiag("app-mqtt", `${result.name}:init-error`, {
            wiringId,
            error: result.reason instanceof Error
              ? { name: result.reason.name, message: result.reason.message, stack: result.reason.stack }
              : String(result.reason),
          });
        });
        if (cancelled) return;
        recordMqttDiag("app-mqtt", "wiring:ready", { wiringId });

        // Background: sync actor directory into local cache so display-name
        // lookups hit libsql instead of Supabase on subsequent renders.
        void syncActorsForTeam(mqttTeamId).catch((e) =>
          console.warn('[cache-sync] actor sync failed:', e),
        );

        // Background: sync ideas into local cache.
        void syncIdeasForTeam(mqttTeamId).catch((e) =>
          console.warn('[cache-sync] idea sync failed:', e),
        );

        // Background: sync sessions into local cache. E2E control owns the
        // session-list rows while active, so skip normal hydration/reloads.
        if (!isV2E2EControlActive()) {
          void syncSessionsForTeam(mqttTeamId).then(() => {
            if (isV2E2EControlActive()) return;
            // Reload session list from merged local cache after sync finishes.
            void useSessionListStore.getState().load();
          }).catch((e) =>
            console.warn('[cache-sync] session sync failed:', e),
          );
        }
      } catch (err) {
        console.error("[MQTT] receiver wiring failed:", err);
        recordMqttDiag("app-mqtt", "wiring:error", {
          wiringId,
          error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
      recordMqttDiag("app-mqtt", "wiring:cleanup", { wiringId });
      unlisten?.();
      pendingStreamRepliesRef.current = {};
      for (const streamKey of Object.keys(terminalAwaitTimeoutRef.current)) {
        clearTerminalAwaitTimeout(streamKey);
      }
      terminalFlushPendingRef.current = {};
      followUpActiveRef.current = {};
      interruptedStreamFlushRef.current = {};
      interruptedFlushSupersededRef.current = {};
      interruptedFlushSupersededStreamIdRef.current = {};
      moduleLeaseGroup?.release();
      identityLease?.release();
    };
  }, [mqttAuthKey, userId, mqttTeamId, mqttAccessToken, mqttReconnectNonce]);

  // Foreground session/live: active TeamClu session + background streaming/approval.
  const activeSessionIdForSubscribe = useSessionSelectionStore((s) => s.activeSessionId);
  const liveInterestExtrasKey = useV2StreamingStore((s) =>
    collectSessionsNeedingLiveInterest(s.byKey).sort().join(","),
  );
  const activeSessionTeamId = useSessionListStore((s) =>
    activeSessionIdForSubscribe
      ? s.rows.find((r) => r.id === activeSessionIdForSubscribe)?.team_id ?? null
      : null,
  );
  const openedSessionInterestRevision = useSessionLiveInterestStore((s) => s.revision);
  useEffect(() => {
    if (!userId || !mqttTeamId) {
      resetInboxIdleInterestState();
      void syncSessionLiveInterest(null, []);
      return;
    }
    let cancelled = false;

    void (async () => {
      const stream = useV2StreamingStore.getState();
      const backgroundIds = collectSessionsNeedingLiveInterest(stream.byKey);
      const interestIds = mergeSessionLiveInterestIds(
        activeSessionIdForSubscribe,
        backgroundIds,
      );
      if (interestIds.length === 0) {
        await syncSessionLiveInterest(null, []);
        return;
      }
      const teamId = activeSessionTeamId ?? mqttTeamId;
      if (cancelled) return;
      await syncSessionLiveInterest(teamId, interestIds).catch((e) => {
        console.warn("[MQTT] sync session/live interest failed", e);
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionIdForSubscribe,
    activeSessionTeamId,
    liveInterestExtrasKey,
    inboxIdleRevision,
    openedSessionInterestRevision,
    mqttTeamId,
    mqttReconnectNonce,
    userId,
  ]);

  useEffect(() => {
    if (!userId || !mqttTeamId) {
      stopInboxIdleSweep();
      return;
    }
    startInboxIdleSweep(() => {
      const stream = useV2StreamingStore.getState();
      const active = useSessionSelectionStore.getState().activeSessionId;
      const pinned = new Set([
        ...(active?.trim() ? [active.trim()] : []),
        ...collectSessionsNeedingLiveInterest(stream.byKey),
      ]);
      if (pruneIdleInboxSessions(pinned)) {
        scheduleLiveInterestSyncRef.current();
      }
    });
    return () => stopInboxIdleSweep();
  }, [userId, mqttTeamId]);

  useEffect(() => {
    return () => {
      if (liveInterestSyncTimerRef.current) {
        clearTimeout(liveInterestSyncTimerRef.current);
      }
      resetInboxIdleInterestState();
      void syncSessionLiveInterest(null, []);
    };
  }, []);

  return null;
}
