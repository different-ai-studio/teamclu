import { ApiError } from "../http-utils.js";
import { isRateLimited, resolveClientIp } from "../rate-limit.js";
import { requireString } from "../routing-utils.js";
import {
  createDevicePairingCode,
  mintDeviceAccessToken,
  redeemDevicePairingCode,
} from "../device-pairing.js";

/** Redeem is unauthenticated; keep attempts cheap to brute-force. */
const REDEEM_RATE_MAX = 20;

export function registerDevices(router) {
  // amuxd / desktop mint a single-use code the user types into the captive portal.
  router.post("/v1/devices/pairing-codes", async (ctx) => {
    const body = ctx.json ?? {};
    const code = requireString(body.code, "code");
    const teamId = requireString(body.teamId, "teamId");
    const actorId = requireString(body.actorId, "actorId");

    // Membership (and actor existence) before we write anything. The repo method
    // is the same gate voice credentials use.
    if (typeof ctx.repository.createDevicePairingCode === "function") {
      const out = await ctx.repository.createDevicePairingCode({
        code,
        teamId,
        actorId,
        ttlSeconds: body.ttlSeconds,
      });
      return { body: out };
    }

    throw new ApiError(501, "not_implemented", "device pairing is not available on this backend");
  });

  // Device redeems after Wi-Fi is up. No bearer — the code IS the capability.
  router.post("/v1/devices/redeem", { auth: "none" }, async (ctx) => {
    const { ip } = resolveClientIp((name) => ctx.getHeader?.(name) ?? ctx.headers?.[name]);
    const rateKey = ip ?? "unknown";
    if (isRateLimited(`device-redeem:${rateKey}`, REDEEM_RATE_MAX)) {
      throw new ApiError(429, "rate_limited", "too many redeem attempts; try again shortly");
    }

    const body = ctx.json ?? {};
    const out = await redeemDevicePairingCode({
      code: body.code,
      deviceId: body.deviceId,
      model: body.model,
      fw: body.fw,
    });
    return { body: out };
  });

  // Steady-state: exchange the long-lived device secret for a short MQTT JWT.
  router.post("/v1/devices/token", { auth: "none" }, async (ctx) => {
    const { ip } = resolveClientIp((name) => ctx.getHeader?.(name) ?? ctx.headers?.[name]);
    const rateKey = ip ?? "unknown";
    if (isRateLimited(`device-token:${rateKey}`, REDEEM_RATE_MAX)) {
      throw new ApiError(429, "rate_limited", "too many token requests; try again shortly");
    }

    const body = ctx.json ?? {};
    const out = await mintDeviceAccessToken({
      deviceSecret: body.deviceSecret,
      deviceId: body.deviceId,
    });
    return { body: out };
  });
}
