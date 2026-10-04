import { resolvePathPolicy, type AuthRule, type AuthScope, type AuthAudience } from "./apps-auth-paths.js";
import { ApiError } from "./http-utils.js";

export interface EffectiveAuthPolicy {
  path: string;
  kind: "public" | "any_authenticated" | "any_org_role" | "org_roles";
  roleCodes: string[] | null;
  inherited: boolean;
  source: "auth_mode" | "roles" | "rule_audience" | "app_audience" | "scope_baseline";
}

export interface AppAuthInfo {
  appId: string;
  teamId: string;
  organization: { id: string; name: string } | null;
  roleScope: "organization";
  roles: Array<{ id: string; code: string; name: string; status: string }>;
  authMode: "none" | "platform" | "third";
  authScope: AuthScope;
  authAudience: AuthAudience;
  authRules: AuthRule[];
  effectivePolicies: EffectiveAuthPolicy[];
  organizationStatus: "configured" | "unconfigured";
}

export type AppAuthInfoInput = Pick<
  AppAuthInfo,
  "appId" | "teamId" | "organization" | "roles" | "authMode" | "authScope" | "authAudience" | "authRules"
>;

/** Explain the gateway's existing path resolution without rewriting raw rules. */
export function buildAppAuthInfo(input: AppAuthInfoInput): AppAuthInfo {
  if (!Array.isArray(input.authRules) || resolvePathPolicy("/", input.authScope, input.authRules).unreadable) {
    throw new ApiError(503, "app_auth_unavailable", "application auth rules are unreadable");
  }
  const root = input.authRules.find((rule) => rule.path === "/");
  const explain = (path: string, rule?: AuthRule): EffectiveAuthPolicy => {
    const inherited = !rule || (
      rule.auth === "required" && rule.roles === undefined && rule.audience === undefined
    );
    if (input.authMode !== "platform") {
      return { path, kind: "public", roleCodes: [], inherited, source: "auth_mode" };
    }
    const policy = resolvePathPolicy(path, input.authScope, input.authRules);
    if (policy.unreadable) {
      throw new ApiError(503, "app_auth_unavailable", "application auth rules are unreadable");
    }
    if (!policy.requiresLogin) {
      return { path, kind: "public", roleCodes: [], inherited: !rule, source: "scope_baseline" };
    }
    if (policy.roles !== null) {
      return {
        path,
        kind: policy.roles.length ? "org_roles" : "any_authenticated",
        roleCodes: policy.roles,
        inherited: false,
        source: "roles",
      };
    }
    const audience = policy.audience ?? input.authAudience;
    return {
      path,
      kind: audience === "any" ? "any_authenticated" : "any_org_role",
      roleCodes: audience === "any" ? [] : null,
      inherited,
      source: policy.audience === null ? "app_audience" : "rule_audience",
    };
  };
  return {
    ...input,
    roleScope: "organization",
    organizationStatus: input.organization ? "configured" : "unconfigured",
    effectivePolicies: [
      explain("/", root),
      ...input.authRules.filter((rule) => rule.path !== "/").map((rule) => explain(rule.path, rule)),
    ],
  };
}
