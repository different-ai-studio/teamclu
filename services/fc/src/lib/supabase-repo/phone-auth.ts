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

  // On belayo `public.users` is the partner's gym MEMBERSHIP table: one row per
  // gym this person holds a card at (admin_type = 1). Those rows are not
  // accounts anyone signs in to TeamClu as, and offering them turns the account
  // picker into a list of every gym the person ever climbed at. Keep a row only
  // when it is
  //   - a live employee record (admin_type >= 2 — the same rule as
  //     amux.caller_employee_orgs(), which the team picker already applies), or
  //   - an identity that already holds an actor: a phone sign-up's own row is
  //     admin_type 1 yet owns the teams it created.
  // When nothing survives, fall back to the unfiltered rows so a person who only
  // has membership rows signs in exactly as before.
  async function accountsForPicker(rows: any[]): Promise<any[]> {
    if (rows.length <= 1) return rows;
    const { data: actorRows, error } = await admin
      .schema("amux")
      .from("actors")
      .select("user_id")
      .in("user_id", rows.map((r) => r.id));
    if (error) {
      // Narrowing is cosmetic; never let it block sign-in.
      console.error("phone login: actor lookup failed, offering every account:", error.message);
      return rows;
    }
    const withActor = new Set((actorRows ?? []).map((a: any) => a.user_id));
    const kept = rows.filter((r) => Number(r.admin_type ?? 0) >= 2 || withActor.has(r.id));
    return kept.length > 0 ? kept : rows;
  }

  function syntheticEmail(phone: string): string {
    return `${phone}@${phoneEmailDomain}`;
  }

  /**
   * The auth user this phone already signs in as, if any.
   *
   * Asked of `public.users` rather than GoTrue because that is where this
   * module keeps the phone↔account mapping, and because the admin API offers
   * no lookup by email — only `getUserById` and a paged `listUsers`, and
   * paging every account to answer one login is not a trade worth making.
   *
   * Residual case: an auth user whose `public.users` row never landed (the
   * rollback below is best-effort) is invisible here, and creating it again
   * fails loudly on the duplicate email rather than silently minting a second
   * account for one person.
   */
  async function findAuthUserIdForPhone(phone: string): Promise<string | null> {
    const { data, error } = await admin
      .from("users")
      .select("auth_user_id")
      .eq("mobile", phone)
      .is("deleted_at", null);
    if (error) {
      throw new ApiError(500, "internal", `auth user lookup by phone failed: ${error.message}`);
    }
    // Filtered here rather than with `.not(...)`: one phone holds at most a
    // handful of rows (the busiest number in production has eight), so the
    // predicate costs nothing to apply locally and the query stays a plain
    // equality that every caller of this module can reason about.
    return (data ?? []).map((r: any) => r.auth_user_id).find((id: any) => !!id) ?? null;
  }

  /**
   * Claim an unbound identity row for this auth user — MEMBER ROWS ONLY.
   *
   * Binding is how a partner row that has never signed in becomes reachable:
   * 550,666 of 629,445 rows carry no `auth_user_id`, and the gateway resolves a
   * visitor's tenant identity by that column, so an unbound row is invisible to
   * it. It is also irreversible in practice, and Chinese mobile numbers get
   * recycled — so whoever verifies an SMS on a recycled number would inherit
   * whatever the previous holder had.
   *
   * Hence `admin_type === 1` only, by product decision: inheriting a membership
   * is a nuisance, inheriting a coach's or an accountant's staff row is a
   * privilege escalation, and staff rows are exactly what the `org` audience
   * admits an app on. A staff row stays unbound and someone has to grant it.
   *
   * The `is("auth_user_id", null)` guard is not redundant with the early
   * return: two concurrent logins on one number would otherwise race, and the
   * loser must not overwrite the winner's binding.
   */
  /**
   * The auth account for this phone, creating it only if there is none.
   *
   * One person, one auth account, identities per tenant — so both callers (a
   * first sign-in on an unbound partner row, and a tenant sign-up) go through
   * here rather than each deciding for itself whether to call `createUser`.
   *
   * `created` is returned because it is the only safe basis for rollback: an
   * auth user we reused carries the person's other tenant identities and must
   * survive a failure further down.
   */
  async function ensureAuthUserForPhone(
    phone: string,
  ): Promise<{ authId: string; created: boolean }> {
    const existing = await findAuthUserIdForPhone(phone);
    if (existing) return { authId: existing, created: false };
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: syntheticEmail(phone),
      password: deterministicPassword(phone, encryptionKey),
      email_confirm: true,
      // Never a tenant org: see the claim-sync note in login(). The platform
      // side of a phone identity stays in DEFAULT_ORG.
      app_metadata: { org_id: defaultOrgId },
    });
    if (createErr || !created?.user) {
      throw new ApiError(500, "internal", `createUser failed: ${createErr?.message ?? "no user"}`);
    }
    return { authId: created.user.id, created: true };
  }

  async function bindMemberIdentity(user: any, authId: string): Promise<boolean> {
    if (user.auth_user_id) return true;
    if (Number(user.admin_type ?? 0) !== 1) return false;
    const { error } = await admin
      .from("users")
      .update({ auth_user_id: authId })
      .eq("id", user.id)
      .is("auth_user_id", null);
    if (error) {
      throw new ApiError(500, "internal", `identity binding failed: ${error.message}`);
    }
    user.auth_user_id = authId;
    return true;
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
    /**
     * `tenantOrgId` / `allowSignup` are the app login page's, and ONLY its.
     *
     * Two HTTP surfaces reach this method: the FC-hosted app login page, which
     * always knows which app — and so which tenant — is asking, and
     * `/v1/auth/phone/login`, which the desktop and iOS clients call with no app
     * in sight and therefore no tenant to scope to. Omitting both options must
     * leave this method behaving exactly as it did, because that is the
     * contract those two clients are already shipped against.
     */
    async login({
      phone: rawPhone,
      code,
      userId,
      tenantOrgId,
      allowSignup,
    }: {
      phone: string;
      code: string;
      userId?: string;
      /** Narrow every identity decision to this org. Absent = platform-wide. */
      tenantOrgId?: string;
      /** Create an identity in `tenantOrgId` when the caller holds none. */
      allowSignup?: boolean;
    }) {
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
      //
      // `tenantOrgId` narrows that to one tenant. It does NOT reintroduce the
      // defaultOrgId filter the paragraph above retired: that one pinned every
      // phone identity to a FIXED org for all callers, which is what broke on
      // the first switch_active_team. This one is the asking app's own org,
      // supplied per request, and the platform-wide path still has no filter.
      let q = admin
        .from("users")
        .select("*, orgs(id, name, logo)")
        .eq("mobile", phone)
        .is("deleted_at", null);
      if (tenantOrgId) q = q.eq("org_id", tenantOrgId);
      if (userId && userId.trim() !== "") q = q.eq("id", userId);
      const { data: matched, error: usersErr } = await q;
      if (usersErr) {
        throw new ApiError(500, "internal", `users query failed: ${usersErr.message}`);
      }
      // An explicit pick is honoured as-is; the narrowing only shapes what the
      // picker offers (and whether there is a picker at all).
      //
      // `accountsForPicker` is skipped under tenant scoping, and its own
      // rationale is why: it exists because an unscoped picker "turns into a
      // list of every gym the person ever climbed at", which is a statement
      // about rows in OTHER orgs. Inside one tenant there is no such list —
      // there are at most a couple of rows, the org filter has already done the
      // narrowing, and dropping the member row would leave someone who holds
      // both a membership and a staff record with no way to sign in as a
      // member at all.
      const explicitPick = !!(userId && userId.trim() !== "");
      const users = explicitPick
        ? matched
        : tenantOrgId
          ? (matched ?? [])
          : await accountsForPicker(matched ?? []);

      // Ambiguous: let the client pick (org/account picker). Don't consume the code.
      if (users && users.length > 1) {
        // `admin_type` rides along so a picker narrowed to ONE org still tells
        // its entries apart: within a tenant the org name is the same on every
        // row, and what actually differs is the kind of identity (1 = member,
        // >=2 = staff) and the email. 1,220 phone numbers hold two rows in one
        // org today, 795 of them differing by admin_type and 796 by email.
        const picker = users.map((u: any) => ({
          id: u.id,
          org_id: u.org_id,
          org_name: (u.orgs as any)?.name ?? null,
          org_logo: (u.orgs as any)?.logo ?? null,
          admin_type: Number(u.admin_type ?? 0),
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

        // An unbound row has no auth user behind it, and `user.id` is then just
        // a partner uuid — `getUserById` on it fails. Claim it instead, which
        // is only allowed for a member row (see bindMemberIdentity). Checked
        // BEFORE ensuring an auth user, so a staff row never causes one to be
        // minted for a number that is not entitled to sign in.
        if (!user.auth_user_id) {
          if (Number(user.admin_type ?? 0) !== 1) {
            throw new ApiError(403, "forbidden", "该账号尚未开通手机号登录，请联系管理员");
          }
          const { authId: ensured } = await ensureAuthUserForPhone(phone);
          await bindMemberIdentity(user, ensured);
          if (!user.auth_user_id) {
            throw new ApiError(403, "forbidden", "该账号尚未开通手机号登录，请联系管理员");
          }
        }

        const authId = user.auth_user_id;
        const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(authId);
        if (authErr || !authUser?.user?.email) {
          throw new ApiError(500, "internal", `auth user lookup failed: ${authErr?.message ?? "no email"}`);
        }
        // amux.current_org_id() reads app_metadata.org_id BEFORE falling back to
        // public.users.org_id, so a stale claim would pin the session to
        // whichever org was stamped at sign-up no matter which account the
        // picker resolved. Sync it to the row we actually logged in as.
        //
        // NOT for an app login. That claim is one value on an auth user both
        // surfaces share, so writing it here would make "I opened an app on my
        // phone" silently reassign the org of the same person's desktop and iOS
        // sessions. The app's tenant travels in the app session cookie instead,
        // which is scoped to the app that issued it.
        const claimedOrg = (authUser.user.app_metadata as any)?.org_id ?? null;
        if (!tenantOrgId && user.org_id && claimedOrg !== user.org_id) {
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

      // Nobody here, and the caller did not ask us to create anyone.
      //
      // Saying so beats falling back to the unscoped list: that fallback would
      // offer identities in OTHER tenants, every one of which the gateway then
      // refuses — a picker whose every entry is a dead end — and it would tell
      // whoever holds this phone which other tenants the number has accounts in.
      if (tenantOrgId && !allowSignup) {
        throw new ApiError(403, "forbidden", "该手机号在本租户没有账号，请联系管理员开通");
      }

      // No identity here yet → create one.
      //
      // The org is the asking tenant when there is one, and DEFAULT_ORG on the
      // platform-wide path exactly as before.
      const signupOrgId = tenantOrgId ?? defaultOrgId;
      const email = syntheticEmail(phone);

      // The auth user may already exist, and under tenant scoping it usually
      // does: a phone with a row in tenant A but none in tenant B now reaches
      // this branch, and `createUser` on the same synthetic email would collide
      // (15,459 phone numbers already carry one). Reuse it — one person, one
      // auth account, identities per tenant. That is the same "same phone =
      // same person" rule the account picker is built on.
      const { authId, created: createdAuthUser } = await ensureAuthUserForPhone(phone);

      const nickname = `user_${Math.random().toString(36).slice(2, 6)}_${phone.slice(-4)}`;
      const { data: userRow, error: insUserErr } = await admin
        .from("users")
        .insert({
          // Only the FIRST row for a person can take the auth user's own id;
          // `public.users.id` is the primary key and a second tenant identity
          // would collide on it. Let the database generate one and carry the
          // link in `auth_user_id`, which is what the gateway resolves by.
          ...(createdAuthUser ? { id: authId } : {}),
          org_id: signupOrgId,
          mobile: phone,
          auth_user_id: authId,
          // Decided by the product owner over this module's objection: on
          // belayo `public.users` is the partner's membership table and
          // admin_type 1 reads as "holds a card at this gym", which is not true
          // of someone who only signed in to an app. Recorded here because the
          // row it writes is indistinguishable from a real membership.
          admin_type: 1,
          nickname,
        })
        .select()
        .single();
      if (insUserErr) {
        // Roll back ONLY an auth user this call created. Deleting a reused one
        // would destroy the person's existing identities in other tenants.
        if (createdAuthUser) {
          try { await admin.auth.admin.deleteUser(authId); } catch { /* best effort */ }
        }
        throw new ApiError(500, "internal", `create public.users failed: ${insUserErr.message}`);
      }

      const session = await generateSessionByEmail(email);
      await markUsed();
      return { session: sessionPayload(session), user: userRow, created: true };
    },
  };
}
