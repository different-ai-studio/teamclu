import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * What the user said they are here to do on the pre-login choice screen.
 * Mirrors iOS `OnboardingIntent` (#1589).
 *
 *  - `join`   — their team already uses the app. A signed-in account with no
 *               team is NOT given a fresh one; it lands on the no-team screen
 *               (pending invites / paste an invite / switch account / create).
 *  - `create` — they are starting a team. No team → today's create path.
 *
 * Absent for users who never saw the choice screen (installs before it
 * shipped); they keep the old behaviour, same as `create`.
 */
export type OnboardingIntent = "join" | "create";

export function parseOnboardingIntent(raw: unknown): OnboardingIntent | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "join" || value === "create" ? value : null;
}

/** Same key as iOS so the concept reads the same across clients. */
const INTENT_KEY = "teamclu.onboardingIntent";

/**
 * Set once the intro cards have been seen — or once the user has ever reached
 * the app, so people upgrading from a build without the intro skip it.
 */
const HAS_SEEN_INTRO_KEY = "teamclu.hasSeenIntro";

type Storage = Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;

/**
 * Persisted until the user lands in a team, so a joiner who relaunches before
 * their invite arrives still isn't handed a fresh team.
 *
 * Every method swallows its errors: a lost preference costs a tap, a throw
 * here would break launch.
 */
export type OnboardingIntentStore = {
  load: () => Promise<OnboardingIntent | null>;
  save: (intent: OnboardingIntent) => Promise<void>;
  clear: () => Promise<void>;
};

export function createOnboardingIntentStore(
  storage: Storage = AsyncStorage,
): OnboardingIntentStore {
  return {
    async load() {
      try {
        return parseOnboardingIntent(await storage.getItem(INTENT_KEY));
      } catch {
        return null;
      }
    },
    async save(intent) {
      try {
        await storage.setItem(INTENT_KEY, intent);
      } catch {
        // best-effort
      }
    },
    async clear() {
      try {
        await storage.removeItem(INTENT_KEY);
      } catch {
        // best-effort
      }
    },
  };
}

export type IntroFlagStore = {
  hasSeen: () => Promise<boolean>;
  markSeen: () => Promise<void>;
};

export function createIntroFlagStore(storage: Storage = AsyncStorage): IntroFlagStore {
  return {
    async hasSeen() {
      try {
        return (await storage.getItem(HAS_SEEN_INTRO_KEY)) === "1";
      } catch {
        // Unreadable storage: skip the intro rather than show it every launch.
        return true;
      }
    },
    async markSeen() {
      try {
        await storage.setItem(HAS_SEEN_INTRO_KEY, "1");
      } catch {
        // best-effort
      }
    },
  };
}

/** Where a signed-out user starts. Mirrors iOS `WelcomeView.body`. */
export type SignedOutEntry =
  /** Opened an invite link: straight to sign-in; the claim runs after. */
  | "invitedLogin"
  /** First install: the three intro cards, then the choice. */
  | "intro"
  /** Everyone else (after sign-out, a revoked session): the join/create choice. */
  | "choice";

export function resolveSignedOutEntry(args: {
  hasSeenIntro: boolean;
  hasPendingInvite: boolean;
}): SignedOutEntry {
  if (args.hasPendingInvite) return "invitedLogin";
  return args.hasSeenIntro ? "choice" : "intro";
}
