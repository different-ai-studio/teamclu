// Deployment wiring for enterprise sign-in. One service per FC process, so the
// WeCom suite_access_token cache outlives a request.
//
// WeCom (service provider / 第三方应用). Unset WECOM_SUITE_ID = WeCom sign-in
// off: the routes answer 501, and the client hides the button anyway unless
// the deployment's `auth.wecom` feature flag is on.
//
//   WECOM_SUITE_ID / WECOM_SUITE_SECRET   TeamClu's third-party app (install = bind)
//   WECOM_LOGIN_SUITE_ID / _SECRET        the provider's 登录授权 suite, if it is
//                                         not the same app (optional)
//   WECOM_CALLBACK_TOKEN / _AES_KEY       指令回调 Token + EncodingAESKey
//   WECOM_LOGIN_CALLBACK_TOKEN / _AES_KEY 登录授权 page's own pair, if it differs
//                                         from the app's (optional)
//   WECOM_PROVIDER_CORPID                 provider CorpID (optional; accepted as
//                                         a callback receiveId; required for
//                                         member names)
//   WECOM_CUSTOMIZED_SUITE_ID / _SECRET   代开发 template that reads member names
//   WECOM_PROVIDER_SECRET                 provider secret (get_customized_auth_url)
//                                         — names are on only with all three
//   WECOM_REDIRECT_BASE_URL               public origin registered as the trusted
//                                         domain (optional; else the request's)
//   WECOM_INSTALL_TEST_MODE               "1" while the app is unpublished
//   SSO_ALLOWED_REDIRECT_SCHEMES          extra client schemes, comma-separated
import { createClient as defaultCreateClient } from "@supabase/supabase-js";

import { ApiError } from "../http-utils.js";
import { createSsoService, type SsoService, type WecomSsoConfig } from "./sso-service.js";
import { createSupabaseSsoStore } from "./supabase-store.js";
import { createWecomClient } from "./wecom-client.js";

type Env = Record<string, string | undefined>;

export function readWecomSsoConfig(env: Env): WecomSsoConfig | null {
  const suiteId = env.WECOM_SUITE_ID?.trim();
  const suiteSecret = env.WECOM_SUITE_SECRET?.trim();
  const token = env.WECOM_CALLBACK_TOKEN?.trim();
  const encodingAesKey = env.WECOM_CALLBACK_AES_KEY?.trim();
  if (!suiteId) return null;
  if (!suiteSecret || !token || !encodingAesKey) {
    // Half-configured is a deploy mistake; say so instead of silently
    // switching the feature off.
    console.error("sso: WECOM_SUITE_ID is set but WECOM_SUITE_SECRET / WECOM_CALLBACK_TOKEN / WECOM_CALLBACK_AES_KEY are not; WeCom sign-in disabled");
    return null;
  }
  const loginSuiteId = env.WECOM_LOGIN_SUITE_ID?.trim();
  const loginSuiteSecret = env.WECOM_LOGIN_SUITE_SECRET?.trim();
  const customizedSuiteId = env.WECOM_CUSTOMIZED_SUITE_ID?.trim();
  const customizedSuiteSecret = env.WECOM_CUSTOMIZED_SUITE_SECRET?.trim();
  const providerSecret = env.WECOM_PROVIDER_SECRET?.trim();
  const providerCorpId = env.WECOM_PROVIDER_CORPID?.trim() || undefined;
  if (customizedSuiteId && !(customizedSuiteSecret && providerSecret && providerCorpId)) {
    console.error("sso: WECOM_CUSTOMIZED_SUITE_ID is set but WECOM_CUSTOMIZED_SUITE_SECRET / WECOM_PROVIDER_SECRET / WECOM_PROVIDER_CORPID are not; WeCom member names disabled");
  }
  const loginCallbackToken = env.WECOM_LOGIN_CALLBACK_TOKEN?.trim();
  const loginCallbackAesKey = env.WECOM_LOGIN_CALLBACK_AES_KEY?.trim();
  return {
    suite: { suiteId, suiteSecret },
    loginSuite: loginSuiteId && loginSuiteSecret ? { suiteId: loginSuiteId, suiteSecret: loginSuiteSecret } : undefined,
    callback: { token, encodingAesKey },
    loginCallback: loginCallbackToken && loginCallbackAesKey
      ? { token: loginCallbackToken, encodingAesKey: loginCallbackAesKey }
      : undefined,
    providerCorpId,
    directory:
      customizedSuiteId && customizedSuiteSecret && providerSecret && providerCorpId
        ? { template: { suiteId: customizedSuiteId, suiteSecret: customizedSuiteSecret }, providerSecret }
        : undefined,
    redirectBaseUrl: env.WECOM_REDIRECT_BASE_URL?.trim() || undefined,
    installTestMode: env.WECOM_INSTALL_TEST_MODE === "1" || env.WECOM_INSTALL_TEST_MODE === "true",
  };
}

let cached: { key: string; service: SsoService | null } | null = null;

export function ssoServiceFromEnv(args: {
  env: Env;
  supabaseUrl: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
  createClient?: (url: string, key: string, opts?: any) => any;
}): SsoService | null {
  const { env, supabaseUrl, publishableKey } = args;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const wecomConfig = readWecomSsoConfig(env);
  const key = JSON.stringify([supabaseUrl, publishableKey, !!serviceRoleKey, wecomConfig]);
  if (cached?.key === key) return cached.service;

  let service: SsoService | null = null;
  if (wecomConfig && serviceRoleKey && supabaseUrl && publishableKey) {
    const fetchImpl = args.fetchImpl ?? globalThis.fetch;
    const store = createSupabaseSsoStore({
      supabaseUrl,
      publishableKey,
      serviceRoleKey,
      createClient: args.createClient ?? defaultCreateClient,
    });
    service = createSsoService({
      store,
      wecom: {
        config: wecomConfig,
        client: createWecomClient({ fetchImpl, loadSuiteTicket: (suiteId) => store.loadSuiteTicket("wecom", suiteId) }),
      },
      allowedRedirectSchemes: (env.SSO_ALLOWED_REDIRECT_SCHEMES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // The raw GoTrue session, the same shape /v1/auth/oauth/exchange returns.
      refreshSession: async (refreshToken) => {
        const res = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: publishableKey },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        const body: any = await res.json().catch(() => null);
        if (!res.ok || !body?.access_token) {
          throw new ApiError(502, "upstream_error", `session refresh failed: HTTP ${res.status}`);
        }
        return body;
      },
    });
  }
  cached = { key, service };
  return service;
}
