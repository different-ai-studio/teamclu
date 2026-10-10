import { requireString } from "../routing-utils.js";
import { optionalBearerToken, extractBearerToken, ApiError } from "../http-utils.js";

export function registerInvites(router) {
  // The bearer is OPTIONAL on this route, and which path it serves depends on
  // the invite kind:
  //   - member invite: the joining user is already authenticated (anonymous or
  //     real). Their bearer MUST be forwarded so the SECURITY DEFINER RPC
  //     `claim_team_invite` resolves `auth.uid()` and attaches the new actor to
  //     that user. Without it the RPC raises 'member claim requires
  //     authentication' (42501) — the bug this route used to have, since it
  //     always claimed anonymously.
  //   - agent invite: the daemon's `amuxd init` flow has no token yet; the RPC
  //     mints its own in-DB user, so an anonymous claim is correct.
  router.post("/v1/invites/claim", { auth: "none" }, async (ctx) => {
    const body = ctx.json;
    requireString(body.token, "token");
    const accessToken = optionalBearerToken(ctx.headers) ?? undefined;
    const result = await ctx.repository.claimInvite(body.token, { accessToken });
    return { body: result };
  });

  // Invites waiting for the caller's verified email/phone — the contact path,
  // for invitees who never received a token out-of-band. `auth: "none"` routes
  // to the auth repository (which owns the per-bearer client the underlying
  // `auth.uid()`-keyed RPCs need); the bearer is REQUIRED here, unlike on the
  // claim route above, since there is no anonymous variant of "my invites".
  router.get("/v1/invites/pending", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.headers);
    const result = await ctx.repository.listPendingInvites({ accessToken });
    return { body: result };
  });

  router.post("/v1/invites/:inviteId/accept", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.headers);
    const inviteId = decodeURIComponent(ctx.params.inviteId);
    const result = await ctx.repository.acceptPendingInvite(inviteId, { accessToken });
    return { body: result };
  });

  router.post("/v1/invites/:inviteId/decline", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.headers);
    const inviteId = decodeURIComponent(ctx.params.inviteId);
    await ctx.repository.declinePendingInvite(inviteId, { accessToken });
    return { statusCode: 204 };
  });

  router.get("/v1/join-links/:token", { auth: "none" }, async (ctx) => {
    const token = decodeURIComponent(ctx.params.token);
    const result = await ctx.repository.previewJoinLink(token);
    return { body: result, headers: { "Cache-Control": "no-store" } };
  });

  router.post("/v1/join-links/:token/join", { auth: "none" }, async (ctx) => {
    const token = decodeURIComponent(ctx.params.token);
    const accessToken = optionalBearerToken(ctx.headers) ?? undefined;
    if (!accessToken) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }
    const result = await ctx.repository.joinTeamByLink(token, { accessToken });
    return { body: result };
  });
}
