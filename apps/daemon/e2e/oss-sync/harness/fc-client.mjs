import { postJson, deleteJson } from "./http.mjs";

/** 注册新账号，返回 owner access_token（signup 即时可用，email_verified=true，无需邮箱确认）。 */
export async function signup(base, email, password) {
  const out = await postJson(`${base}/v1/auth/signup`, { email, password }, null);
  const token = out.access_token ?? out.session?.access_token;
  if (!token) throw new Error(`signup: no access_token in response: ${JSON.stringify(out)}`);
  return token;
}

/** 密码登录，返回 owner access_token（GoTrue 形 access_token 字段）。 */
export async function signin(base, email, password) {
  const out = await postJson(`${base}/v1/auth/signin-password`, { email, password }, null);
  const token = out.access_token ?? out.session?.access_token;
  if (!token) throw new Error(`signin: no access_token in response: ${JSON.stringify(out)}`);
  return token;
}

/** 建 team，返回 teamId。 */
export async function createTeam(base, token, name) {
  const out = await postJson(`${base}/v1/teams`, { name }, token);
  if (!out.id) throw new Error(`createTeam: no id: ${JSON.stringify(out)}`);
  return out.id;
}

/** 建 agent invite（amuxd），返回 invite token。 */
export async function createAgentInvite(base, token, teamId, displayName) {
  const out = await postJson(
    `${base}/v1/teams/${encodeURIComponent(teamId)}/invites`,
    { kind: "agent", agentKind: "amuxd", displayName },
    token,
  );
  if (!out.token) throw new Error(`createAgentInvite: no token: ${JSON.stringify(out)}`);
  return out.token;
}

/** best-effort 清理：移除一个 actor（team 行无删除端点，仅退成员）。 */
export async function removeActor(base, token, teamId, actorId) {
  try {
    await deleteJson(`${base}/v1/teams/${encodeURIComponent(teamId)}/actors/${encodeURIComponent(actorId)}`, token);
  } catch {
    /* best-effort */
  }
}
