/** Legal fc_status (deploy lifecycle) transitions. Orthogonal to
 *  provision_status (repo/seed lifecycle). A NULL/absent fc_status means the
 *  app has never been deployed and is treated as `not_deployed`. */
const ALLOWED: Record<string, string[]> = {
  not_deployed: ["awaiting_build", "deploy_error"],
  awaiting_build: ["building", "deploying", "deploy_error"],
  building: ["deploying", "deploy_error"],
  deploying: ["live", "deploy_error"],
  live: ["awaiting_build", "deploy_error"],
  uninstalled: ["awaiting_build", "deploy_error"],
  deploy_error: ["awaiting_build", "deploy_error"],
};

export const FC_STATUS_NOT_DEPLOYED = "not_deployed";

export function isLegalFcTransition(from: string | null | undefined, to: string): boolean {
  const cur = from ?? FC_STATUS_NOT_DEPLOYED;
  return (ALLOWED[cur] ?? []).includes(to);
}
