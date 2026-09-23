export type BootstrapTeam = {
  id: string;
  name: string;
  slug: string;
  role: string;
  orgName: string | null;
  /** Present on `scope=all` listings; narrows a login-time choice to one org. */
  orgId?: string | null;
};

export type BootstrapDecision =
  /** No teams at all — the user has to make one. */
  | { kind: "createTeam" }
  /** Exactly one candidate, or a remembered choice that still exists. */
  | { kind: "adopt"; teamId: string }
  /** More than one and nothing remembered — the user picks. */
  | { kind: "selectTeam"; teams: BootstrapTeam[] };

/**
 * Which team the app opens into, ported from iOS
 * `AppOnboardingCoordinator.resolveRoute`.
 *
 * Expo used to take `items.find(t => t.isMember !== false)` — whichever team
 * the listing happened to return first — and activate it. A user on several
 * teams landed in one of them with nothing saying a choice had been made for
 * them, and if that team sat in an org this session is not active in, RLS
 * filtered the app down to empty.
 *
 * Order matters and mirrors iOS:
 *
 *  1. A remembered choice wins, but only while it is still a team the user is
 *     on. Stale ids are ignored rather than activated — losing access to a team
 *     should not strand the app on a picker-less dead end.
 *  2. More than one team and nothing remembered: ask.
 *  3. Exactly one: adopt it silently. There is no choice to make.
 *  4. None: create one.
 */
export function resolveBootstrapDecision(args: {
  teams: ReadonlyArray<BootstrapTeam>;
  rememberedTeamId?: string | null;
  /**
   * `homeOrgId` from `GET /v1/teams?scope=all` (#1585): the org of the
   * identity that signed in. One phone number can resolve membership across
   * several accounts, so without narrowing, choosing an account on the phone
   * account picker changed nothing about which teams were offered.
   */
  homeOrgId?: string | null;
}): BootstrapDecision {
  const allTeams = args.teams;
  if (allTeams.length === 0) return { kind: "createTeam" };

  // The remembered team is deliberately NOT narrowed: sign-out clears it, so
  // one that survives is a relaunch after a cross-org switch the user made.
  const remembered = args.rememberedTeamId?.trim();
  if (remembered && allTeams.some((team) => team.id === remembered)) {
    return { kind: "adopt", teamId: remembered };
  }

  const teams = scopeToHomeOrg(allTeams, args.homeOrgId);

  if (teams.length > 1) return { kind: "selectTeam", teams: [...teams] };

  return { kind: "adopt", teamId: teams[0].id };
}

/**
 * iOS `AppOnboardingCoordinator.scoped`: keep the teams in the home org, or
 * every team when the home org is unknown or holds none of them.
 */
export function scopeToHomeOrg<T extends { orgId?: string | null }>(
  items: ReadonlyArray<T>,
  homeOrgId: string | null | undefined,
): T[] {
  const org = homeOrgId?.trim();
  if (!org) return [...items];
  const inOrg = items.filter((item) => item.orgId === org);
  return inOrg.length > 0 ? inOrg : [...items];
}

/** Where a finished bootstrap lands. */
export type BootstrapLanding = "ready" | "selectTeam" | "createTeam" | "noTeam";

/**
 * The route for a finished bootstrap, given the onboarding intent.
 *
 * No team and the user said they are joining an existing one: creating a team
 * would drop them into an empty one that looks like the right place, so they
 * land on the no-team screen instead (iOS #1589). `create` — and no recorded
 * intent at all, for installs from before the choice screen — keep today's
 * create path.
 */
export function resolveBootstrapLanding(args: {
  hasTeam: boolean;
  teamChoiceCount: number;
  intent: "join" | "create" | null | undefined;
}): BootstrapLanding {
  if (args.hasTeam) return "ready";
  if (args.teamChoiceCount > 0) return "selectTeam";
  return args.intent === "join" ? "noTeam" : "createTeam";
}
