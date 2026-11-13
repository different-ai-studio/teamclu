/**
 * Sessions — one conversation your teammates and your agents share.
 *
 * The claim is 03 §0: the atom of a chat app is the MESSAGE (and a message is
 * private); the atom of TeamClu is the SESSION. A session carries participants,
 * permissions, a bound agent, a workspace, an origin and a lifecycle — which is
 * why so much of the product looks heavy, and why the heavy parts are necessary.
 *
 * Sources:
 *   session is the unit, message is private                 03 §0
 *   agent is a participant, not a service                   03 §2.2
 *   agent replies are notes, not bubbles                    03 §3.2
 *   only agent replies may fork a thread                    03 §6.1
 *   the fork is lazy: no backend cost until you send        03 §6.2
 *   a thread is its own cloud session, hidden from the list 03 §6.1
 *   @mention is not permission                              03 §7.3
 *   presence is per-actor, not per-session                  03 §7.2
 *
 * Deliberately absent: session origins (manual / scheduled / gateway) as a
 * feature list, and the stale-participant-cache bug in 03 §7.1 — that one is a
 * real defect, tracked in AGENTS.md §8 as future work, and it does not belong on
 * a marketing surface.
 */
export default {
  slug: 'sessions',
  eyebrow: 'SESSIONS \u00b7 PEOPLE + AGENTS',
  claim1: 'The atom of a chat app is a message.',
  claim2: 'The atom of TeamClu is the session.',
  sub: 'One conversation your teammates and your agents share \u2014 and the review surface to match.',
  cards: [
    {
      label: 'THE UNIT',
      title: 'A group, not N DMs',
      body: [
        'A session has participants, permissions, a bound agent, a workspace and a lifecycle.',
        'A message only has content. That is why so much of this looks heavy \u2014 and why the heavy parts are needed.',
      ],
    },
    {
      label: 'AGENTS',
      // Titles are capped at ~19 chars so all four sit at 27pt; the full
      // "participant, not a service" contrast lives in the body.
      title: 'A participant',
      body: [
        'An agent in a session can be offline.',
        'It can be permission-limited, and switched to another model mid-conversation.',
        'It is not something the session calls. It is someone in the thread.',
      ],
    },
    {
      label: 'REPLY FORM',
      title: 'Notes, not bubbles',
      body: [
        // "sized to its content" is 03 §3.2's own phrasing (气泡的宽度由内容决定),
        // and it sets up the "full width" contrast in the next paragraph. The
        // earlier wording left "turn." alone on its own line.
        'A human message is a bubble, sized to its content. One voice, one turn.',
        'An agent reply is a note \u2014 full width, structured, with follow-ups you can act on, because it is usually something you will reference later.',
      ],
    },
    {
      label: 'THREADS',
      title: 'Only replies fork',
      body: [
        'Only an agent reply can open a thread, and a thread is a new session hidden from the main list.',
        'If any message could fork, the tree would grow into a thicket. And opening one costs nothing until you send.',
      ],
    },
  ],
  notBuilt: [
    'Mentioning someone does not add them to the session \u2014 it means \u201cthis message is for them\u201d. And presence is per-actor,',
    'not per-session: the same person reads as online in every session at once, because that is the level it is tracked at.',
  ],
  site: 'teamclu.ai',
};
