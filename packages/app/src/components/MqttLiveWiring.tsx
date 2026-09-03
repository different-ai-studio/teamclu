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
import { handleAcpEvent } from "@/components/mqtt-live-wiring/handle-acp-event";
import { handleLiveMessage } from "@/components/mqtt-live-wiring/handle-live-message";
import type { LiveWiringContext } from "@/components/mqtt-live-wiring/context";
import { useEffect, useRef, useState } from "react";
import { markStartup } from "@/lib/telemetry/startup-perf";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionParticipantStore } from "@/stores/session-participant-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useAuthStore } from "@/stores/auth-store";
import { listenForEnvelopes } from "@/lib/mqtt/mqtt-bridge";
import { connectMqttWithFreshAuth } from "@/lib/mqtt/mqtt-connect-with-fresh-auth";
import { mqttConnectionKey } from "@/lib/mqtt/mqtt-connection-key";
import { describeJwt, recordMqttDiag } from "@/lib/mqtt/mqtt-diagnostics";
import { useMqttReconnectStore } from "@/stores/mqtt-reconnect";
import { getEffectiveServerConfig } from "@/lib/config/server-config";
import { acquireTeamcluRpcBroker, acquireTeamcluRpcIdentity } from "@/lib/daemon/teamclu-rpc";
import { acquireRemoteToolsRpcServer, registerPlatformExecutors } from "@/lib/remote-tools";
import { acquireMqttModuleLeaseGroup, type MqttModuleLeaseGroup } from "@/lib/mqtt/mqtt-module-wiring";
import { decodeLiveEvent, sessionIdFromLiveEvent} from "@/lib/daemon/teamclu-events";
import { handleSessionEventPermissionResolved } from "@/lib/teamclu/handle-session-event-permission-resolved";
import { scheduleMarkActiveSessionRead } from "@/lib/session/active-session-read";
import {
  ensureInboxSubscribed,
  handleInboxEnvelope,
  resetInboxSubscriptionState,
  scheduleSessionListRefresh,
} from "@/lib/messages/inbox-handler";
import { bumpSessionListLastMessage, messageKindUpdatesSessionPreview } from "@/lib/session/session-list-preview";
import { executeAgentTurnFlush } from "@/lib/agent/agent-turn-flush";
import { unixTimestampSecondsToIso } from "@/lib/messages/message-timestamp";
import { resolveInterruptedPlaceholdersToDrop } from "@/lib/messages/interrupted-stream-placeholder";
import { resolvePendingAgentReplyTo } from "@/lib/messages/pending-agent-reply-to";
import { flushStreamDeltasFor} from "@/lib/stream/stream-delta-buffer";
import { bumpLiveDuplicateDropped } from "@/lib/diagnostics/live-dedup-stats";
import { cloneStreamEntrySnapshot, resolveStreamEntryForPersist} from "@/lib/stream/streaming-persist";
import { logInterruptMsgDiag, summarizeFlushDecision, summarizePendingReplies, summarizeStreamEntry } from "@/lib/diagnostics/interrupt-msg-diag";
import { logExtMsgDiag} from "@/lib/diagnostics/extension-msg-diag";
import { useAcpDebugStore } from "@/stores/acp-debug-store";
import { isStreamInterruptible, useV2StreamingStore } from "@/stores/v2-streaming-store";
import { acquireRuntimeStateStore, useRuntimeStateStore } from "@/stores/runtime-state-store";
import { findStaleLiveStreams, STALE_STREAM_SWEEP_MS } from "@/lib/stream/stale-stream-recovery";
import { acquireActorPresenceStore } from "@/stores/actor-presence-store";
import { type Message as TeamcluMessage } from "@/lib/proto/teamclu_pb";
import { agentStreamKey, mergePendingAgentReplies, registerDiscardPendingStreamReply, rememberLiveEventId} from "@/lib/stream/live-agent-stream";
import { softDeleteMessage} from "@/lib/cache/local-cache";
import { syncActorsForTeam } from "@/lib/sync/actor-sync";
import { syncIdeasForTeam } from "@/lib/sync/idea-sync";
import { syncSessionsForTeam } from "@/lib/sync/session-sync";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionLiveInterestStore } from "@/stores/session-live-interest-store";
import { resolveCurrentMemberActorId } from "@/lib/actor/current-actor";
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
} from "@/lib/session/session-live-subscriptions";

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

    // What the extracted live-envelope handlers need. Built here rather than in
    // the component body so it captures exactly what the old inline branches
    // captured: the versions current when the effect ran, not a fresh object on
    // every render (which would also drag the whole effect into its dep array).
    const liveWiringCtx: LiveWiringContext = {
      pendingStreamRepliesRef,
      terminalFlushPendingRef,
      followUpActiveRef,
      clearTerminalFlushPending,
      clearFollowUpActive,
      flushTurnAgentReply,
      scheduleTerminalDaemonReplyTimeout,
      removeInterruptedStreamPlaceholderForRealReply,
    };
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
            handleLiveMessage(liveWiringCtx, decoded, sid);
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
            handleAcpEvent(liveWiringCtx, decoded, sid, t);
            return;
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
