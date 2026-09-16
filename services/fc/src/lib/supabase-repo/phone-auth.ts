// Phone-number sign-in / sign-up, aligned with the partner SaaS's model
// (`apps/api/src/routes/app/auth/phone.ts` there) and re-implemented here
// against the SHARED `supabase_db` so a teamclu phone login lands on the SAME
// user the partner would resolve (no duplicate accounts).
//
// Identity model (mirrors the partner SaaS, NOT GoTrue native phone OTP):
//   - the auth user is an EMAIL user with synthetic email
//     `<phone>@<phoneEmailDomain>`; `auth.users.phone` stays empty.
//   - the phone↔user mapping lives in `public.users.mobile`, scoped by `org_id`.
//   - LOGIN resolves by mobile alone; the org comes from the row that matches.
//   - a brand-new sign-up still lands in DEFAULT_ORG (`defaultOrgId`) — giving
//     it its own org belongs with the team-name onboarding step.
//   - verification codes live in the shared `public.auth_verify_code` table.
//   - sessions are minted via admin magiclink (`generateSessionByEmail`).
//
// `phoneEmailDomain` is deployment config, not a constant: it is half of the
// account identity, so a deployment sharing users with the partner SaaS MUST
// set it to the same domain the partner uses. It is required rather than
// defaulted — a wrong default would silently mint a parallel set of accounts
// for every phone number instead of failing loudly.
//
// Differences from the partner SaaS that are intentional (see
// docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md):
//   - NO `processAfterUserCreated` side-effects (no self-participant / tags);
//     teamclu only writes the `public.users` row.
//
// All external effects (Supabase clients, SMS, captcha, clock, code generator)
// are injected so the flow is unit-testable without live infra.
import crypto from "crypto";

import { ApiError } from "../http-utils.js";
import { REALTIME_TRANSPORT_OPTS } from "./shared.js";

const PHONE_RE = /^1[3-9]\d{9}$/;

/**
 * Normalize a phone number to the partner's canonical bare 11-digit Chinese
 * mobile. Clients (desktop, iOS) send E.164 like `+8613700000000`; the partner
 * stores and resolves users by the bare `13700000000`, so we strip a leading `+86` / `86`
 * / `0086` country code (and any spaces/dashes) before validating or matching.
 * Returns the cleaned string unchanged when it doesn't look like a CN number, so
 * PHONE_RE still rejects genuinely invalid input.
 */
export function normalizePhone(raw: string): string {
  const cleaned = (raw ?? "").trim().replace(/[\s-]/g, "");
  const m = cleaned.match(/^(?:\+?86|0086)?(1[3-9]\d{9})$/);
  return m ? m[1] : cleaned;
}
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_WINDOW_MS = 60 * 1000; // 60 seconds

export interface PhoneAuthOptions {
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  /** Default tenant org; new phone users join this org. */
  defaultOrgId: string;
  /**
   * Domain of the synthetic auth email (`<phone>@<domain>`). Deployment config:
   * it is half the account identity, so it must match the partner SaaS sharing
   * this GoTrue. No default — see the identity-model note at the top.
   */
  phoneEmailDomain: string;
  /** Salt for the deterministic per-phone password (never re-verified; the partner uses generateSessionByEmail). */
  encryptionKey: string;
  /** Send an SMS verification code. Throwing aborts send-code (the code row is rolled back). */
  sendSms: (args: { phone: string; code: string; orgId: string }) => Promise<void>;
  /** Verify the client captcha token. Mirrors the partner: currently a pass-through stub. */
  verifyCaptcha?: (token: string) => Promise<{ verifyResult: boolean; message?: string }>;
  /** When true, skip real SMS and return the code in the response (dev only). */
  smsDebugMode?: boolean;
  createClient: (url: string, key: string, opts?: any) => any;
  /** Injectable clock (ms) for tests. */
  nowMs?: () => number;
  /** Injectable 6-digit code generator for tests. */
  genCode?: () => string;
}

function defaultGenCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

function deterministicPassword(phone: string, encryptionKey: string): string {
  return crypto
    .createHash("sha256")
    .update(phone.toLowerCase() + encryptionKey)
    .digest("hex")
    .slice(0, 32);
}

