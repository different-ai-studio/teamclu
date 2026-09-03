import { getBackend } from "@/lib/backend";

interface CurrentActorHint {
  currentTeamId?: string | null;
  currentMemberId?: string | null;
}

export async function resolveCurrentMemberActorId(
  teamId: string,
  userId: string,
  hint: CurrentActorHint = {},
): Promise<string | null> {
  if (hint.currentTeamId === teamId && hint.currentMemberId) {
    return hint.currentMemberId;
  }

  const actor = await getBackend().directory.resolveCurrentMemberActor(teamId, userId);
  return actor?.id ?? null;
}
