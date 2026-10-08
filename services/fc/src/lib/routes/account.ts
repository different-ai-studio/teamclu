import { requireString } from "../routing-utils.js";
import { ApiError } from "../http-utils.js";

export function registerAccount(router) {
  // Graduate the caller out of the shared DEFAULT_ORG into their own org:
  // create the org (name + contact), reparent + rename their default-org team.
  // Authenticated (caller bearer forwarded to the SECURITY DEFINER RPC).
  // See docs/specs/2026-06-17-teamclu-phone-login-and-tenancy.md §8.
  router.post("/v1/account/upgrade", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.teamId, "teamId");
    requireString(body.orgName, "orgName");
    const result = await ctx.repository.upgradeAccount({
      teamId: body.teamId,
      orgName: body.orgName,
      contact: typeof body.contact === "string" ? body.contact : null,
    });
    return { body: result };
  });

  // Phone binding belonged to the anonymous-account upgrade, which is gone, and
  // it wrote the identity into DEFAULT_ORG, which TeamClu no longer does
  // (docs/plans/2026-10-08-staff-only-identity-model.md). No client calls it;
  // kept as an explicit 410 so a stray caller gets a legible answer.
  router.post("/v1/account/bind-phone", async () => {
    throw new ApiError(410, "phone_binding_removed", "phone binding is no longer supported");
  });
}
