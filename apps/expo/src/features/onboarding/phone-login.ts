/**
 * Phone sign-in (`POST /v1/auth/phone/send-code` → `POST /v1/auth/phone/login`),
 * the partner-aligned flow iOS uses (`CloudAPIAppOnboardingStore.sendPhoneOTP`
 * / `verifyPhoneOTPResult` / `loginWithPhoneUser`). These endpoints are not in
 * the OpenAPI contract; the shapes below follow the FC route
 * (`services/fc/src/lib/routes/auth.ts`) and `supabase-repo/phone-auth.ts`.
 *
 * `login` answers either with a session (GoTrue-shaped, snake_case, with the
 * user) or — when one phone number maps to several accounts — with
 * `{ multiUser: true, users }` and the code is NOT consumed, so the client asks
 * which account and posts again with `userId`.
 */

export type PhoneAccount = {
  id: string;
  orgId: string | null;
  orgName: string | null;
  orgLogo: string | null;
  /** 1 = member, >= 2 = staff; tells rows apart inside one org. 0 when absent. */
  adminType: number;
  nickname: string;
  email: string;
};

export type PhoneSessionBody = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  /** FC may send `null` here; readers must use optional chaining. */
  user?: { id?: string; email?: string | null; is_anonymous?: boolean };
};

export type PhoneLoginResult =
  | { type: "session"; session: PhoneSessionBody }
  | { type: "multiUser"; accounts: PhoneAccount[] };

/**
 * The captcha check behind send-code is a pass-through stub that only requires
 * a non-empty value (see the iOS store). Replace with a real token once the
 * captcha SDK is integrated.
 */
export const PHONE_CAPTCHA_PLACEHOLDER = "expo-captcha-pending";

/** Default prefix in the phone field, as iOS. */
export const DEFAULT_PHONE_PREFIX = "+86";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parsePhoneAccount(raw: unknown): PhoneAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id).trim();
  if (!id) return null;
  const adminType = Number(r.admin_type ?? r.adminType ?? 0);
  return {
    id,
    orgId: optStr(r.org_id ?? r.orgId),
    orgName: optStr(r.org_name ?? r.orgName),
    orgLogo: optStr(r.org_logo ?? r.orgLogo),
    adminType: Number.isFinite(adminType) ? adminType : 0,
    nickname: str(r.nickname).trim(),
    email: str(r.email).trim(),
  };
}

export function parsePhoneLoginResponse(body: unknown): PhoneLoginResult {
  if (typeof body !== "object" || body === null) {
    throw new Error("Phone sign-in returned no session.");
  }
  const r = body as Record<string, unknown>;
  if (r.multiUser === true) {
    const accounts = (Array.isArray(r.users) ? r.users : [])
      .map(parsePhoneAccount)
      .filter((a): a is PhoneAccount => a !== null);
    return { type: "multiUser", accounts };
  }
  const session = r.session as PhoneSessionBody | undefined;
  if (!session || typeof session !== "object" || !session.access_token || !session.refresh_token) {
    throw new Error("Phone sign-in returned no session.");
  }
  return { type: "session", session };
}

/** Strips spaces, dashes and brackets; keeps one leading `+`. */
export function normalizePhoneInput(raw: string): string {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return plus + trimmed.replace(/[^0-9]/g, "");
}

/** iOS enables "Send code" once there is more than a bare prefix. */
export function canSendPhoneCode(raw: string): boolean {
  const digits = normalizePhoneInput(raw).replace(/^\+/, "");
  return digits.length >= 5;
}

/** Picker row: the account's own name, or its email when it has none. */
export function phoneAccountTitle(account: PhoneAccount): string {
  return account.nickname || account.email || account.id.slice(0, 8);
}

/** Second line: the email, only when the title is the nickname. */
export function phoneAccountSubtitle(account: PhoneAccount): string | null {
  return account.nickname && account.email ? account.email : null;
}

/** Placeholder-logo letter: org name, else nickname, else email. */
export function phoneAccountInitial(account: PhoneAccount): string {
  const source = account.orgName || account.nickname || account.email;
  const first = source ? Array.from(source)[0] : undefined;
  return first ? first.toUpperCase() : "?";
}

/** Logo URL to load, or null to draw the placeholder. */
export function phoneAccountLogoUrl(account: PhoneAccount): string | null {
  const logo = account.orgLogo?.trim();
  if (!logo) return null;
  return /^https?:\/\//i.test(logo) ? logo : null;
}
