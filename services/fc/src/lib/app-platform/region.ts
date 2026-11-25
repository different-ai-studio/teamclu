import { OSS_REGION } from "../oss.js";

/**
 * Region for the app's function AND its code bucket. Function Compute can only
 * load code from an OSS bucket in its OWN region, so one knob covers both — two
 * would let them drift into a deploy that fails inside the FC API.
 *
 * A plain environment read, not part of {@link resolveAppPlatform}: callers
 * that only need to name the region (a stored row with no `fc_region`, the
 * runtime catalog) must get it even when the provider cannot be resolved.
 */
export function appsRegion(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPS_REGION?.trim() || OSS_REGION(env);
}
