import { resolveAliyunAppPlatform } from "./aliyun/index.js";
import type { AppPlatformResolution } from "./provider.js";

export type * from "./provider.js";

let override: (() => AppPlatformResolution) | null = null;

/**
 * The cloud the app platform runs on, resolved from the environment on every
 * call (the environment is read lazily so importing this module needs none).
 *
 * `error` names the missing configuration, for the 503 the caller returns.
 */
export function resolveAppPlatform(): AppPlatformResolution {
  return override ? override() : resolveAliyunAppPlatform();
}

/**
 * Replace the provider for the rest of the test (pass `null` to restore).
 * Tests only: production has exactly one provider, chosen above.
 */
export function setAppPlatformForTests(resolver: (() => AppPlatformResolution) | null): void {
  override = resolver;
}
