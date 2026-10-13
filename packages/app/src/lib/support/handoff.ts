import { resolveCurrentMemberActorId } from "@/lib/actor/current-actor";
import { getBackend } from "@/lib/backend";
import { getKnownLocalDaemonActorId } from "@/lib/daemon/local-daemon-identity";
import {
  createSessionWithFirstMessage,
  resolveLocalDaemonWorkspaceBinding,
  startAgentRuntimesAsync,
} from "@/lib/session/session-create";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionSelectionStore } from "@/stores/session-selection-store";

export const SUPPORT_CONCLUSION_MAX = 4000;

export class SupportAgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportAgentUnavailable";
  }
}

export function truncateConclusion(text: string): string {
  const chars = Array.from(text.trim());
  if (chars.length <= SUPPORT_CONCLUSION_MAX) return chars.join("");
  return chars.slice(0, SUPPORT_CONCLUSION_MAX).join("");
}

export function supportAnalysisPrompt(bundle: unknown): string {
  return [
    "请根据下面的诊断包，用可以直接发给用户的话回答三件事：",
    "1. 卡在哪一步",
    "2. 证据在哪",
    "3. 用户下一步做什么",
    "",
    JSON.stringify(bundle, null, 2),
  ].join("\n");
}

export function latestAgentReply(
  rows: Array<{ sender_actor_id: string | null; content: string; created_at?: string | null }>,
  agentActorId: string,
): string | null {
  const matches = rows.filter(
    (row) => row.sender_actor_id === agentActorId && row.content.trim().length > 0,
  );
  if (matches.length === 0) return null;
  const newest = [...matches].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  )[matches.length - 1];
  return newest.content.trim();
}

export async function openSupportAgentSession(
  bundle: unknown,
): Promise<{ sessionId: string; agentActorId: string }> {
  const teamId = useCurrentTeamStore.getState().team?.id?.trim() ?? "";
  const userId = useAuthStore.getState().session?.user?.id?.trim() ?? "";
  if (!teamId || !userId) {
    throw new SupportAgentUnavailable("当前没有登录的团队");
  }
  const creatorActorId = await resolveCurrentMemberActorId(teamId, userId, {
    currentTeamId: teamId,
    currentMemberId: useCurrentTeamStore.getState().currentMember?.id ?? null,
  });
  if (!creatorActorId) {
    throw new SupportAgentUnavailable("找不到当前成员");
  }

  let agentActorId: string | null = null;
  try {
    const { getLocalDaemonActorId } = await import("@/lib/daemon/daemon-agent-admin");
    agentActorId = (await getLocalDaemonActorId())?.trim() || null;
  } catch {
    agentActorId = null;
  }
  if (!agentActorId) agentActorId = getKnownLocalDaemonActorId();
  if (!agentActorId) {
    throw new SupportAgentUnavailable("本机 agent 没有就绪");
  }

  const localWorkspace = await resolveLocalDaemonWorkspaceBinding(teamId, [agentActorId]);
  const { sessionId } = await createSessionWithFirstMessage({
    teamId,
    creatorActorId,
    additionalActorIds: [agentActorId],
    agentActorIds: [agentActorId],
    messageText: supportAnalysisPrompt(bundle),
    title: "支持诊断",
    mentionActorIds: [agentActorId],
    localWorkspace,
  });
  const started = await startAgentRuntimesAsync({
    sessionId,
    teamId,
    agentActorIds: [agentActorId],
    workspaceIdHint: localWorkspace?.workspaceId ?? null,
    suppressWorkspaceToast: true,
  });
  if (started.failures.length > 0 && Object.keys(started.runtimeIdsByAgent).length === 0) {
    throw new SupportAgentUnavailable(started.failures[0]?.reason || "本机 agent 没有启动");
  }
  await useSessionSelectionStore.getState().setActiveSession(sessionId);
  return { sessionId, agentActorId };
}

export async function pollStableAgentReply(
  sessionId: string,
  agentActorId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + 3 * 60 * 1000;
  let previous: string | null = null;
  while (!signal.aborted && Date.now() < deadline) {
    const page = await getBackend()
      .messages.listMessages(sessionId, { limit: 30 })
      .catch(() => null);
    const current = page ? latestAgentReply(page.rows, agentActorId) : null;
    if (current && current === previous) return current;
    previous = current;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  return null;
}
