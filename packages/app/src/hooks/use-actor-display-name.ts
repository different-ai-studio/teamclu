import * as React from "react";
import { getBackend } from "@/lib/backend";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";
import { loadActorsByIds, upsertActorsBatch } from "@/lib/local-cache";
import { isTauri } from "@/lib/utils";

const actorDisplayNameCache = new Map<string, string>();
const inflightLookups = new Map<string, Promise<string | null>>();

async function lookupActorDisplayName(actorId: string): Promise<string | null> {
  // 1. Memory cache hit — instant
  const cached = actorDisplayNameCache.get(actorId);
  if (cached) return cached;

  const inflight = inflightLookups.get(actorId);
  if (inflight) return inflight;

  const p = (async () => {
    // 2. Local libsql cache hit — fast (Tauri only)
    if (isTauri()) {
      const local = await loadActorsByIds([actorId]);
      if (local.length > 0 && local[0].displayName) {
        actorDisplayNameCache.set(actorId, local[0].displayName);
        return local[0].displayName;
      }
    }

    // 3. Supabase fallback — upsert result into local cache
    const row = await getBackend().actors.getActorDirectoryEntry(actorId);
    if (!row) return null;
    const name = row.display_name ?? null;
    if (name) {
      actorDisplayNameCache.set(actorId, name);
      // Back-fill the local cache so next lookup hits tier 2
      if (isTauri()) {
        void upsertActorsBatch([{
          id: row.id,
          teamId: row.team_id,
          actorType: row.actor_type ?? "member",
          displayName: name,
          avatarUrl: row.avatar_url ?? null,
          memberStatus: row.member_status ?? null,
          agentStatus: row.agent_status ?? null,
          metadataJson: null,
          createdAt: row.created_at ?? new Date().toISOString(),
          updatedAt: row.updated_at ?? new Date().toISOString(),
          deletedAt: null,
          syncedAt: new Date().toISOString(),
        }]).catch((e) => console.warn("[actor-display-name] cache upsert:", e));
      }
    }
    return name;
  })();
  inflightLookups.set(actorId, p);
  try {
    return await p;
  } finally {
    inflightLookups.delete(actorId);
  }
}

export function useActorDisplayName(actorId: string | undefined | null): string {
  const [name, setName] = React.useState<string | null>(() =>
    actorId ? actorDisplayNameCache.get(actorId) ?? null : null,
  );
  React.useEffect(() => {
    if (!actorId || name) return;
    let cancelled = false;
    void lookupActorDisplayName(actorId)
      .then((resolved) => {
        if (!cancelled && resolved) setName(resolved);
      })
      .catch((e) => {
        // Backend unavailable (e.g. cloud API not configured) — keep the
        // fallback display name instead of leaking an unhandled rejection.
        console.warn("[actor-display-name] lookup failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [actorId, name]);
  if (!actorId) return "";
  return name ?? actorId.slice(0, 8);
}

/** Find the current model an agent is using by matching daemonActorId
 * (== actor_id by daemon convention) against runtime-state-store entries.
 * Returns "" when no runtime is known for this actor. */
export function useAgentModelByActor(actorId: string | undefined | null): string {
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId);
  return React.useMemo(() => {
    if (!actorId) return "";
    for (const entry of Object.values(byRuntimeId)) {
      if (entry.daemonActorId === actorId) {
        return entry.info.currentModel ?? "";
      }
    }
    return "";
  }, [actorId, byRuntimeId]);
}
