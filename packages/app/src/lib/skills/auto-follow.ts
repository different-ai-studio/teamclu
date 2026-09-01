/**
 * Auto-follow: installed team skills track `latestVersion` without anyone
 * clicking update.
 *
 * Design: docs/architecture/team-skills-registry.md §8.2.
 *
 * The reconcile is a full diff of desired-state against disk, not an
 * incremental apply. Notifications get lost, the app is closed when a version
 * ships, a second machine has never heard of an install at all — anything that
 * only processes deltas drifts, and drift in this direction means an agent
 * quietly running a version of a team procedure that the team retired.
 * Recomputing the whole set every tick costs a few `stat` calls and cannot
 * drift by construction.
 */

/** What `team_skill_inspect` reports about one pack on disk. */
export interface SkillLocalState {
  slug: string
  /** Which runtime projection was inspected for this slug. */
  source: 'hosted-agent' | 'member'
  /**
   * `foreign` means the directory carries another registry's `origin.json`.
   * Slugs collide across registries because they all install into the same
   * root, and a collision is not a licence to take somebody else's pack over.
   *
   * `missing` covers both "no directory" and "a directory with no team record"
   * — a skill the user wrote straight into the skills root, say. Installing is
   * what resolves it, and installing overwrites the files the package ships.
   */
  state: 'missing' | 'clean' | 'dirty' | 'stale_dirty' | 'foreign'
  installedVersion: string | null
  modified: string[]
  deleted: string[]
  /**
   * Files in the pack directory that the install never put there — something
   * dropped in by hand, or written by the skill's own script.
   *
   * Dirt in its own right: publishing measures the whole directory, so these
   * ship with the next version whether or not anyone meant them to. The cost of
   * reporting them is that a pack whose script writes beside itself stays in
   * the conflict UI until the user publishes or discards.
   */
  added: string[]
}

/** One pack as `team_skill_list_installed` found it. */
export interface OnDiskSkill {
  slug: string
  version: string | null
  /** `null` for packs installed before the team was recorded on disk. */
  teamId: string | null
}

export interface ReconcilePlan {
  /** Download and lay down (fresh install or version bump). */
  install: Array<{ slug: string; version: number }>
  /** On disk but no longer in the desired set. */
  remove: string[]
  /** Held back — the conflict UI or another registry owns this one now. */
  blocked: string[]
}

export interface DesiredSkill {
  slug: string
  latestVersion: number | null
  installed: boolean
  /** The version the server believes this actor is on. */
  installedVersion: number | null
}

export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000

/**
 * Work out what has to change. Pure — the caller performs the effects, which is
 * what makes the interesting cases (a dirty pack, a version that moved while
 * the app was closed) testable without a filesystem.
 *
 * `blocked` wins over everything, including removal: a member who edited a pack
 * that an admin then un-shared should be asked, not silently stripped of work
 * they did.
 *
 * Removal additionally requires the pack to carry *this* team's id. One flat
 * directory serves every team the user belongs to, so without that check,
 * switching teams makes the other team's packs look like leftovers and deletes
 * them — and packs installed before the id was recorded are never removable at
 * all, because "I cannot tell whose this is" is not evidence that it is mine.
 *
 * `alsoWanted` names slugs some *other* ledger still asks for, and only ever
 * holds removal back. Auto-follow reads the Agent's desired set, while installs
 * recorded before that was true sit on the member's — so for as long as both
 * ledgers exist, a pack missing from the Agent's set is not evidence that
 * anybody stopped wanting it. Planning removal off the Agent's set alone would
 * empty a machine's team packs on the first tick after the switch.
 */
