type Env = NodeJS.ProcessEnv;

const trimmed = (v: string | undefined) => v?.trim() || "";

/**
 * Legacy managed-git config (Alibaba CodeUp). Replaced by Gitea (`readGiteaConfig`).
 * Vars stay in the deploy allowlists until the CodeUp path is removed.
 */
export function readCodeUpConfig(env: Env = process.env) {
  return {
    orgId: trimmed(env.CODEUP_ORG_ID),
    pat: trimmed(env.CODEUP_PAT),
    botUsername: trimmed(env.CODEUP_BOT_USERNAME) || "teamclu",
  };
}
