// Accounts created by enterprise sign-in (WeCom, later DingTalk / Feishu) are
// synthetic: the provider does not give a third-party app the person's name,
// so the server names them `<provider label> <4 hex>` and gives them an
// internal `<uuid>@teamclu.<provider>` email that is never mailed. See
// amux.ensure_sso_identity in 20261126120000_enterprise_sso.sql.

const PLACEHOLDER_EMAIL = /@teamclu\.(wecom|dingtalk|feishu)$/i;
const PLACEHOLDER_NAME = /^(企业微信用户|钉钉用户|飞书用户|SSO) [0-9a-f]{4}$/;

/** True for the internal email of an enterprise sign-in account. */
export function isSsoPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && PLACEHOLDER_EMAIL.test(email.trim());
}

/** True while an enterprise sign-in account still has the server's fallback name. */
export function isSsoPlaceholderName(name: string | null | undefined): boolean {
  return !!name && PLACEHOLDER_NAME.test(name.trim());
}