/**
 * Packs on disk whose registry row is gone *entirely* — the team deleted the
 * skill.
 *
 * Deliberately not the same question as `plan.remove`, which also fires for the
 * ordinary case of a skill that is still in the registry and that this member
 * simply uninstalled. That one the member did themselves and needs no telling;
 * this one happened on somebody else's machine, and without it their skill just
 * silently stops existing.
 *
 * `desired` here must be the *whole* registry listing, installed rows and not —
 * filtering to installed first would report every uninstalled skill as deleted.
 *
 * Packs belonging to another team, and packs with no team recorded at all, are
 * excluded: neither can be attributed to this team's deletion, and `planReconcile`
 * already refuses to remove them.
 */
export function retiredSlugs(
  desired: DesiredSkill[],
  onDisk: OnDiskSkill[],
  teamId: string,
): string[] {
  const inRegistry = new Set(desired.map((s) => s.slug))
  return onDisk
    .filter((pack) => pack.teamId === teamId && !inRegistry.has(pack.slug))
    .map((pack) => pack.slug)
}

export function planReconcile(
  desired: DesiredSkill[],
  onDisk: OnDiskSkill[],
  blocked: ReadonlySet<string>,
  teamId: string,
  alsoWanted: ReadonlySet<string> = new Set(),
): ReconcilePlan {
  const bySlug = new Map(onDisk.map((p) => [p.slug, p]))
  const plan: ReconcilePlan = { install: [], remove: [], blocked: [] }
  const wanted = new Set<string>(alsoWanted)

  for (const skill of desired) {
    if (!skill.installed) continue
    wanted.add(skill.slug)

    if (blocked.has(skill.slug)) {
      plan.blocked.push(skill.slug)
      continue
    }

    const version = skill.latestVersion ?? 1
    const current = bySlug.get(skill.slug)?.version
    // A pack whose version we cannot read is treated as needing install: the
    // cost is one redundant download, and the alternative is leaving unknown
    // content in place forever.
    if (current == null || Number(current) !== version) {
      plan.install.push({ slug: skill.slug, version })
    }
  }

  for (const pack of onDisk) {
    if (wanted.has(pack.slug)) continue
    if (blocked.has(pack.slug)) {
      plan.blocked.push(pack.slug)
      continue
    }
    if (pack.teamId !== teamId) continue
    plan.remove.push(pack.slug)
  }

  return plan
}

/**
 * Which install records still name a version the pack has moved past.
 *
 * Nothing else advances the server's `installed_version` under auto-follow —
 * the whole point is that the user never clicks install again. Left unwritten,
 * the registry keeps reporting the version somebody last installed by hand, so
 * `hasUpdate` stays true forever and the UI shows a permanent "updating to
 * v3…" for a pack that has been on v3 for a week.
 *
 * **Only converged packs are reported**, and that restriction is what keeps the
 * record stable. The install row is keyed per actor, not per device, so both of
 * a member's machines write to the same row every tick. If a laptop held back
 * at v1 by a local edit also reported, the two would overwrite each other
 * forever and `hasUpdate` would flicker on both. Reporting only "this pack
 * reached the version the team is on" makes every device that gets there write
 * the same value, and a device that has not gets out of the way.
 *
 * Derived from disk rather than from "what did this tick just install", so a
 * write that fails offline is retried next tick instead of being lost the
 * moment the disk is already correct.
 */
export function planVersionWriteback(
  desired: DesiredSkill[],
  onDisk: OnDiskSkill[],
): Array<{ slug: string; version: number }> {
  const bySlug = new Map(onDisk.map((p) => [p.slug, p]))
  const out: Array<{ slug: string; version: number }> = []

  for (const skill of desired) {
    if (!skill.installed) continue
    const raw = bySlug.get(skill.slug)?.version
    if (raw == null) continue
    const version = Number(raw)
    // An unparseable version is not evidence of anything; the install path
    // already treats it as "reinstall", and guessing here would write a wrong
    // number into the record every other tick.
    if (!Number.isFinite(version)) continue
    if (version !== (skill.latestVersion ?? 1)) continue
    if (skill.installedVersion === version) continue
    out.push({ slug: skill.slug, version })
  }

  return out
}
