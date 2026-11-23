/**
 * True when a shared env-var / secret write failed because this machine has
 * no usable team secret (the Rust side's wording for a missing or unset key).
 */
export function isTeamSecretMissingError(message: string): boolean {
  return (
    message.includes('not initialized') ||
    message.includes('Missing team encryption key') ||
    message.includes('No team configured') ||
    message.includes('derived_key not set')
  )
}
