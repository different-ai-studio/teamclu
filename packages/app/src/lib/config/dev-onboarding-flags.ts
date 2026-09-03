/** Dev-only flags injected by `scripts/tauri-cli.js` during `pnpm tauri:dev`. */
export function devSkipSetup(): boolean {
  return import.meta.env.VITE_TEAMCLU_SKIP_SETUP === 'true'
}

export function devSkipDaemonOnboarding(): boolean {
  return import.meta.env.VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING === 'true'
}
