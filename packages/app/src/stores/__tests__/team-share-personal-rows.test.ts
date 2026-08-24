import { describe, test, expect } from 'vitest'
import { planPersonalRow } from '../team-share-browser'

const row = (over: Partial<Parameters<typeof planPersonalRow>[0]> = {}) =>
  planPersonalRow({
    slug: 'deploy-check',
    source: 'global-claude',
    registryOwnsSlug: false,
    packOnDisk: false,
    ...over,
  })

describe('planPersonalRow', () => {
  test('a skill the registry knows nothing about keeps its own row', () => {
    expect(row()).toEqual({ hidden: false, id: 'deploy-check' })
  })

  test('the team pack itself is hidden — the registry row already shows it', () => {
    expect(
      row({ source: 'global-agent', registryOwnsSlug: true, packOnDisk: true }),
    ).toEqual({ hidden: true, id: 'deploy-check' })
  })

  test('a personal copy elsewhere survives the registry owning the name', () => {
    // The collision case. This file is a different skill, it still loads, and
    // it is the one shadowing the pack — hiding it left the member with no way
    // to see that two skills answer to this name.
    expect(row({ source: 'global-claude', registryOwnsSlug: true, packOnDisk: true })).toEqual({
      hidden: false,
      id: 'personal:deploy-check',
    })
  })

  test('publishing a name does not hide a teammate’s skill they never installed', () => {
    // No pack on disk: they only share a name with something in the registry.
    expect(row({ registryOwnsSlug: true, packOnDisk: false })).toEqual({
      hidden: false,
      id: 'personal:deploy-check',
    })
  })

  test('a pack root row with no registry entry is still shown', () => {
    // Left over after the registry row disappeared (deleted skill, team switch).
    // Hiding it would make a directory that exists unreachable from the UI.
    expect(row({ source: 'global-agent', packOnDisk: true })).toEqual({
      hidden: false,
      id: 'deploy-check',
    })
  })

  test('builtin copies are not personal skills', () => {
    expect(row({ source: 'builtin' }).hidden).toBe(true)
  })
})
