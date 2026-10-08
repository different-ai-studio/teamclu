import { ApiError, extractBearerToken, optionalBearerToken } from "../http-utils.js";

export function registerAuth(router) {
  router.post("/v1/auth/refresh", { auth: "none" }, async (ctx) => {
    const { refreshToken } = ctx.json;
    if (!refreshToken || typeof refreshToken !== "string") {
      throw new ApiError(400, "validation_failed", "refreshToken is required");
    }
    const out = await ctx.repository.refreshAccessToken({ refreshToken });
    return { body: out };
  });

  // The signed-in person's identities, one per org — the login-time org picker
  // for an email user (phone login offers its own). Bearer forwarded: the RPC
  // resolves the person from auth.uid().
  router.get("/v1/auth/identities", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.headers);
    const items = await ctx.repository.listMyIdentities({ accessToken });
    return { body: { items } };
  });

  // A refresh token for one of the caller's own identities; the client adopts
  // it through /v1/auth/refresh.
  router.post("/v1/auth/identities/:userId/session", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.headers);
    const userId = decodeURIComponent(ctx.params.userId);
    const out = await ctx.repository.mintIdentitySession(userId, { accessToken });
    return { body: out };
  });

  // Anonymous / quick-trial sign-in has been removed from the product. Kept as
  // an explicit 410 rather than deleted so already-installed clients get a
  // legible answer instead of a 404 that reads like a routing bug. GoTrue's own
  // ENABLE_ANONYMOUS_USERS is off as well — this route is the polite half.
  router.post("/v1/auth/signin-anonymous", { auth: "none" }, async () => {
    throw new ApiError(
      410,
      "anonymous_signin_removed",
      "anonymous sign-in is no longer supported; sign in with an account or use an invite link",
    );
  });

  // Phone verification-code login, aligned with the partner SaaS (synthetic email +
  // default org, see lib/supabase-repo/phone-auth.ts). Replaces the GoTrue
  // native phone-OTP path below.
  router.post("/v1/auth/phone/send-code", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (typeof body.phone !== "string" || body.phone.length === 0) {
      throw new ApiError(400, "validation_failed", "phone is required");
    }
    const out = await ctx.repository.phoneSendCode({
      phone: body.phone,
      captchaVerify: typeof body.captchaVerify === "string" ? body.captchaVerify : undefined,
    });
    return { body: out };
  });

  router.post("/v1/auth/phone/login", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (typeof body.phone !== "string" || body.phone.length === 0) {
      throw new ApiError(400, "validation_failed", "phone is required");
    }
    if (typeof body.code !== "string" || body.code.length === 0) {
      throw new ApiError(400, "validation_failed", "code is required");
    }
    // Client sends camelCase `userId` (auth-client loginWithPhoneUser); accept
    // snake_case `user_id` too for robustness. Without this the account-picker
    // selection is dropped and phoneLogin re-returns multiUser (no session).
    const pickedUserId =
      typeof body.userId === "string"
        ? body.userId
        : typeof body.user_id === "string"
          ? body.user_id
          : undefined;
    const out = await ctx.repository.phoneLogin({
      phone: body.phone,
      code: body.code,
      userId: pickedUserId,
    });
    return { body: out };
  });

  router.post("/v1/auth/signin-otp", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    const hasEmail = typeof body.email === "string" && body.email.length > 0;
    const hasPhone = typeof body.phone === "string" && body.phone.length > 0;
    if (!hasEmail && !hasPhone) {
      throw new ApiError(400, "validation_failed", "email or phone is required");
    }
    // Phone OTP is no longer served by GoTrue native /otp — it diverged from
    // the partner's user model (phone-native user, no public.users) and created
    // duplicate accounts. Phone callers must use /v1/auth/phone/{send-code,login}.
    if (hasPhone && !hasEmail) {
      throw new ApiError(
        400,
        "validation_failed",
        "phone OTP moved to POST /v1/auth/phone/send-code + /v1/auth/phone/login",
      );
    }
    const out = await ctx.repository.signInOtp({
      email: hasEmail ? body.email : undefined,
      phone: hasPhone ? body.phone : undefined,
      options: body.options,
    });
    return { body: out };
  });

  router.post("/v1/auth/verify-otp", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    const hasEmail = typeof body.email === "string" && body.email.length > 0;
    const hasPhone = typeof body.phone === "string" && body.phone.length > 0;
    if (!hasEmail && !hasPhone) {
      throw new ApiError(400, "validation_failed", "email or phone is required");
    }
    if (!body.token || typeof body.token !== "string") {
      throw new ApiError(400, "validation_failed", "token is required");
    }
    // GoTrue verify type defaults to "email"; phone OTP must pass "sms".
    const out = await ctx.repository.verifyOtp({
      email: hasEmail ? body.email : undefined,
      phone: hasPhone ? body.phone : undefined,
      token: body.token,
      type: body.type ?? (hasPhone ? "sms" : "email"),
    });
    return { body: out };
  });

  router.post("/v1/auth/signout", { auth: "none" }, async (ctx) => {
    // Authentication is enforced by GoTrue (bearer token is forwarded).
    // We mark as auth:"none" so the FC layer doesn't reject pre-validation;
    // GoTrue itself rejects invalid tokens.
    const accessToken = extractBearerToken(ctx.event.headers);
    if (!accessToken) {
      throw new ApiError(401, "missing_auth", "Bearer token required");
    }
    const out = await ctx.repository.signOut({ accessToken });
    return { body: out };
  });

  router.patch("/v1/auth/user", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.event.headers);
    if (!accessToken) {
      throw new ApiError(401, "missing_auth", "Bearer token required");
    }
    const body = ctx.json ?? {};
    const out = await ctx.repository.updateUser({ accessToken, body });
    return { body: out };
  });

  router.post("/v1/auth/signin-password", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.email || typeof body.email !== "string") {
      throw new ApiError(400, "validation_failed", "email is required");
    }
    if (!body.password || typeof body.password !== "string") {
      throw new ApiError(400, "validation_failed", "password is required");
    }
    const out = await ctx.repository.signInWithPassword({ email: body.email, password: body.password });
    return { body: out };
  });

  router.post("/v1/auth/signup", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.email || typeof body.email !== "string") {
      throw new ApiError(400, "validation_failed", "email is required");
    }
    if (!body.password || typeof body.password !== "string") {
      throw new ApiError(400, "validation_failed", "password is required");
    }
    const out = await ctx.repository.signUp({ email: body.email, password: body.password });
    return { body: out };
  });

  router.get("/v1/auth/oauth/:provider/authorize", { auth: "none" }, async (ctx) => {
    const provider = decodeURIComponent(ctx.params.provider);
    const redirect = ctx.query.get("redirect");
    const codeChallenge = ctx.query.get("code_challenge");
    if (!redirect) throw new ApiError(400, "validation_failed", "redirect is required");
    if (!codeChallenge) throw new ApiError(400, "validation_failed", "code_challenge is required");
    const location = ctx.repository.oauthAuthorizeUrl({ provider, redirect, codeChallenge });
    return { redirect: location };
  });

  router.post("/v1/auth/oauth/exchange", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.code || typeof body.code !== "string") throw new ApiError(400, "validation_failed", "code is required");
    if (!body.codeVerifier || typeof body.codeVerifier !== "string") throw new ApiError(400, "validation_failed", "codeVerifier is required");
    const out = await ctx.repository.exchangePkceCode({ code: body.code, codeVerifier: body.codeVerifier });
    return { body: out };
  });

  // Native OIDC sign-in (Apple / Google id_token grant). When a bearer token
  // is supplied, GoTrue links the identity to the current user instead of
  // creating a new one — this powers the anonymous → Apple upgrade path.
  router.post("/v1/auth/signin-idtoken", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.provider || typeof body.provider !== "string") {
      throw new ApiError(400, "validation_failed", "provider is required");
    }
    if (!body.idToken || typeof body.idToken !== "string") {
      throw new ApiError(400, "validation_failed", "idToken is required");
    }
    const accessToken = optionalBearerToken(ctx.event.headers);
    const out = await ctx.repository.signInWithIdToken({
      provider: body.provider,
      idToken: body.idToken,
      nonce: body.nonce ?? null,
      accessToken: accessToken ?? null,
    });
    return { body: out };
  });
}