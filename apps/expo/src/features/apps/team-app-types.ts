/**
 * Team apps (团队应用) as the Cloud API reports them (`GET /v1/apps`). Port of
 * iOS `AMUXCore/Apps/TeamAppRecord.swift`.
 *
 * Named `TeamApp…` rather than `App…` because "app" already means the client
 * itself throughout this codebase.
 *
 * Only the fields this client renders are carried. The server's `App` schema
 * is much wider (auth rules, custom domains, cron, env); those belong to
 * surfaces a phone does not have.
 *
 * Every label helper here returns an English i18n key, never display text —
 * screens pass it through `t()`.
 */

export type TeamAppType =
  | "static_web"
  | "slides"
  | "data_app"
  | "imported"
  /** Legacy, read-only: the server rejects it on write. */
  | "fullstack_tanstack_postgres";

export type TeamAppVisibility = "personal" | "team";

export type TeamAppProvisionStatus = "pending" | "repo_created" | "seeding" | "ready" | "error";

export type TeamAppFcStatus =
  | "not_deployed"
  | "awaiting_build"
  | "building"
  | "deploying"
  | "live"
  | "deploy_error";

/**
 * How the caller comes to see this app: they created it, they were granted
 * access, or it is visible to the whole team.
 */
export type TeamAppRelationship = "owner" | "invited" | "team";

/** The colour a status dot takes. */
export type TeamAppStatusKind = "live" | "working" | "failed" | "pending" | "idle";

export type TeamApp = {
  id: string;
  teamId: string;
  createdByActorId: string | null;
  name: string;
  slug: string;
  type: TeamAppType;
  visibility: TeamAppVisibility;
  provisionStatus: TeamAppProvisionStatus;
  /**
   * `null` means never deployed — distinct from `not_deployed`, which the
   * server sets once a deploy has been attempted and undone.
   */
  fcStatus: TeamAppFcStatus | null;
  /** Derived server-side from the slug and id; absent until the app is live. */
  publicUrl: string | null;
  fcEndpoint: string | null;
  gitRemoteUrl: string | null;
  gitAuthKind: string | null;
  relationship: TeamAppRelationship;
  /** ISO timestamp, or "" when the server sent none. */
  createdAt: string;
  updatedAt: string;
};

