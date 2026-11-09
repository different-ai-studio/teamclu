import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { getSession } from "@/lib/auth/session-store";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentTeamStore, writeCachedCurrentTeam, type CurrentTeam } from "@/stores/current-team";

/**
 * Support mode: a platform operator acting inside a customer org as that org's
 * shared support account ("TeamClu 支持").
 * docs/plans/2026-11-08-platform-operator-support-access.md.
 *
 * Entering swaps the signed-in session for one of the support account, minted
 * by the Cloud API for this entry only and refreshable until `expiresAt`. The
 * operator's own refresh token is kept here, on this machine, because nothing
 * on the server turns a support session back into the operator's — holding a
 * support session must never amount to holding operator rights. Leaving ends
 * the support session on the server and adopts the kept token again.
 *
 * While in support mode:
 * - teams are entered without activation (the support JWT already carries the
 *   org, and the server refuses to mint the support account other sessions);
 * - the local daemon is left alone — this machine must not become a device of
 *   the customer's org;
 * - signing out leaves support mode instead. A real sign-out of the shared
 *   account could end every operator's session in that org.
 *
 * Stored in localStorage next to the session itself (same trust level), so a
 * relaunch mid-session comes back in support mode and can still leave it.
 */

const STORAGE_KEY = "teamclu:support-session.v1";

export interface SupportSessionRecord {
  supportUserId: string;
  orgId: string;
  orgName: string | null;
  team: CurrentTeam;
  expiresAt: string;
  operator: {
    userId: string;
    refreshToken: string;
    /** The team the operator was in, to return to. */
    team: CurrentTeam | null;
  };
}

function readRecord(): SupportSessionRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as SupportSessionRecord;
    if (!r?.supportUserId || !r.operator?.refreshToken || !r.operator.userId || !r.team?.id) return null;
    return r;
  } catch {
    return null;
  }
}

function writeRecord(record: SupportSessionRecord | null): void {
  try {
    if (record) localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / no storage: support mode still works for this run.
  }
}

interface SupportSessionState {
  record: SupportSessionRecord | null;
  busy: boolean;
  error: string | null;
}

export const useSupportSessionStore = create<SupportSessionState>(() => ({
  record: readRecord(),
  busy: false,
  error: null,
}));

function setRecord(record: SupportSessionRecord | null): void {
  writeRecord(record);
  useSupportSessionStore.setState({ record });
}

function signedInUserId(): string | null {
  return useAuthStore.getState().session?.user?.id ?? null;
}

/** True when the signed-in account is the support account of the kept record. */
export function isInSupportSession(userId: string | null = signedInUserId()): boolean {
  const record = useSupportSessionStore.getState().record;
  return !!record && !!userId && record.supportUserId === userId;
}

export function useInSupportSession(): SupportSessionRecord | null {
  const record = useSupportSessionStore((s) => s.record);
  const userId = useAuthStore((s) => s.session?.user?.id ?? null);
  return record && userId && record.supportUserId === userId ? record : null;
}

export async function enterSupportSession(input: {
  orgId: string;
  orgName: string | null;
  team: CurrentTeam;
  reason: string;
}): Promise<void> {
  if (useSupportSessionStore.getState().busy) return;
  const own = getSession();
  const operatorUserId = signedInUserId();
  if (!own?.refresh_token || !operatorUserId) throw new Error("not signed in");
  if (isInSupportSession(operatorUserId)) throw new Error("already in support mode");

  useSupportSessionStore.setState({ busy: true, error: null });
  try {
    const grant = await getBackend().admin.startSupportSession(input.orgId, {
      teamId: input.team.id,
      reason: input.reason,
    });
    setRecord({
      supportUserId: grant.supportUserId,
      orgId: grant.orgId,
      orgName: input.orgName,
      team: input.team,
      expiresAt: grant.expiresAt,
      operator: {
        userId: operatorUserId,
        refreshToken: own.refresh_token,
        team: useCurrentTeamStore.getState().team,
      },
    });
    // AuthGate restores the "last used" team of whoever signs in next; point it
    // at the target so the swap lands in that team rather than a picker.
    writeCachedCurrentTeam({ team: input.team, currentMember: null, teamUserId: grant.supportUserId });
    try {
      await getBackend().auth.adoptSession(grant.refreshToken);
    } catch (error) {
      // Still the operator: forget the record and end the unused grant later
      // (it expires on its own; there is no session to call it with).
      setRecord(null);
      throw error;
    }
  } catch (error) {
    useSupportSessionStore.setState({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    useSupportSessionStore.setState({ busy: false });
  }
}

/**
 * Leave support mode and become the operator again. Safe to call when the
 * support session is already gone (expired, revoked): the server call is
 * best-effort, the kept token is what matters. If the kept token no longer
 * works either, the operator is signed out and signs in again.
 */
export async function exitSupportSession(): Promise<void> {
  const record = useSupportSessionStore.getState().record;
  if (!record || useSupportSessionStore.getState().busy) return;
  useSupportSessionStore.setState({ busy: true, error: null });
  try {
    if (isInSupportSession()) {
      try {
        await getBackend().admin.endCurrentSupportSession();
      } catch (error) {
        console.warn("[support] ending the support session failed; it expires on its own", error);
      }
    }
    if (record.operator.team) {
      writeCachedCurrentTeam({ team: record.operator.team, currentMember: null, teamUserId: record.operator.userId });
    }
    setRecord(null);
    try {
      await getBackend().auth.adoptSession(record.operator.refreshToken);
    } catch (error) {
      console.warn("[support] the operator's own session could not be restored; signing out", error);
      await useAuthStore.getState().signOut("support_exit_restore_failed");
    }
  } finally {
    useSupportSessionStore.setState({ busy: false });
  }
}

/** Drop the kept record without touching sessions (the operator signed out). */
export function forgetSupportSession(): void {
  setRecord(null);
}

export function resetSupportSessionForTests(): void {
  writeRecord(null);
  useSupportSessionStore.setState({ record: null, busy: false, error: null });
}
