import { describe, test, expect } from 'vitest'
import {
  planReconcile,
  planVersionWriteback,
  retiredSlugs,
  type DesiredSkill,
  type OnDiskSkill,
} from '../auto-follow'

const TEAM = 'team-a'

const skill = (over: Partial<DesiredSkill> & { slug: string }): DesiredSkill => ({
  latestVersion: 1,
  installed: true,
  installedVersion: null,
  ...over,
})

const pack = (slug: string, version: string | null, teamId: string | null = TEAM): OnDiskSkill => ({
  slug,
  version,
  teamId,
})

describe('planReconcile', () => {
  test('installs what the server says is installed but disk has never seen', () => {
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', latestVersion: 3 })],
      [],
      new Set(),
      TEAM,
    )
    expect(plan.install).toEqual([{ slug: 'deploy-check', version: 3 }])
    expect(plan.remove).toEqual([])
  })

  test('follows a version bump without anyone asking', () => {
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', latestVersion: 4 })],
      [pack('deploy-check', '3')],
      new Set(),
      TEAM,
    )
    expect(plan.install).toEqual([{ slug: 'deploy-check', version: 4 }])
  })

  test('does nothing when disk already matches', () => {
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', latestVersion: 4 })],
      [pack('deploy-check', '4')],
      new Set(),
      TEAM,
    )
    expect(plan).toEqual({ install: [], remove: [], blocked: [] })
  })

  test('removes a pack the server no longer lists as installed', () => {
    // The uninstall happened on another machine. Without this the second
    // machine keeps feeding the agent a skill the user already dropped.
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', installed: false, latestVersion: 4 })],
      [pack('deploy-check', '4')],
      new Set(),
      TEAM,
    )
    expect(plan.remove).toEqual(['deploy-check'])
    expect(plan.install).toEqual([])
  })

  test('holds removal back for a pack the other ledger still wants', () => {
    // Auto-follow reads the Agent's desired set, but installs recorded before
    // that was true sit on the member's. A pack missing from the Agent's set is
    // therefore not evidence anybody stopped wanting it — planning removal off
    // the Agent's set alone emptied a machine's team packs on the first tick
    // after the switch.
    const plan = planReconcile(
      [],
      [pack('deploy-check', '4')],
      new Set(),
      TEAM,
      new Set(['deploy-check']),
    )
    expect(plan.remove).toEqual([])
  })

  test('still removes a pack neither ledger asks for', () => {
    const plan = planReconcile(
      [],
      [pack('deploy-check', '4')],
      new Set(),
      TEAM,
      new Set(['something-else']),
    )
    expect(plan.remove).toEqual(['deploy-check'])
  })

  test('the other ledger holds removal back without ever forcing an install', () => {
    // `alsoWanted` is a removal veto, not a desired set: a slug only the member
    // still wants must not start being downloaded onto the Agent's disk.
    const plan = planReconcile([], [], new Set(), TEAM, new Set(['deploy-check']))
    expect(plan.install).toEqual([])
  })

  test('never removes another team’s pack', () => {
    // One flat directory serves every team the user belongs to. Reconciling for
    // team B must not read team A's packs as leftovers — that turned every team
    // switch into a delete-and-redownload, taking anything the user had added
    // inside those directories with it.
    const plan = planReconcile([], [pack('deploy-check', '4', 'team-b')], new Set(), TEAM)
    expect(plan.remove).toEqual([])
  })

  test('never removes a pack whose team is unrecorded', () => {
    // Installed before the team id existed on disk. "I cannot tell whose this
    // is" is not evidence that it is mine to delete.
    const plan = planReconcile([], [pack('deploy-check', '4', null)], new Set(), TEAM)
    expect(plan.remove).toEqual([])
  })

  test('a locally edited pack is blocked, not upgraded', () => {
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', latestVersion: 4 })],
      [pack('deploy-check', '3')],
      new Set(['deploy-check']),
      TEAM,
    )
    expect(plan.install).toEqual([])
    expect(plan.blocked).toEqual(['deploy-check'])
  })

  test('a locally edited pack is not removed either', () => {
    // Someone un-shared a skill the user had been editing. Deleting their work
    // to carry out a decision they were not part of is the one outcome that
    // cannot be undone, so this stops and asks too.
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', installed: false, latestVersion: 4 })],
      [pack('deploy-check', '4')],
      new Set(['deploy-check']),
      TEAM,
    )
    expect(plan.remove).toEqual([])
    expect(plan.blocked).toEqual(['deploy-check'])
  })

  test('an unreadable on-disk version is reinstalled rather than trusted', () => {
    const plan = planReconcile(
      [skill({ slug: 'deploy-check', latestVersion: 2 })],
      [pack('deploy-check', null)],
      new Set(),
      TEAM,
    )
    expect(plan.install).toEqual([{ slug: 'deploy-check', version: 2 }])
  })

  test('registry rows the caller never installed are left alone', () => {
    const plan = planReconcile(
      [
        skill({ slug: 'deploy-check', installed: true, latestVersion: 1 }),
        skill({ slug: 'triage', installed: false, latestVersion: 9 }),
      ],
      [pack('deploy-check', '1')],
      new Set(),
      TEAM,
    )
    expect(plan).toEqual({ install: [], remove: [], blocked: [] })
  })
})