/** A session linked to an app (`GET /v1/apps/{appId}/sessions`). */
export type TeamAppSession = {
  id: string;
  teamId: string;
  title: string;
  mode: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TeamAppCreateInput = {
  name: string;
  type: TeamAppType;
  visibility: TeamAppVisibility;
};

/**
 * The types this client offers when creating. `imported` needs a git address
 * and a daemon to clone with; the legacy full-stack type cannot be written.
 */
export const CREATABLE_TEAM_APP_TYPES: readonly TeamAppType[] = [
  "static_web",
  "slides",
  "data_app",
];

export const TEAM_APP_VISIBILITIES: readonly TeamAppVisibility[] = ["personal", "team"];

export const TEAM_APP_RELATIONSHIPS: readonly TeamAppRelationship[] = ["owner", "invited", "team"];

export type TeamAppFilter = "all" | TeamAppRelationship;

export const TEAM_APP_FILTERS: readonly TeamAppFilter[] = ["all", ...TEAM_APP_RELATIONSHIPS];

// MARK: - Wire parsing

const TYPES: readonly TeamAppType[] = [
  "static_web",
  "slides",
  "data_app",
  "imported",
  "fullstack_tanstack_postgres",
];
const PROVISION: readonly TeamAppProvisionStatus[] = [
  "pending",
  "repo_created",
  "seeding",
  "ready",
  "error",
];
const FC: readonly TeamAppFcStatus[] = [
  "not_deployed",
  "awaiting_build",
  "building",
  "deploying",
  "live",
  "deploy_error",
];

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * An unrecognised type reads as `imported`: the one type that makes no claim
 * about what is inside, so a server that adds a type does not have this
 * client mislabelling it as a static site.
 */
export function parseTeamAppType(value: unknown): TeamAppType {
  return oneOf(TYPES, value) ?? "imported";
}

export function parseTeamAppVisibility(value: unknown): TeamAppVisibility {
  return oneOf(TEAM_APP_VISIBILITIES, value) ?? "personal";
}

/**
 * Unknown falls back to `pending`, the conservative side of
 * `needsDesktopSetup`: the UI offers the desktop hint rather than implying the
 * app is ready.
 */
export function parseTeamAppProvisionStatus(value: unknown): TeamAppProvisionStatus {
  return oneOf(PROVISION, value) ?? "pending";
}

/** `null` is meaningful (never deployed); an unknown string reads the same. */
export function parseTeamAppFcStatus(value: unknown): TeamAppFcStatus | null {
  return oneOf(FC, value);
}

export function parseTeamAppRelationship(value: unknown): TeamAppRelationship {
  return oneOf(TEAM_APP_RELATIONSHIPS, value) ?? "team";
}

// MARK: - Derived state

/** The address to open, preferring the public URL over the raw endpoint. */
export function teamAppOpenableUrl(app: Pick<TeamApp, "publicUrl" | "fcEndpoint">): string | null {
  const url = app.publicUrl?.trim() || app.fcEndpoint?.trim() || "";
  if (!url) return null;
  // Only http(s) is a link; anything else would be handed to the browser
  // unexamined.
  try {
    const scheme = new URL(url).protocol.toLowerCase();
    return scheme === "http:" || scheme === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * An app whose code has not been written yet. Creating one from a phone only
 * inserts the row; writing the starter template is the local daemon's job, so
 * such an app sits at `repo_created` until someone opens it on a desktop.
 */
export function teamAppNeedsDesktopSetup(app: Pick<TeamApp, "provisionStatus">): boolean {
  return app.provisionStatus !== "ready" && app.provisionStatus !== "error";
}

/**
 * The deploy lifecycle wins over provisioning, because once an app has been
 * deployed its live state is what the reader is asking about. Mirrors the
 * desktop's `packages/app/src/lib/apps/app-list-helpers.ts`.
 */
export function teamAppStatusKind(app: TeamApp): TeamAppStatusKind {
  switch (app.fcStatus) {
    case "live":
      if (teamAppOpenableUrl(app)) return "live";
      break;
    case "deploy_error":
      return "failed";
    case "awaiting_build":
    case "building":
    case "deploying":
      return "working";
    default:
      break;
  }
  switch (app.provisionStatus) {
    case "ready":
      return "idle";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/** One line of status, as an i18n key. Same precedence as `teamAppStatusKind`. */
export function teamAppStatusLabelKey(app: TeamApp): string {
  switch (app.fcStatus) {
    case "live":
      if (teamAppOpenableUrl(app)) return "Deployed";
      break;
    case "deploy_error":
      return "Deploy failed";
    case "awaiting_build":
    case "building":
    case "deploying":
      return "Deploying…";
    default:
      break;
  }
  switch (app.provisionStatus) {
    case "ready":
      return "Not deployed";
    case "error":
      return "Setup failed";
    default:
      return "Not initialized";
  }
}

/** Where the code lives, in the reader's terms rather than the column's. */
export function teamAppSourceLabelKey(app: Pick<TeamApp, "gitAuthKind" | "gitRemoteUrl">): string {
  if (app.gitAuthKind === "gitea_deploy_key") return "Managed repo";
  if (app.gitRemoteUrl && app.gitRemoteUrl.trim().length > 0) return "External repo";
  return "This computer only";
}

export function teamAppTypeLabelKey(type: TeamAppType): string {
  switch (type) {
    case "static_web":
      return "Static web page";
    case "slides":
      return "Slides";
    case "data_app":
      return "Data app";
    case "imported":
      return "Imported repo";
    case "fullstack_tanstack_postgres":
      return "Full-stack app";
  }
}

export function teamAppVisibilityLabelKey(visibility: TeamAppVisibility): string {
  return visibility === "team" ? "Whole team" : "Only me and people I invite";
}

export function teamAppRelationshipLabelKey(relationship: TeamAppRelationship): string {
  switch (relationship) {
    case "owner":
      return "Created by me";
    case "invited":
      return "Shared with me";
    case "team":
      return "Team's";
  }
}

export function teamAppFilterLabelKey(filter: TeamAppFilter): string {
  return filter === "all" ? "All" : teamAppRelationshipLabelKey(filter);
}

/** Ionicons glyph per type, so list and detail agree. */
export function teamAppTypeIcon(type: TeamAppType): string {
  switch (type) {
    case "static_web":
      return "globe-outline";
    case "slides":
      return "albums-outline";
    case "data_app":
      return "bar-chart-outline";
    case "imported":
      return "download-outline";
    case "fullstack_tanstack_postgres":
      return "layers-outline";
  }
}

/**
 * How the shared `StatusDot` atom renders a status. Only a live app breathes —
 * it is the one thing currently happening; `working` is basalt and still, as
 * on iOS `TeamAppStatusDot`.
 */
export function teamAppStatusDot(kind: TeamAppStatusKind): {
  kind: "active" | "idle" | "error";
  /** Paint basalt instead of the kind's colour (the view maps it to a token). */
  basalt: boolean;
  breathing: boolean;
} {
  switch (kind) {
    case "live":
      return { kind: "active", basalt: false, breathing: true };
    case "failed":
      return { kind: "error", basalt: false, breathing: false };
    case "working":
      return { kind: "idle", basalt: true, breathing: false };
    case "pending":
    case "idle":
      return { kind: "idle", basalt: false, breathing: false };
  }
}

/** Apps reachable by the given relationship, keeping the server's order. */
export function filterTeamApps(apps: readonly TeamApp[], filter: TeamAppFilter): TeamApp[] {
  if (filter === "all") return [...apps];
  return apps.filter((app) => app.relationship === filter);
}

/** The label a linked session shows; blank titles get an i18n placeholder key. */
export function teamAppSessionTitle(session: Pick<TeamAppSession, "title">): {
  text: string;
  isPlaceholder: boolean;
} {
  const title = session.title.trim();
  return title ? { text: title, isPlaceholder: false } : { text: "Untitled session", isPlaceholder: true };
}
