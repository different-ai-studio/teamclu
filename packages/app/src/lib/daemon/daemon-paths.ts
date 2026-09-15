import { appShortName, resolveAmuxdDirName } from '@/lib/config/build-config'

/** Display path for this build's amuxd home (`~/.amuxd` or `~/.amuxd-<brand>`). */
export function daemonHomeDisplayPathFor(shortName: string): string {
  return `~/.${resolveAmuxdDirName(shortName)}`
}

export function daemonManagedLogDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/logs/amuxd.managed.log`
}

export function daemonPortFileDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/run/amuxd.http.port`
}

export function daemonTeamsDisplayPathFor(shortName: string): string {
  return `${daemonHomeDisplayPathFor(shortName)}/teams/`
}

export const daemonHomeDisplayPath = daemonHomeDisplayPathFor(appShortName)
export const daemonManagedLogDisplayPath = daemonManagedLogDisplayPathFor(appShortName)
export const daemonPortFileDisplayPath = daemonPortFileDisplayPathFor(appShortName)
export const daemonTeamsDisplayPath = daemonTeamsDisplayPathFor(appShortName)
