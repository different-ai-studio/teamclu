// Per-deployment feature flags handed to clients at runtime.
//
// These live in the repo, not in an env var, because they must survive a
// deploy. On Alibaba FC `s deploy` REWRITES the function's whole environment
// map, so a var missing from the deploying machine's env file is not "keep the
// current value" — it is "wipe it". That is how belayo shipped a bootstrap with
// no broker twice (see the MQTT_BROKER_URL guard in deploy-aliyun-fc.sh). A
// login method that vanishes on the next unrelated deploy is the same failure
// with a worse blast radius, so the durable copy is here, in git, reviewable.
//
// They are a TypeScript module rather than JSON files on purpose: the container
// image only copies `dist/` (services/fc/Dockerfile), while the FC package ships
// the whole directory (`code: ./` in s.yaml). A data file would therefore work
// on one target and silently vanish on the other — the worst shape of bug,
// since a missing profile is indistinguishable from an empty one at the client.
// Compiled into dist/, both targets get it for free.
//
// `APP_FEATURES_JSON` still overrides these at runtime for emergencies. On
// belayo that override is lost at the next deploy; on self-host it lives in the
// box's .env and persists. Neither is the place for a durable decision.

export interface AuthFeatureFlags {
  google?: boolean;
  wechat?: boolean;
  phone?: boolean;
  password?: boolean;
  /**
   * ANDed with the client's build flag, never simply overriding it: the allowed
   * admin-console hosts are compiled into the desktop binary, so turning this on
   * server-side cannot on its own make it work — and must not be able to.
   */
  webSSO?: boolean;
}

export interface ChannelFeatureFlags {
  discord?: boolean;
  feishu?: boolean;
  email?: boolean;
  kook?: boolean;
  wecom?: boolean;
  wechat?: boolean;
  seatalk?: boolean;
}

export interface FeatureFlags {
  auth?: AuthFeatureFlags;
  channels?: ChannelFeatureFlags;
  /**
   * Nav entry only (`NavRail`, sidebar apps column). Off hides the UI surface
   * for creating or browsing apps; existing app sessions, workspaces, and
   * already-deployed sites keep working — this is not a data or runtime kill
   * switch.
   */
  apps?: boolean;
  /**
   * Locks a build out of changing or leaving the team LLM config. Kept at
   * DEPLOYMENT scope, matching what it already meant as a build-config flag
   * (`team.lockLlmConfig`, i.e. per brand). Making it per-team is a product
   * change and a schema change, not a config move — see the follow-up note
   * in docs/plans/2026-08-05-remote-feature-flags.md.
   */
  lockLlmConfig?: boolean;
  /**
   * Self-registration switch. It gates exactly one action — MINTING A NEW ORG
   * for a caller who does not belong to one yet (`ensure_personal_org`). Someone
   * who already has an org is always let through, because they were provisioned
   * by somebody: an invite, or an org they were already a member of. Gating
   * "create a team" instead would deadlock a fresh org whose first member cannot
   * create its default team, and nobody could ever get in.
   *
   * Off means: sign-in still succeeds (GOTRUE_DISABLE_SIGNUP must stay false or
   * invitees could not create an account at all), the bootstrap returns 403
   * `registration_disabled`, and the client shows the waiting-for-invite screen.
   *
   * Enforced in FC only. FC forwards the caller's bearer token, so these RPCs
   * run as `authenticated` and the grant cannot be narrowed to service_role;
   * the Supabase gateway is publicly reachable, so a hand-rolled
   * `POST /rest/v1/rpc/ensure_personal_org` bypasses this. Known and accepted:
   * it is a product-shape switch, not a security boundary. Do not "fix" it with
   * an SQL-side guard — see docs/plans/2026-08-17-login-org-team-redesign.md.
   *
   * Unset means allowed, which is what every deployment does today.
   */
  allowNewOrg?: boolean;
}

/**
 * The ONLY place a feature flag is defined. The build configs used to carry a
 * `features` block as well and every flag had to be written twice; they no
 * longer do, so a profile here is the complete answer rather than an override
 * on top of whatever the client baked. A flag omitted from a profile resolves
 * to OFF at the client — it is not inherited from the build any more.
 *
 * Selected by `APP_FEATURES_PROFILE`. One profile per RUNNING Cloud API, not
 * per brand — though today each deployment happens to serve one brand:
 *
 *   self-host   api.teamclu-dev.ucar.cc     official TeamClu
 *                                            (build.config.production.json)
 *   belayo      teamclu-api.ucar.cc         betly
 *                                            (branding repo brands/betly)
 *   copilot361  copilot.accounting.i.test.shopee.io
 *                                            (branding repo brands/copilot361)
 *
 * Only docker-compose.yml defaults the name (`self-host` — that box is exactly
 * one environment). s.yaml deliberately has NO default, because it deploys both
 * belayo and copilot361 and a default would be the wrong brand's flags for one
 * of them. Unset means "no overrides", which is always safe.
 *
 * Each profile below RESTATES what that brand's build config already bakes, so
 * turning this on changes nothing: the server tells every client exactly what
 * it already believed. From here a flag is changed by editing this file — the
 * client no longer has to be repackaged.
 *
 * Keep them in sync when a brand's build config changes. They are defaults on
 * one side and overrides on the other; drift shows up as a flag that flips the
 * moment the network answers, which is confusing to debug and trivial to avoid.
 *
 * One thing you still cannot express here, by design: `updater`. It gates the
 * startup auto-check itself, so a remote mistake would strand every installed
 * client with no way to update out of it.
 *
 * Everything else, `auth.webSSO` included, is settable here. Where Web SSO may
 * point is server-side too — the WEBSSO_LOGIN_URL env, delivered by
 * /v1/config/{public,bootstrap}. The desktop binary no longer carries a second
 * host allowlist to keep in step with it.
 */
export const FEATURE_PROFILES: Record<string, FeatureFlags> = {
  // Mirrors build.config.production.json (in this repo).
  "self-host": {
    auth: { google: true, wechat: false, phone: false, password: false, webSSO: false },
    channels: { discord: true, feishu: true, email: true, kook: true, wecom: true, wechat: true, seatalk: true },
    // Entry point only. Creating an app needs GITEA_* (see makeGiteaDeps in
    // src/index.ts); deploy needs ACCESS_KEY_ID + APPS_FC_ENDPOINT (see
    // makeDeployDeps). With those unset this box answers 503 naming the empty
    // variable while listing still works.
    apps: true,
    lockLlmConfig: false,
    allowNewOrg: true,
  },

  // Mirrors the branding repo's brands/betly/build.config.json. `webSSO: true`
  // is now the whole story — the host comes from WEBSSO_LOGIN_URL on that
  // deployment, not from anything baked into the build.
  belayo: {
    auth: { google: false, wechat: false, phone: true, password: false, webSSO: true },
    channels: { discord: true, feishu: true, email: true, kook: true, wecom: true, wechat: true, seatalk: true },
    apps: false,
    lockLlmConfig: false,
    allowNewOrg: true,
  },

  // Mirrors the branding repo's brands/copilot361/build.config.json, which
  // carries no `auth` block at all — every alternative sign-in method is off and
  // only email OTP remains. Restated explicitly here so it is a decision on the
  // record rather than an omission.
  copilot361: {
    auth: { google: false, wechat: false, phone: false, password: false, webSSO: false },
    channels: { discord: true, feishu: true, email: true, kook: true, wecom: true, wechat: true, seatalk: true },
    apps: false,
    lockLlmConfig: false,
    allowNewOrg: true,
  },
};
