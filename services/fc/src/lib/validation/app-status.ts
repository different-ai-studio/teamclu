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
