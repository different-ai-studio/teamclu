// --- Permission Policy ---
// Global permission policy configuration for controlling permission request behavior.
// Persisted in localStorage under '${appStoragePrefix}-permission-policy'.

import { appStoragePrefix } from "@/lib/config/build-config";

type PermissionPolicy = "ask" | "batch" | "bypass";

const PERMISSION_POLICY_KEY = `${appStoragePrefix}-permission-policy`;
const PERMISSION_BATCH_DONE_KEY = `${appStoragePrefix}-permission-batch-done`;
const DEFAULT_POLICY: PermissionPolicy = "ask";
const VALID_POLICIES: ReadonlySet<string> = new Set(["ask", "batch", "bypass"]);

/**
 * Read the current permission policy from localStorage.
 * Falls back to 'ask' for missing or invalid values.
 */
export function getPermissionPolicy(): PermissionPolicy {
  try {
    const stored = localStorage.getItem(PERMISSION_POLICY_KEY);
    if (stored && VALID_POLICIES.has(stored)) {
      return stored as PermissionPolicy;
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_POLICY;
}

/**
 * Persist the permission policy to localStorage.
 */
export function setPermissionPolicy(policy: PermissionPolicy): void {
  try {
    localStorage.setItem(PERMISSION_POLICY_KEY, policy);
  } catch {
    // localStorage unavailable
  }
}

/**
 * Check whether the batch authorization flow has been completed.
 * Returns true only if the stored value is exactly "true".
 */
function isBatchDone(): boolean {
  try {
    return localStorage.getItem(PERMISSION_BATCH_DONE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Mark the batch authorization flow as done (or reset it).
 */
export function setBatchDone(done: boolean): void {
  try {
    localStorage.setItem(PERMISSION_BATCH_DONE_KEY, String(done));
  } catch {
    // localStorage unavailable
  }
}

/**
 * Check if permissions should be auto-authorized based on the current policy.
 * Returns true when bypass mode is active, or batch mode with batch done.
 */
export function shouldAutoAuthorize(): boolean {
  const policy = getPermissionPolicy();
  if (policy === "bypass") return true;
  if (policy === "batch" && isBatchDone()) return true;
  return false;
}
