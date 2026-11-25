/** GoTrue stores passwords with bcrypt, which only uses the first 72 bytes. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export type NewPasswordIssue = "empty" | "too_short" | "too_long" | "mismatch";

/**
 * Local check before a set-or-change request. The signed-in session is the
 * proof of identity, so this does not ask for the current password.
 */
export function validateNewPassword(password: string, confirm: string): NewPasswordIssue | null {
  if (password.length === 0 || confirm.length === 0) return "empty";
  if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  if (password !== confirm) return "mismatch";
  return null;
}