export function createPhoneAuthRepository(options: PhoneAuthOptions) {
  const {
    supabaseUrl,
    publishableKey,
    serviceRoleKey,
    defaultOrgId,
    phoneEmailDomain,
    encryptionKey,
    sendSms,
    verifyCaptcha,
    smsDebugMode = false,
    createClient,
    nowMs = () => Date.now(),
    genCode = defaultGenCode,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for phone auth");
  if (!defaultOrgId) throw new Error("DEFAULT_ORG_ID is required for phone auth");
  if (!phoneEmailDomain) throw new Error("PHONE_EMAIL_DOMAIN is required for phone auth");
  if (!encryptionKey) throw new Error("PHONE_AUTH_ENCRYPTION_KEY is required for phone auth");

  // Service-role admin client. `public` schema (users / auth_verify_code / orgs).
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" }, realtime: REALTIME_TRANSPORT_OPTS,
  });
  // Anon client used only to redeem the admin-minted magiclink into a session.
  const anon = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" }, realtime: REALTIME_TRANSPORT_OPTS,
  });

  function syntheticEmail(phone: string): string {
    return `${phone}@${phoneEmailDomain}`;
  }

  // admin magiclink → anon verifyOtp(token_hash) → session (the partner's
  // generateSessionByEmail, ported).
  async function generateSessionByEmail(email: string) {
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !link?.properties?.hashed_token) {
      throw new ApiError(500, "internal", `generateLink failed: ${linkErr?.message ?? "no hashed_token"}`);
    }
    const { data, error } = await anon.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    });
    if (error || !data?.session) {
      throw new ApiError(500, "internal", `verifyOtp(magiclink) failed: ${error?.message ?? "no session"}`);
    }
    return data.session;
  }

  function sessionPayload(session: any) {
    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      // Include the GoTrue auth user so clients that map session.user (desktop
      // mapSession) don't treat the session as signed-out.
      user: session.user ?? null,
    };
  }

  return {
    /**
     * POST /v1/auth/phone/send-code
     * captcha → 60s rate-limit → generate code → persist → SMS.
     */
    async sendCode({ phone: rawPhone, captchaVerify }: { phone: string; captchaVerify?: string }) {
      const phone = normalizePhone(rawPhone);
      if (!PHONE_RE.test(phone)) {
        throw new ApiError(400, "validation_failed", "请输入有效的手机号码");
      }
      // Captcha: the partner requires a non-empty token, then verifies (currently a
      // pass-through stub). Honour the same contract; skip in debug mode.
      if (!smsDebugMode) {
        if (!captchaVerify || captchaVerify.trim() === "") {
          throw new ApiError(400, "validation_failed", "验证码验证失败，请重新验证");
        }
        if (verifyCaptcha) {
          try {
            const r = await verifyCaptcha(captchaVerify);
            if (!r.verifyResult) {
              throw new ApiError(400, "validation_failed", r.message ?? "验证码验证失败");
            }
          } catch (e) {
            if (e instanceof ApiError) throw e;
            // partner policy: on captcha service exception, allow through.
            console.error("captcha verify exception (allowing through):", e);
          }
        }
      }

      const now = nowMs();
      // 60s resend guard.
      const since = new Date(now - RESEND_WINDOW_MS).toISOString();
      const { data: recent, error: recentErr } = await admin
        .from("auth_verify_code")
        .select("id")
        .eq("phone", phone)
        .gt("created_at", since)
        .limit(1);
      if (recentErr) {
        throw new ApiError(500, "internal", `rate-limit check failed: ${recentErr.message}`);
      }
      if (recent && recent.length > 0 && !smsDebugMode) {
        throw new ApiError(429, "rate_limited", "验证码发送过于频繁，请60秒后重试");
      }

      const code = genCode();
      const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
      const { error: insErr } = await admin
        .from("auth_verify_code")
        .insert({ phone, code, expires_at: expiresAt });
      if (insErr) {
        throw new ApiError(500, "internal", `failed to persist code: ${insErr.message}`);
      }

      if (smsDebugMode) {
        return { success: true, debugCode: code };
      }

      try {
        await sendSms({ phone, code, orgId: defaultOrgId });
      } catch (e) {
        // Roll back the unsent code so the rate-limit window doesn't lock the user.
        await admin.from("auth_verify_code").delete().eq("phone", phone).eq("code", code);
        throw new ApiError(502, "upstream_unavailable", `SMS send failed: ${(e as Error)?.message ?? e}`);
      }
      return { success: true };
    },

    /**
     * POST /v1/auth/phone/login
     * verify code → resolve public.users by (defaultOrgId, mobile) → MULTI_USER
     * / reuse / create (synthetic email) → mint session via magiclink.
     */
    async login({ phone: rawPhone, code, userId }: { phone: string; code: string; userId?: string }) {
      const phone = normalizePhone(rawPhone);
      if (!PHONE_RE.test(phone)) {
        throw new ApiError(400, "validation_failed", "请输入有效的手机号码");
      }
      if (!code || code.length !== 6) {
        throw new ApiError(400, "validation_failed", "验证码必须是6位数字");
      }

      const nowIso = new Date(nowMs()).toISOString();
      const { data: codeRow, error: codeErr } = await admin
        .from("auth_verify_code")
        .select("*")
        .eq("phone", phone)
        .eq("code", code)
        .eq("used", false)
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (codeErr) {
        throw new ApiError(500, "internal", `verify code query failed: ${codeErr.message}`);
      }
      if (!codeRow) {
        throw new ApiError(400, "validation_failed", "验证码错误或已过期");
      }

      // Resolve partner user(s) by MOBILE ALONE — deliberately not scoped to
      // defaultOrgId.
      //
      // The org filter made a phone number mean "that one row in the shared
      // tenant", which forced every phone identity to keep org_id =
      // DEFAULT_ORG forever. Anything that moved it — switch_active_team
      // rewrites public.users.org_id to the team's oid — made the next login
      // miss and register the person again as a brand-new user. That is what
      // blocked giving phone sign-ups their own org.
      //
      // A phone number can legitimately have a row per org (that is how a
      // cross-tenant employee is represented); more than one row is not an
      // error, it is the account picker below.
      let q = admin
        .from("users")
        .select("*, orgs(id, name, logo)")
        .eq("mobile", phone)
        .is("deleted_at", null);
      if (userId && userId.trim() !== "") q = q.eq("id", userId);
      const { data: users, error: usersErr } = await q;
      if (usersErr) {
        throw new ApiError(500, "internal", `users query failed: ${usersErr.message}`);
      }

      // Ambiguous: let the client pick (org/account picker). Don't consume the code.
      if (users && users.length > 1) {
        const picker = users.map((u: any) => ({
          id: u.id,
          org_id: u.org_id,
          org_name: (u.orgs as any)?.name ?? null,
          org_logo: (u.orgs as any)?.logo ?? null,
          nickname: u.nickname ?? "",
          email: u.email ?? "",
        }));
        return { multiUser: true, users: picker };
      }

      const markUsed = async () => {
        await admin
          .from("auth_verify_code")
          .update({ used: true, used_at: new Date(nowMs()).toISOString() })
          .eq("id", codeRow.id);
      };

      if (users && users.length === 1) {
        const user = users[0];
        const authId = user.auth_user_id || user.id;
        const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(authId);
        if (authErr || !authUser?.user?.email) {
          throw new ApiError(500, "internal", `auth user lookup failed: ${authErr?.message ?? "no email"}`);
        }
        // amux.current_org_id() reads app_metadata.org_id BEFORE falling back to
        // public.users.org_id, so a stale claim would pin the session to
        // whichever org was stamped at sign-up no matter which account the
        // picker resolved. Sync it to the row we actually logged in as.
        const claimedOrg = (authUser.user.app_metadata as any)?.org_id ?? null;
        if (user.org_id && claimedOrg !== user.org_id) {
          const { error: syncErr } = await admin.auth.admin.updateUserById(authId, {
            app_metadata: { org_id: user.org_id },
          });
          if (syncErr) {
            throw new ApiError(500, "internal", `org claim sync failed: ${syncErr.message}`);
          }
        }
        const session = await generateSessionByEmail(authUser.user.email);
        await markUsed();
        return { session: sessionPayload(session), user };
      }

      // No user yet → create (synthetic email + public.users row, NO side-effects).
      const email = syntheticEmail(phone);
      const password = deterministicPassword(phone, encryptionKey);
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { org_id: defaultOrgId },
      });
      if (createErr || !created?.user) {
        throw new ApiError(500, "internal", `createUser failed: ${createErr?.message ?? "no user"}`);
      }
      const authId = created.user.id;
      const nickname = `user_${Math.random().toString(36).slice(2, 6)}_${phone.slice(-4)}`;
      const { data: userRow, error: insUserErr } = await admin
        .from("users")
        .insert({
          id: authId,
          org_id: defaultOrgId,
          mobile: phone,
          auth_user_id: authId,
          nickname,
        })
        .select()
        .single();
      if (insUserErr) {
        // Roll back the orphan auth user so a retry can succeed.
        try { await admin.auth.admin.deleteUser(authId); } catch { /* best effort */ }
        throw new ApiError(500, "internal", `create public.users failed: ${insUserErr.message}`);
      }

      const session = await generateSessionByEmail(email);
      await markUsed();
      return { session: sessionPayload(session), user: userRow, created: true };
    },
  };
}
