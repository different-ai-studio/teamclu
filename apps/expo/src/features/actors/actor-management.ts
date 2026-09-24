export function canRemoveActor({
  actorId,
  currentMemberActorId,
  currentTeamRole,
  agentAccessRole = null,
}: {
  actorId: string | null | undefined;
  currentMemberActorId: string | null | undefined;
  currentTeamRole: string | null | undefined;
  /**
   * The member's role on this agent, when the actor is an agent. The server
   * lets whoever manages an agent remove it (personal agents need their
   * owning member), so a plain team member could delete their own agent
   * through the API but the app hid the button. iOS shows it and lets the
   * server decide.
   */
  agentAccessRole?: string | null;
}): boolean {
  if (!actorId || !currentMemberActorId) return false;
  if (actorId === currentMemberActorId) return false;
  if (currentTeamRole === "owner" || currentTeamRole === "admin") return true;
  return agentAccessRole === "owner" || agentAccessRole === "admin";
}

export function canManageAuthorizedHumans({
  actorType,
  isOwner,
}: {
  actorType: string | null | undefined;
  isOwner: boolean | null | undefined;
}): boolean {
  // Owner-gating is resolved server-side (GET /v1/agents/:id/permission) and
  // surfaced as `isOwner`; the directory no longer carries owner_member_id.
  return actorType === "agent" && Boolean(isOwner);
}
