import { appShortName, resolveAmuxdDirName } from '@/lib/config/build-config'

/** Display path for this build's amuxd home (`~/.amuxd` or `~/.amuxd-<brand>`). */
export function daemonHomeDisplayPathFor(shortName: string): string {
  return `~/.${resolveAmuxdDirName(shortName)}`
}

export function daemonManagedLogDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/logs/amuxd.managed.log`
}

/** `amuxd install-pi` keeps every run's narration here (see `install_log.rs`). */
export function installPiLogDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/logs/install-pi.log`
}

export function daemonPortFileDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/run/amuxd.http.port`
}

export function daemonTeamsDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/teams/`
}

export const daemonHomeDisplayPath = daemonHomeDisplayPathFor(appShortName)
export const daemonManagedLogDisplayPath = daemonManagedLogDisplayPathFor(appShortName)
export const installPiLogDisplayPath = installPiLogDisplayPathFor(appShortName)
export const daemonPortFileDisplayPath = daemonPortFileDisplayPathFor(appShortName)
export const daemonTeamsDisplayPath = daemonTeamsDisplayPathFor(appShortName)