describe('planVersionWriteback', () => {
  test('reports the version auto-follow moved the pack to', () => {
    // Nothing else advances the record. Without this the registry keeps saying
    // v1, hasUpdate never goes false, and the UI shows "updating to v3…"
    // forever for a pack that is already on v3.
    const out = planVersionWriteback(
      [skill({ slug: 'deploy-check', latestVersion: 3, installedVersion: 1 })],
      [pack('deploy-check', '3')],
    )
    expect(out).toEqual([{ slug: 'deploy-check', version: 3 }])
  })

  test('says nothing when the record already agrees with disk', () => {
    const out = planVersionWriteback(
      [skill({ slug: 'deploy-check', latestVersion: 3, installedVersion: 3 })],
      [pack('deploy-check', '3')],
    )
    expect(out).toEqual([])
  })

  test('stays silent about a pack that has not converged', () => {
    // The install row is per actor, not per device. A laptop held at v1 by a
    // local edit and a desktop already on v3 write to the same row, so if the
    // laptop reported too they would overwrite each other every tick and
    // hasUpdate would flicker on both machines forever.
    const out = planVersionWriteback(
      [skill({ slug: 'deploy-check', latestVersion: 3, installedVersion: 3 })],
      [pack('deploy-check', '1')],
    )
    expect(out).toEqual([])
  })

  test('ignores packs that are not on this disk', () => {
    // A second machine that has never installed it must not claim to have.
    const out = planVersionWriteback(
      [skill({ slug: 'deploy-check', latestVersion: 3, installedVersion: 1 })],
      [],
    )
    expect(out).toEqual([])
  })

  test('ignores an unreadable on-disk version rather than guessing', () => {
    const out = planVersionWriteback(
      [skill({ slug: 'deploy-check', latestVersion: 3, installedVersion: 1 })],
      [pack('deploy-check', 'not-a-number')],
    )
    expect(out).toEqual([])
  })

  test('leaves rows the caller never installed alone', () => {
    const out = planVersionWriteback(
      [skill({ slug: 'triage', installed: false, latestVersion: 9, installedVersion: null })],
      [pack('triage', '9')],
    )
    expect(out).toEqual([])
  })
})

describe('retiredSlugs', () => {
  test('a pack whose registry row is gone is a deletion', () => {
    expect(retiredSlugs([], [pack('deploy-check', '3')], TEAM)).toEqual(['deploy-check'])
  })

  test('an uninstalled skill is not a deletion — the row is still there', () => {
    // The distinction the whole notice rests on. Both end up in `plan.remove`,
    // but only one of them happened on somebody else's machine.
    expect(
      retiredSlugs(
        [skill({ slug: 'deploy-check', installed: false })],
        [pack('deploy-check', '3')],
        TEAM,
      ),
    ).toEqual([])
  })

  test('a skill still installed is obviously not a deletion', () => {
    expect(
      retiredSlugs([skill({ slug: 'deploy-check' })], [pack('deploy-check', '1')], TEAM),
    ).toEqual([])
  })

  test('another team\'s pack, and an unattributed one, are never reported', () => {
    // Same rule `planReconcile` removal follows: neither can be blamed on this
    // team deleting anything, and neither is ours to touch.
    expect(
      retiredSlugs(
        [],
        [pack('theirs', '1', 'team-b'), pack('ancient', '1', null)],
        TEAM,
      ),
    ).toEqual([])
  })

  test('nothing on disk, nothing to report', () => {
    expect(retiredSlugs([skill({ slug: 'deploy-check' })], [], TEAM)).toEqual([])
  })
})
