/**
 * Skills management — poster copy.
 *
 * The claim is 06 §0 verbatim in spirit: "skill 不是「给 agent 的提示词片段」，
 * 而是「团队可以拥有、版本化、审计的资产」".
 *
 * Every mechanism below is traceable:
 *   6 required fields, `when_not_to_use` decisive      06 §4
 *   append-only versions, changelog required           06 §3.1
 *   10-minute background reconcile, no update button   06 §6.1
 *   dirty edits become conflicts, never silent loss    06 §6.4
 *   no per-member visibility isolation                 06 §1.3
 *   any member may publish; owner is responsibility    06 §3.3
 *
 * Deliberately absent: Roles, the ClawHub marketplace, the permission panel.
 * 06 §9 says a role is "一组 skill 的命名组合" and follows the skill mechanism, so
 * it is not a pillar of its own.
 *
 * Card budget: 8 wrapped body lines each. The AUTO-FOLLOW card was 10 in the
 * first draft and overran the card; re-run the build after editing copy.
 */
export default {
  slug: 'skills-management',
  eyebrow: 'SKILLS MANAGEMENT',
  claim1: 'A skill is not a prompt fragment.',
  claim2: 'It is a team asset you can own, version, and audit.',
  sub: 'The TeamClu skills registry \u2014 and the four mechanisms that make that true.',
  cards: [
    {
      label: 'PUBLISH GATE',
      title: 'Six required fields',
      // Segment arrays so the decisive field is marked on its own token.
      lead: [
        [{ t: 'owner' }, { t: 'summary' }, { t: 'category' }],
        [{ t: 'when_to_use' }, { t: 'when_not_to_use', hi: true }],
        [{ t: 'changelog' }],
      ],
      note: 'when_not_to_use is the one that matters. Overlapping skills can only sit side by side if their boundaries are written down.',
    },
    {
      label: 'VERSION HISTORY',
      title: 'Append-only',
      body: [
        'Every release requires a changelog.',
        'Old content is never edited in place. Revert re-publishes it as latest + 1.',
        'So \u201cwho changed what\u201d has a record, not a memory.',
      ],
    },
    {
      label: 'AUTO-FOLLOW',
      title: 'No update button',
      body: [
        'Installed skills track latest_version on a 10-minute background reconcile.',
        'No button to click. No \u201cplease update your skill\u201d messages.',
        'The interval is deliberate: skills ship as zips, so a lazy refresh would tax every agent start.',
      ],
    },
    {
      label: 'CONFLICTS',
      title: 'No silent overwrites',
      body: [
        'A local edit is never silently overwritten by the automatic follow.',
        'It becomes a conflict for a human to resolve.',
        'Automatic follow without this would just be data loss.',
      ],
    },
  ],
  notBuilt: [
    'Per-member skill visibility. One key per team, shared by all members \u2014 it protects against the cloud',
    'provider, not against colleagues. And any team member can publish: owner is responsibility, not permission.',
  ],
  site: 'teamclu.ai',
};
