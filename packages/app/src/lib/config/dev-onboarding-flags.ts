/** Dev-only flags injected by `scripts/tauri-cli.js` during `pnpm tauri:dev`.
 *  (`--skip-setup` is still accepted by the script but has nothing left to
 *  skip since #1250: the runtime install lives in the daemon wizard.) */
export function devSkipDaemonOnboarding(): boolean {
  return import.meta.env.VITE_TEAMCLU_SKIP_DAEMON_ONBOARDING === 'true'
}
