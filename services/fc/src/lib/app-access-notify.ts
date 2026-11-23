/**
 * Tell a human that their access to an app changed.
 *
 * The desktop loads a team's app list once and keeps it, so a grant written by
 * someone else stayed invisible to the grantee until they restarted the app,
 * and a revoked app stayed in their list the same way. This is the same kind of
 * hint as `session-participant-notify.ts`: a reason to re-read the app list,
 * not a notification. No APNs, no message row, and agents are not recipients —
 * a daemon has no app list on screen.
 */

export interface AppAccessGrantee {
  actor_type?: string | null;
  user_id?: string | null;
}

/** The login to tell, or null for an agent or an actor with no account. */
export function appAccessRecipientUserId(
  actor: AppAccessGrantee | null | undefined,
): string | null {
  if (!actor || actor.actor_type !== "member") return null;
  const userId = actor.user_id;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

export async function publishAppAccessChanged(input: {
  teamId: string;
  appId: string;
  userId: string;
  publish: (topic: string, body: string) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const body = JSON.stringify({
    v: 2,
    type: "app.access",
    team_id: input.teamId,
    app_id: input.appId,
    ts: (input.now ?? Date.now)(),
  });
  await input.publish(`inbox/${input.userId}`, body);
}
