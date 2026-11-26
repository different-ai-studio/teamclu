/** Legal client-driven provision_status transitions.
 *
 *  An app is created `pending` and the desktop writes the terminal
 *  `ready`/`error` once the local daemon has seeded the checkout. Clients may
 *  never move a row back TO `pending` or `repo_created` (no list includes
 *  them); `seeding` is kept reachable for a future real "in progress" signal.
 *
 *  `repo_created` is produced by createApp's Gitea provisioning step; legacy
 *  rows may still sit in it from before the no-remote-repo era. */
const ALLOWED: Record<string, string[]> = {
  pending: ["seeding", "ready", "error"],
  repo_created: ["seeding", "ready", "error"],
  seeding: ["ready", "error"],
  error: ["seeding", "ready", "error"],
  ready: ["seeding", "ready", "error"],
};

export function isLegalStatusTransition(from: string, to: string): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/** What `provision_error` holds when the client reports `error` with no reason. */
export const CLIENT_PROVISION_ERROR_FALLBACK = "provisioning failed on the client (no reason reported)";

const CLIENT_PROVISION_ERROR_MAX = 2000;

/**
 * The `provision_error` to store for a client-reported `error`: the reason it
 * sent, trimmed and capped (it is daemon/git output, which can run long), or a
 * fixed sentence when it sent none — an empty column reads as "nothing went
 * wrong", which is exactly the confusion a failed seed left behind.
 */
export function clientProvisionError(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return CLIENT_PROVISION_ERROR_FALLBACK;
  return text.length > CLIENT_PROVISION_ERROR_MAX ? `${text.slice(0, CLIENT_PROVISION_ERROR_MAX)}…` : text;
}
